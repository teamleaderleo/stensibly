import type { Doc, Id } from "../_generated/dataModel";
import type { ExecutionEnvelope } from "../../src/execution-envelope";
import {
  appendEvent,
  assertLeaseSeconds,
  assertText,
  type MutationContext,
} from "./domain";
import { appendExecutionEnvelopeEvent } from "./executionEnvelope";

const LIVE_QUEUED_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting",
  "blocked",
] as const;
const LIVE_LEGACY_RUN_STATUSES = ["running", "waiting"] as const;

export interface HostedExactDispatchInput {
  readonly workspaceId: Id<"workspaces">;
  readonly itemId: Id<"items">;
  readonly actor: Doc<"actors">;
  readonly expectedClaimGeneration: number;
  readonly runnerType: string;
  readonly runnerProfile: string;
  readonly runnerProfileVersion: string | null;
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly retryBackoffSeconds: number;
  readonly continuationRef?: string;
  readonly executionEnvelope: ExecutionEnvelope;
  readonly eventSource: string;
  readonly now: number;
}

export type HostedExactDispatchOutcome =
  | {
      readonly status: "dispatched";
      readonly expectedClaimGeneration: number;
      readonly claimedGeneration: number;
      readonly item: Doc<"items">;
      readonly run: Doc<"queuedRuns">;
    }
  | {
      readonly status: "stale_generation";
      readonly expectedClaimGeneration: number;
      readonly currentClaimGeneration: number;
    }
  | {
      readonly status: "unavailable";
      readonly expectedClaimGeneration: number;
    };

/**
 * Reserve one exact current work generation and queue its hosted run.
 *
 * Convex mutation isolation is the atomic fence. Eligibility owners must call
 * this helper from the same mutation that revalidates their own source facts.
 * Runner pickup happens later through runnerRuns.claim and does not advance the
 * item claim generation again.
 */
export async function dispatchHostedExactGeneration(
  ctx: MutationContext,
  rawInput: HostedExactDispatchInput,
): Promise<HostedExactDispatchOutcome> {
  const input = normalizeInput(rawInput);
  const current = await ctx.db.get("items", input.itemId);
  if (
    !current
    || current.workspaceId !== input.workspaceId
    || current.status !== "ready"
  ) {
    return freeze({
      status: "unavailable" as const,
      expectedClaimGeneration: input.expectedClaimGeneration,
    });
  }

  if (current.claimGeneration !== input.expectedClaimGeneration) {
    return freeze({
      status: "stale_generation" as const,
      expectedClaimGeneration: input.expectedClaimGeneration,
      currentClaimGeneration: current.claimGeneration,
    });
  }

  if (!(await itemCanAcceptDispatch(ctx, current, input.actor.externalId, input.now))) {
    return freeze({
      status: "unavailable" as const,
      expectedClaimGeneration: input.expectedClaimGeneration,
    });
  }

  const leaseExpiresAt = input.now + input.leaseSeconds * 1_000;
  const claimedGeneration = input.expectedClaimGeneration + 1;
  await ctx.db.patch(current._id, {
    status: "active",
    claimedByActorId: input.actor._id,
    claimedByExternalId: input.actor.externalId,
    claimExpiresAt: leaseExpiresAt,
    claimGeneration: claimedGeneration,
    version: current.version + 1,
    updatedAt: input.now,
  });

  const queuedRunId = await ctx.db.insert("queuedRuns", {
    workspaceId: current.workspaceId,
    projectId: current.projectId,
    itemId: current._id,
    externalId: "pending",
    actorId: input.actor._id,
    actorExternalId: input.actor.externalId,
    runnerType: input.runnerType,
    runnerProfile: input.runnerProfile,
    ...(input.runnerProfileVersion === null
      ? {}
      : { runnerProfileVersion: input.runnerProfileVersion }),
    status: "queued",
    generation: 1,
    leaseGeneration: 1,
    leaseOwnerExternalId: input.actor.externalId,
    leaseExpiresAt,
    ...(input.continuationRef === undefined
      ? {}
      : { continuationRef: input.continuationRef }),
    usage: {},
    retryAttempt: 0,
    maxAttempts: input.maxAttempts,
    retryBackoffSeconds: input.retryBackoffSeconds,
    createdAt: input.now,
    updatedAt: input.now,
  });
  const runExternalId = `run_${queuedRunId}`;
  await ctx.db.patch(queuedRunId, { externalId: runExternalId });

  await appendExecutionEnvelopeEvent(ctx, {
    workspaceId: current.workspaceId,
    projectId: current.projectId,
    itemId: current._id,
    actorId: input.actor._id,
    actorExternalId: input.actor.externalId,
    runId: runExternalId,
    runGeneration: 1,
    leaseGeneration: 1,
    envelope: input.executionEnvelope,
    createdAt: input.now,
  });

  await appendEvent(ctx, {
    workspaceId: current.workspaceId,
    projectId: current.projectId,
    itemId: current._id,
    actorId: input.actor._id,
    actorExternalId: input.actor.externalId,
    type: "claim.created",
    payload: {
      leaseSeconds: input.leaseSeconds,
      expiresAt: new Date(leaseExpiresAt).toISOString(),
      source: input.eventSource,
    },
    createdAt: input.now,
  });
  await appendEvent(ctx, {
    workspaceId: current.workspaceId,
    projectId: current.projectId,
    itemId: current._id,
    actorId: input.actor._id,
    actorExternalId: input.actor.externalId,
    type: "run.queued",
    payload: {
      runId: runExternalId,
      generation: 1,
      leaseGeneration: 1,
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      runnerType: input.runnerType,
      runnerProfile: input.runnerProfile,
      runnerProfileVersion: input.runnerProfileVersion,
      source: input.eventSource,
      readyPromiseWakeups: 0,
      envelopeSchemaVersion: input.executionEnvelope.schemaVersion,
    },
    createdAt: input.now,
  });

  const [item, run] = await Promise.all([
    ctx.db.get("items", current._id),
    ctx.db.get("queuedRuns", queuedRunId),
  ]);
  if (!item || !run) {
    throw new Error("Hosted exact dispatch result disappeared");
  }
  if (
    item.claimGeneration !== claimedGeneration
    || run.itemId !== item._id
    || run.status !== "queued"
    || run.generation !== 1
    || run.leaseGeneration !== 1
  ) {
    throw new Error("Hosted exact dispatch produced an invalid reservation");
  }
  return freeze({
    status: "dispatched" as const,
    expectedClaimGeneration: input.expectedClaimGeneration,
    claimedGeneration,
    item,
    run,
  });
}

async function itemCanAcceptDispatch(
  ctx: MutationContext,
  item: Doc<"items">,
  actorExternalId: string,
  now: number,
): Promise<boolean> {
  if (item.status !== "ready") return false;
  if (
    item.claimedByExternalId !== undefined
    && item.claimExpiresAt !== undefined
    && item.claimExpiresAt > now
    && item.claimedByExternalId !== actorExternalId
  ) {
    return false;
  }

  for (const status of LIVE_QUEUED_RUN_STATUSES) {
    const rows = await ctx.db
      .query("queuedRuns")
      .withIndex("by_item_status", (q) =>
        q.eq("itemId", item._id).eq("status", status),
      )
      .take(1);
    if (rows.length > 0) return false;
  }

  const retryable = await ctx.db
    .query("queuedRuns")
    .withIndex("by_item_status", (q) =>
      q.eq("itemId", item._id).eq("status", "failed"),
    )
    .collect();
  if (retryable.some((run) => run.nextRetryAt !== undefined)) return false;

  for (const status of LIVE_LEGACY_RUN_STATUSES) {
    const rows = await ctx.db
      .query("runs")
      .withIndex("by_item_status", (q) =>
        q.eq("itemId", item._id).eq("status", status),
      )
      .take(1);
    if (rows.length > 0) return false;
  }
  return true;
}

function normalizeInput(input: HostedExactDispatchInput): HostedExactDispatchInput {
  const expectedClaimGeneration = nonNegativeInteger(
    input.expectedClaimGeneration,
    "Expected claim generation",
  );
  const maxAttempts = boundedInteger(input.maxAttempts, "Maximum attempts", 1, 20);
  const retryBackoffSeconds = boundedInteger(
    input.retryBackoffSeconds,
    "Retry backoff seconds",
    0,
    86_400,
  );
  const now = timestamp(input.now);
  const eventSource = assertText(input.eventSource, "Dispatch event source", 80);
  const runnerType = assertText(input.runnerType, "Runner type", 80);
  const runnerProfile = assertText(input.runnerProfile, "Runner profile", 240);
  const runnerProfileVersion = input.runnerProfileVersion === null
    ? null
    : assertText(input.runnerProfileVersion, "Runner profile version", 240);
  const continuationRef = input.continuationRef === undefined
    ? undefined
    : assertText(input.continuationRef, "Continuation reference", 240);
  return {
    ...input,
    expectedClaimGeneration,
    runnerType,
    runnerProfile,
    runnerProfileVersion,
    leaseSeconds: assertLeaseSeconds(input.leaseSeconds),
    maxAttempts,
    retryBackoffSeconds,
    continuationRef,
    eventSource,
    now,
  };
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
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

function timestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Dispatch timestamp must be a non-negative finite number");
  }
  return value;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
