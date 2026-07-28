import { v } from "convex/values";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const MAX_OBSERVATIONS_PER_WORKSPACE = 1_000;
const MAX_DELIVERIES_PER_OBSERVATION = 20;
const MAX_REFILL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const deliveryPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const digestPattern = /^[0-9a-f]{64}$/;
const commentIdPattern = /^\d{1,30}$/;

const nullableNumber = v.union(v.number(), v.null());
const providerState = v.union(v.literal("available"), v.literal("unavailable"));

export const ingestCodeRabbit = mutation({
  args: {
    ...serviceArgs,
    deliveryId: v.string(),
    payloadDigest: v.string(),
    sourceCommentId: v.string(),
    repository: v.string(),
    pullRequestNumber: v.number(),
    subjectLogin: v.string(),
    providerState,
    remaining: nullableNumber,
    quotaLimit: nullableNumber,
    refillAt: nullableNumber,
    observedAt: v.number(),
    receivedAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = normalizeWorkspace(args.workspace);
    const workspaceDocument = await findWorkspace(ctx, workspace);
    if (!workspaceDocument) throw new Error("PROVIDER_CAPACITY_WORKSPACE_NOT_FOUND");
    const input = validateInput(args);

    const existingDelivery = await ctx.db
      .query("providerCapacityDeliveries")
      .withIndex("by_workspace_delivery", (q) =>
        q.eq("workspaceId", workspaceDocument._id)
          .eq("provider", "coderabbit")
          .eq("deliveryId", input.deliveryId),
      )
      .unique();
    if (existingDelivery) {
      if (existingDelivery.payloadDigest !== input.payloadDigest) {
        throw new Error("PROVIDER_CAPACITY_DELIVERY_CONFLICT");
      }
      const observation = await ctx.db.get(
        "providerCapacityObservations",
        existingDelivery.observationId,
      );
      if (!observation) throw new Error("PROVIDER_CAPACITY_OBSERVATION_MISSING");
      return { duplicate: true, observation: publicObservation(observation) };
    }

    const existingPayload = await ctx.db
      .query("providerCapacityObservations")
      .withIndex("by_workspace_payload", (q) =>
        q.eq("workspaceId", workspaceDocument._id)
          .eq("provider", "coderabbit")
          .eq("payloadDigest", input.payloadDigest),
      )
      .unique();
    if (existingPayload) {
      await reserveDelivery(
        ctx,
        workspaceDocument._id,
        input.deliveryId,
        input.payloadDigest,
        existingPayload._id,
        input.receivedAt,
      );
      return { duplicate: true, observation: publicObservation(existingPayload) };
    }

    await makeCapacity(ctx, workspaceDocument._id);
    const observationId = await ctx.db.insert("providerCapacityObservations", {
      workspaceId: workspaceDocument._id,
      provider: "coderabbit",
      payloadDigest: input.payloadDigest,
      sourceCommentId: input.sourceCommentId,
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      subjectLogin: input.subjectLogin,
      subjectBasis: "pull_request_author_proxy",
      providerState: input.providerState,
      remaining: input.remaining,
      quotaLimit: input.quotaLimit,
      refillAt: input.refillAt,
      observedAt: input.observedAt,
      receivedAt: input.receivedAt,
    });
    await reserveDelivery(
      ctx,
      workspaceDocument._id,
      input.deliveryId,
      input.payloadDigest,
      observationId,
      input.receivedAt,
    );
    const observation = await ctx.db.get("providerCapacityObservations", observationId);
    if (!observation) throw new Error("PROVIDER_CAPACITY_OBSERVATION_MISSING");
    return { duplicate: false, observation: publicObservation(observation) };
  },
});

export const latestCodeRabbit = query({
  args: {
    ...serviceArgs,
    repository: v.string(),
    subjectLogin: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = normalizeWorkspace(args.workspace);
    const workspaceDocument = await findWorkspace(ctx, workspace);
    if (!workspaceDocument) return null;
    const repository = boundedText(args.repository, "Repository", 200, repositoryPattern);
    const subjectLogin = boundedText(args.subjectLogin, "Subject login", 120, loginPattern);
    const rows = await ctx.db
      .query("providerCapacityObservations")
      .withIndex("by_workspace_subject_observed", (q) =>
        q.eq("workspaceId", workspaceDocument._id)
          .eq("provider", "coderabbit")
          .eq("repository", repository)
          .eq("subjectLogin", subjectLogin),
      )
      .order("desc")
      .take(1);
    return rows[0] ? publicObservation(rows[0]) : null;
  },
});

function validateInput(args: {
  deliveryId: string;
  payloadDigest: string;
  sourceCommentId: string;
  repository: string;
  pullRequestNumber: number;
  subjectLogin: string;
  providerState: "available" | "unavailable";
  remaining: number | null;
  quotaLimit: number | null;
  refillAt: number | null;
  observedAt: number;
  receivedAt: number;
}) {
  const deliveryId = boundedText(args.deliveryId, "Delivery id", 128, deliveryPattern);
  const payloadDigest = boundedText(args.payloadDigest.toLowerCase(), "Payload digest", 64, digestPattern);
  const sourceCommentId = boundedText(args.sourceCommentId, "Source comment id", 30, commentIdPattern);
  const repository = boundedText(args.repository, "Repository", 200, repositoryPattern);
  const subjectLogin = boundedText(args.subjectLogin, "Subject login", 120, loginPattern);
  const pullRequestNumber = boundedInteger(args.pullRequestNumber, "Pull request number", 1, Number.MAX_SAFE_INTEGER);
  const observedAt = boundedTimestamp(args.observedAt, "Observation time");
  const receivedAt = boundedTimestamp(args.receivedAt, "Receipt time");
  if (observedAt > receivedAt + 5 * 60 * 1_000) {
    throw new Error("Provider capacity observation time is too far in the future");
  }
  if ((args.remaining === null) !== (args.quotaLimit === null)) {
    throw new Error("Provider capacity remaining and limit must be supplied together");
  }
  if (args.remaining !== null && args.quotaLimit !== null) {
    boundedInteger(args.quotaLimit, "Quota limit", 1, 1_000);
    boundedInteger(args.remaining, "Remaining reviews", 0, args.quotaLimit);
    if (args.providerState === "available" && args.remaining === 0) {
      throw new Error("Available provider capacity cannot report zero remaining");
    }
    if (args.providerState === "unavailable" && args.remaining !== 0) {
      throw new Error("Unavailable counted capacity must report zero remaining");
    }
  }
  let refillAt: number | null = null;
  if (args.refillAt !== null) {
    refillAt = boundedTimestamp(args.refillAt, "Refill time");
    if (refillAt <= observedAt || refillAt - observedAt > MAX_REFILL_WINDOW_MS) {
      throw new Error("Provider capacity refill time is outside the bounded window");
    }
  } else if (args.providerState === "unavailable") {
    throw new Error("Unavailable provider capacity requires a refill time");
  }
  return {
    deliveryId,
    payloadDigest,
    sourceCommentId,
    repository,
    pullRequestNumber,
    subjectLogin,
    providerState: args.providerState,
    remaining: args.remaining,
    quotaLimit: args.quotaLimit,
    refillAt,
    observedAt,
    receivedAt,
  };
}

async function reserveDelivery(
  ctx: any,
  workspaceId: any,
  deliveryId: string,
  payloadDigest: string,
  observationId: any,
  createdAt: number,
) {
  const aliases = await ctx.db
    .query("providerCapacityDeliveries")
    .withIndex("by_observation", (q: any) => q.eq("observationId", observationId))
    .take(MAX_DELIVERIES_PER_OBSERVATION);
  if (aliases.length >= MAX_DELIVERIES_PER_OBSERVATION) {
    throw new Error("PROVIDER_CAPACITY_DELIVERY_LIMIT");
  }
  await ctx.db.insert("providerCapacityDeliveries", {
    workspaceId,
    provider: "coderabbit",
    deliveryId,
    payloadDigest,
    observationId,
    createdAt,
  });
}

async function makeCapacity(ctx: any, workspaceId: any) {
  const rows = await ctx.db
    .query("providerCapacityObservations")
    .withIndex("by_workspace_received", (q: any) => q.eq("workspaceId", workspaceId))
    .order("asc")
    .take(MAX_OBSERVATIONS_PER_WORKSPACE);
  if (rows.length < MAX_OBSERVATIONS_PER_WORKSPACE) return;
  const oldest = rows[0];
  if (!oldest) throw new Error("PROVIDER_CAPACITY_STORAGE_LIMIT");
  const aliases = await ctx.db
    .query("providerCapacityDeliveries")
    .withIndex("by_observation", (q: any) => q.eq("observationId", oldest._id))
    .take(MAX_DELIVERIES_PER_OBSERVATION + 1);
  for (const alias of aliases) await ctx.db.delete(alias._id);
  await ctx.db.delete(oldest._id);
}

function publicObservation(observation: any) {
  return {
    id: String(observation._id),
    provider: "coderabbit" as const,
    sourceCommentId: observation.sourceCommentId,
    repository: observation.repository,
    pullRequestNumber: observation.pullRequestNumber,
    subjectLogin: observation.subjectLogin,
    subjectBasis: "pull_request_author_proxy" as const,
    state: observation.providerState,
    remaining: observation.remaining,
    limit: observation.quotaLimit,
    refillAt: observation.refillAt,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
  };
}

function boundedText(value: string, label: string, maximum: number, pattern: RegExp): string {
  const output = value.trim();
  if (output.length < 1 || output.length > maximum || unsafeTextPattern.test(output) || !pattern.test(output)) {
    throw new Error(`${label} is invalid`);
  }
  return output;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}
