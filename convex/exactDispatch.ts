import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { sha256, stableJson } from "../src/canonical-json";
import { runnerProfileProvenanceV1 } from "../src/runner-profile-provenance";
import {
  assertLeaseSeconds,
  assertSlug,
  assertText,
  findIdempotentEvent,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicItem,
  requireServiceSecret,
  requireSameIdempotentItem,
  upsertActor,
} from "./lib/domain";
import { dispatchHostedExactGeneration } from "./lib/exactDispatch";
import {
  executionEnvelopeValidator,
  normalizeExecutionEnvelope,
  readHostedRunExecution,
} from "./lib/executionEnvelope";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

export const dispatch = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    itemId: v.string(),
    expectedClaimGeneration: v.number(),
    actor: actorValidator,
    runnerType: v.string(),
    runnerProfile: v.string(),
    runnerProfileVersion: v.union(v.string(), v.null()),
    executionEnvelope: executionEnvelopeValidator,
    leaseSeconds: v.number(),
    maxAttempts: v.number(),
    retryBackoffSeconds: v.number(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Exact dispatch workspace does not exist");
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error(`Project ${projectSlug} does not exist`);
    const itemExternalId = assertText(args.itemId, "Dispatch item ID", 240);
    const item = await getItemByExternalId(ctx, workspace._id, itemExternalId);
    if (item.projectId !== project._id) {
      throw new Error("Exact dispatch item belongs to another project");
    }
    const expectedClaimGeneration = nonNegativeInteger(
      args.expectedClaimGeneration,
      "Expected claim generation",
    );
    const profile = runnerProfileProvenanceV1(
      args.runnerProfile,
      args.runnerProfileVersion,
    );
    const executionEnvelope = normalizeExecutionEnvelope(
      args.executionEnvelope,
      `Dispatch ${itemExternalId}`,
    );
    const request = {
      version: 1 as const,
      project: projectSlug,
      itemId: itemExternalId,
      expectedClaimGeneration,
      actor: args.actor,
      runnerType: assertText(args.runnerType, "Runner type", 80),
      runnerProfile: profile.profileId,
      runnerProfileVersion: profile.profileVersion,
      executionEnvelope,
      leaseSeconds: assertLeaseSeconds(args.leaseSeconds),
      maxAttempts: boundedInteger(args.maxAttempts, "Maximum attempts", 1, 20),
      retryBackoffSeconds: boundedInteger(
        args.retryBackoffSeconds,
        "Retry backoff seconds",
        0,
        86_400,
      ),
    };
    const requestFingerprint = sha256(stableJson(request));
    const idempotencyKey = assertText(args.idempotencyKey, "Dispatch idempotency key", 240);

    const replay = await findIdempotentEvent(ctx, workspace._id, idempotencyKey);
    if (replay) {
      if (replay.type !== "run.queued") {
        throw new Error("Idempotency key already belongs to another operation");
      }
      await requireSameIdempotentItem(ctx, replay, {
        projectSlug,
        itemExternalId,
        actorExternalId: args.actor.id,
        payloadSubset: { requestFingerprint },
      });
      return await replayResult(ctx, workspace._id, replay, request);
    }

    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Exact dispatch actor is unavailable");
    const outcome = await dispatchHostedExactGeneration(ctx, {
      workspaceId: workspace._id,
      itemId: item._id,
      actor,
      expectedClaimGeneration,
      runnerType: request.runnerType,
      runnerProfile: request.runnerProfile,
      runnerProfileVersion: request.runnerProfileVersion,
      leaseSeconds: request.leaseSeconds,
      maxAttempts: request.maxAttempts,
      retryBackoffSeconds: request.retryBackoffSeconds,
      executionEnvelope,
      eventSource: "direct_exact_dispatch",
      idempotencyKey,
      requestFingerprint,
      now: Date.now(),
    });
    if (outcome.status === "stale_generation") {
      throw new Error(
        `Exact dispatch claim generation changed from ${outcome.expectedClaimGeneration} to ${outcome.currentClaimGeneration}`,
      );
    }
    if (outcome.status === "unavailable") {
      throw new Error("Exact dispatch item is not currently eligible");
    }
    return await publicResult(
      ctx,
      false,
      outcome.expectedClaimGeneration,
      outcome.claimedGeneration,
      outcome.item,
      outcome.run,
    );
  },
});

async function replayResult(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  event: Doc<"events">,
  request: {
    expectedClaimGeneration: number;
    runnerType: string;
    runnerProfile: string;
    runnerProfileVersion: string | null;
  },
) {
  const payload = record(event.payload, "Exact dispatch replay event");
  if (typeof payload.runId !== "string") {
    throw new Error("Exact dispatch replay run ID is invalid");
  }
  const runId = assertText(payload.runId, "Exact dispatch replay run ID", 240);
  const claimedGeneration = nonNegativeInteger(
    payload.claimedGeneration,
    "Exact dispatch replay claimed generation",
  );
  if (claimedGeneration !== request.expectedClaimGeneration + 1) {
    throw new Error("Exact dispatch replay claim generation changed");
  }
  const run = await ctx.db
    .query("queuedRuns")
    .withIndex("by_workspace_external", (q) =>
      q.eq("workspaceId", workspaceId).eq("externalId", runId)
    )
    .unique();
  const item = await ctx.db.get("items", event.itemId);
  if (
    !run
    || !item
    || run.itemId !== item._id
    || run.runnerType !== request.runnerType
    || run.runnerProfile !== request.runnerProfile
    || (run.runnerProfileVersion ?? null) !== request.runnerProfileVersion
  ) {
    throw new Error("Exact dispatch replay durable run changed");
  }
  return await publicResult(
    ctx,
    true,
    request.expectedClaimGeneration,
    claimedGeneration,
    item,
    run,
  );
}

async function publicResult(
  ctx: MutationCtx,
  replay: boolean,
  expectedClaimGeneration: number,
  claimedGeneration: number,
  item: Doc<"items">,
  run: Doc<"queuedRuns">,
) {
  const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
  return Object.freeze({
    status: "dispatched" as const,
    replay,
    expectedClaimGeneration,
    claimedGeneration,
    item: await publicItem(ctx, item),
    run: {
      id: run.externalId,
      itemId: item.externalId,
      actorId: run.actorExternalId,
      runnerType: run.runnerType,
      runnerProfile: run.runnerProfile,
      runnerProfileVersion: run.runnerProfileVersion ?? null,
      externalRunId: run.externalRunId ?? null,
      status: run.status,
      generation: run.generation,
      leaseGeneration: run.leaseGeneration,
      leaseOwnerId: run.leaseOwnerExternalId ?? null,
      leaseExpiresAt: run.leaseExpiresAt === undefined
        ? null
        : new Date(run.leaseExpiresAt).toISOString(),
      lastHeartbeatAt: run.lastHeartbeatAt === undefined
        ? null
        : new Date(run.lastHeartbeatAt).toISOString(),
      checkpoint: run.checkpoint ?? null,
      outcome: run.outcome ?? null,
      continuationRef: run.continuationRef ?? null,
      usage: run.usage,
      retryAttempt: run.retryAttempt,
      maxAttempts: run.maxAttempts,
      retryBackoffSeconds: run.retryBackoffSeconds,
      nextRetryAt: run.nextRetryAt === undefined
        ? null
        : new Date(run.nextRetryAt).toISOString(),
      createdAt: new Date(run.createdAt).toISOString(),
      updatedAt: new Date(run.updatedAt).toISOString(),
      startedAt: run.startedAt === undefined ? null : new Date(run.startedAt).toISOString(),
      endedAt: run.endedAt === undefined ? null : new Date(run.endedAt).toISOString(),
      executionEnvelope: execution.executionEnvelope,
      executionRecords: execution.executionRecords,
    },
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}
