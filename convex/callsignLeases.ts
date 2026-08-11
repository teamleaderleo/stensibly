import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canonicalHostedCallsign,
  MAX_HOSTED_CALLSIGN_LEASE_SECONDS,
} from "./lib/callsign";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type MutationContext,
} from "./lib/domain";
import { sameCanonical } from "./lib/executionEnvelope";
import { internalMutation, mutation } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const expireLeaseRef = makeFunctionReference<"mutation">("callsignLeases:expireScheduled");
const MAX_WORKER_SESSION_ID_LENGTH = 160;
const MAX_RUN_ID_LENGTH = 160;
const MAX_REQUEST_ID_LENGTH = 240;
const MAX_IDEMPOTENCY_KEY_LENGTH = 240;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;

const inheritanceValidator = v.object({
  fromRunId: v.string(),
  transferReference: v.string(),
});

type CallsignLease = Doc<"callsignLeases">;
type WorkspaceId = Id<"workspaces">;
type CommandOperation = "reserve" | "renew" | "release";
type RejectionReason =
  | "active_collision"
  | "expired_request"
  | "expiry_too_far"
  | "inheritance_not_supported"
  | "lease_not_found"
  | "lease_not_active"
  | "holder_mismatch"
  | "stale_generation"
  | "expiry_not_extended";

export const reserve = mutation({
  args: {
    ...serviceArgs,
    requestedCallsign: v.string(),
    workerSessionId: v.string(),
    runId: v.string(),
    requestId: v.string(),
    requestedAt: v.string(),
    expiresAt: v.string(),
    expectedGeneration: v.optional(v.number()),
    inheritance: v.optional(inheritanceValidator),
    fingerprint: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const input = normalizeReserve(args);
    if (input.idempotencyKey !== input.requestId) {
      throw new Error("Callsign reservation idempotency key must equal request ID");
    }
    const request = reserveRequest(input);
    const replay = await replayCommand(ctx, workspace._id, input.idempotencyKey, "reserve", request);
    if (replay.found) return replay.result;

    const now = Date.now();
    const active = await currentLeaseForCollision(ctx, workspace._id, input.collisionKey, now);
    const maximumGeneration = await maximumGenerationForCollision(
      ctx,
      workspace._id,
      input.collisionKey,
    );
    const reason = reserveRejection(input, now, active, maximumGeneration);
    if (reason) {
      const result = rejectedResult("reserve", reason, active, maximumGeneration);
      await storeCommand(ctx, workspace._id, input.idempotencyKey, "reserve", request, result, now);
      return result;
    }

    const generation = maximumGeneration + 1;
    const leaseId = await ctx.db.insert("callsignLeases", {
      workspaceId: workspace._id,
      externalId: "pending",
      callsign: input.callsign,
      collisionKey: input.collisionKey,
      workerSessionId: input.workerSessionId,
      runId: input.runId,
      generation,
      status: "active",
      reservationRequestId: input.requestId,
      reservationFingerprint: input.fingerprint,
      acceptedAt: now,
      expiresAt: input.expiresAtMs,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(leaseId, { externalId: `csl_${leaseId}` });
    await ctx.scheduler.runAt(input.expiresAtMs, expireLeaseRef, { leaseId, generation });
    const lease = await ctx.db.get("callsignLeases", leaseId);
    if (!lease) throw new Error("Accepted callsign lease disappeared");
    const result = acceptedResult("reserve", lease);
    await storeCommand(ctx, workspace._id, input.idempotencyKey, "reserve", request, result, now);
    return result;
  },
});

export const renew = mutation({
  args: {
    ...serviceArgs,
    leaseId: v.string(),
    workerSessionId: v.string(),
    runId: v.string(),
    expectedGeneration: v.number(),
    expiresAt: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const input = normalizeRenew(args);
    const request = renewRequest(input);
    const replay = await replayCommand(ctx, workspace._id, input.idempotencyKey, "renew", request);
    if (replay.found) return replay.result;

    const now = Date.now();
    let lease = await findLease(ctx, workspace._id, input.leaseId);
    if (lease) lease = await reconcileLeaseIfExpired(ctx, lease, now);
    const holderReason = validateHeldActiveLease(
      lease,
      input.workerSessionId,
      input.runId,
      input.expectedGeneration,
    );
    if (holderReason) {
      const result = rejectedResult("renew", holderReason, lease, lease?.generation ?? null);
      await storeCommand(ctx, workspace._id, input.idempotencyKey, "renew", request, result, now);
      return result;
    }
    if (!lease) throw new Error("Validated callsign lease unexpectedly disappeared");

    const expiryReason = renewalExpiryRejection(lease, input.expiresAtMs, now);
    if (expiryReason) {
      const result = rejectedResult("renew", expiryReason, lease, lease.generation);
      await storeCommand(ctx, workspace._id, input.idempotencyKey, "renew", request, result, now);
      return result;
    }

    await ctx.db.patch(lease._id, {
      expiresAt: input.expiresAtMs,
      lastHeartbeatAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(input.expiresAtMs, expireLeaseRef, {
      leaseId: lease._id,
      generation: lease.generation,
    });
    const updated = await ctx.db.get("callsignLeases", lease._id);
    if (!updated) throw new Error("Renewed callsign lease disappeared");
    const result = acceptedResult("renew", updated);
    await storeCommand(ctx, workspace._id, input.idempotencyKey, "renew", request, result, now);
    return result;
  },
});

export const release = mutation({
  args: {
    ...serviceArgs,
    leaseId: v.string(),
    workerSessionId: v.string(),
    runId: v.string(),
    expectedGeneration: v.number(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const input = normalizeRelease(args);
    const request = releaseRequest(input);
    const replay = await replayCommand(ctx, workspace._id, input.idempotencyKey, "release", request);
    if (replay.found) return replay.result;

    const now = Date.now();
    let lease = await findLease(ctx, workspace._id, input.leaseId);
    if (lease) lease = await reconcileLeaseIfExpired(ctx, lease, now);
    const reason = validateHeldActiveLease(
      lease,
      input.workerSessionId,
      input.runId,
      input.expectedGeneration,
    );
    if (reason) {
      const result = rejectedResult("release", reason, lease, lease?.generation ?? null);
      await storeCommand(ctx, workspace._id, input.idempotencyKey, "release", request, result, now);
      return result;
    }
    if (!lease) throw new Error("Validated callsign lease unexpectedly disappeared");

    await ctx.db.patch(lease._id, { status: "released", releasedAt: now, updatedAt: now });
    const updated = await ctx.db.get("callsignLeases", lease._id);
    if (!updated) throw new Error("Released callsign lease disappeared");
    const result = acceptedResult("release", updated);
    await storeCommand(ctx, workspace._id, input.idempotencyKey, "release", request, result, now);
    return result;
  },
});

export const get = mutation({
  args: { ...serviceArgs, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const id = boundedIdentifier(args.id, "Callsign lease ID", MAX_REQUEST_ID_LENGTH, identifierPattern);
    const lease = await findLease(ctx, workspace._id, id);
    return lease ? publicLease(await reconcileLeaseIfExpired(ctx, lease, Date.now())) : null;
  },
});

export const getCurrent = mutation({
  args: { ...serviceArgs, callsign: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const { collisionKey } = canonicalHostedCallsign(args.callsign);
    const lease = await currentLeaseForCollision(ctx, workspace._id, collisionKey, Date.now());
    return lease ? publicLease(lease) : null;
  },
});

export const expireScheduled = internalMutation({
  args: { leaseId: v.id("callsignLeases"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lease = await ctx.db.get("callsignLeases", args.leaseId);
    if (
      !lease
      || lease.status !== "active"
      || lease.generation !== args.generation
      || lease.expiresAt > Date.now()
    ) return null;
    await expireLease(ctx, lease, Date.now());
    return null;
  },
});

function reserveRejection(
  input: ReturnType<typeof normalizeReserve>,
  now: number,
  active: CallsignLease | null,
  maximumGeneration: number,
): RejectionReason | null {
  if (input.inheritance !== null) return "inheritance_not_supported";
  if (input.expiresAtMs <= now) return "expired_request";
  if (input.expiresAtMs - now > MAX_HOSTED_CALLSIGN_LEASE_SECONDS * 1_000) return "expiry_too_far";
  if (active) return "active_collision";
  if (input.expectedGeneration !== null && input.expectedGeneration !== maximumGeneration) {
    return "stale_generation";
  }
  return null;
}

function renewalExpiryRejection(
  lease: CallsignLease,
  expiresAtMs: number,
  now: number,
): RejectionReason | null {
  if (expiresAtMs <= now) return "expired_request";
  if (expiresAtMs - now > MAX_HOSTED_CALLSIGN_LEASE_SECONDS * 1_000) return "expiry_too_far";
  if (expiresAtMs <= lease.expiresAt) return "expiry_not_extended";
  return null;
}

async function requiredWorkspace(ctx: MutationContext, workspaceValue: string | undefined) {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceValue));
  if (!workspace) throw new Error("Workspace does not exist");
  return workspace;
}

async function findLease(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  externalId: string,
): Promise<CallsignLease | null> {
  return await ctx.db
    .query("callsignLeases")
    .withIndex("by_workspace_external", (q) =>
      q.eq("workspaceId", workspaceId).eq("externalId", externalId)
    )
    .unique() ?? null;
}

async function currentLeaseForCollision(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  collisionKey: string,
  now: number,
): Promise<CallsignLease | null> {
  const active = await ctx.db
    .query("callsignLeases")
    .withIndex("by_workspace_collision_status", (q) =>
      q.eq("workspaceId", workspaceId).eq("collisionKey", collisionKey).eq("status", "active")
    )
    .take(2);
  if (active.length > 1) {
    throw new Error(`Callsign collision invariant violated for ${collisionKey}`);
  }
  const candidate = active[0];
  if (!candidate) return null;
  const reconciled = await reconcileLeaseIfExpired(ctx, candidate, now);
  return reconciled.status === "active" ? reconciled : null;
}

async function maximumGenerationForCollision(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  collisionKey: string,
): Promise<number> {
  const latest = await ctx.db
    .query("callsignLeases")
    .withIndex("by_workspace_collision_generation", (q) =>
      q.eq("workspaceId", workspaceId).eq("collisionKey", collisionKey)
    )
    .order("desc")
    .first();
  return latest?.generation ?? 0;
}

async function reconcileLeaseIfExpired(
  ctx: MutationContext,
  lease: CallsignLease,
  now: number,
): Promise<CallsignLease> {
  if (lease.status !== "active" || lease.expiresAt > now) return lease;
  await expireLease(ctx, lease, now);
  const updated = await ctx.db.get("callsignLeases", lease._id);
  if (!updated) throw new Error("Expired callsign lease disappeared");
  return updated;
}

async function expireLease(ctx: MutationContext, lease: CallsignLease, now: number): Promise<void> {
  await ctx.db.patch(lease._id, { status: "expired", expiredAt: lease.expiresAt, updatedAt: now });
}

function validateHeldActiveLease(
  lease: CallsignLease | null,
  workerSessionId: string,
  runId: string,
  expectedGeneration: number,
): RejectionReason | null {
  if (!lease) return "lease_not_found";
  if (lease.status !== "active") return "lease_not_active";
  if (lease.workerSessionId !== workerSessionId || lease.runId !== runId) return "holder_mismatch";
  if (lease.generation !== expectedGeneration) return "stale_generation";
  return null;
}

async function replayCommand(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  idempotencyKey: string,
  operation: CommandOperation,
  request: unknown,
): Promise<{ found: boolean; result: unknown }> {
  const existing = await ctx.db
    .query("callsignLeaseCommands")
    .withIndex("by_workspace_idempotency", (q) =>
      q.eq("workspaceId", workspaceId).eq("idempotencyKey", idempotencyKey)
    )
    .unique();
  if (!existing) return { found: false, result: null };
  if (existing.operation !== operation || !sameCanonical(existing.request, request)) {
    throw new Error("Idempotency key was already used for a different callsign lease command");
  }
  return { found: true, result: existing.result };
}

async function storeCommand(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  idempotencyKey: string,
  operation: CommandOperation,
  request: unknown,
  result: unknown,
  createdAt: number,
): Promise<void> {
  await ctx.db.insert("callsignLeaseCommands", {
    workspaceId,
    idempotencyKey,
    operation,
    request,
    result,
    createdAt,
  });
}

function normalizeReserve(args: {
  requestedCallsign: string;
  workerSessionId: string;
  runId: string;
  requestId: string;
  requestedAt: string;
  expiresAt: string;
  expectedGeneration?: number;
  inheritance?: { fromRunId: string; transferReference: string };
  fingerprint: string;
  idempotencyKey: string;
}) {
  const callsign = canonicalHostedCallsign(args.requestedCallsign);
  const requestedAt = canonicalTimestamp(args.requestedAt, "Callsign request time");
  const expiresAt = canonicalTimestamp(args.expiresAt, "Callsign lease expiry");
  const leaseSeconds = (expiresAt.milliseconds - requestedAt.milliseconds) / 1_000;
  if (leaseSeconds <= 0 || leaseSeconds > MAX_HOSTED_CALLSIGN_LEASE_SECONDS) {
    throw new Error(
      `Callsign reservation lifetime must be from 1 to ${MAX_HOSTED_CALLSIGN_LEASE_SECONDS} seconds`,
    );
  }
  return {
    callsign: callsign.display,
    collisionKey: callsign.collisionKey,
    workerSessionId: boundedIdentifier(
      args.workerSessionId,
      "Worker session ID",
      MAX_WORKER_SESSION_ID_LENGTH,
      identifierPattern,
    ),
    runId: boundedIdentifier(args.runId, "Run ID", MAX_RUN_ID_LENGTH, runIdPattern),
    requestId: boundedIdentifier(args.requestId, "Request ID", MAX_REQUEST_ID_LENGTH, identifierPattern),
    requestedAt: requestedAt.value,
    expiresAt: expiresAt.value,
    expiresAtMs: expiresAt.milliseconds,
    expectedGeneration: args.expectedGeneration === undefined
      ? null
      : positiveGeneration(args.expectedGeneration, "Expected generation"),
    inheritance: args.inheritance === undefined
      ? null
      : {
        fromRunId: boundedIdentifier(
          args.inheritance.fromRunId,
          "Inheritance source run ID",
          MAX_RUN_ID_LENGTH,
          runIdPattern,
        ),
        transferReference: boundedIdentifier(
          args.inheritance.transferReference,
          "Inheritance transfer reference",
          MAX_REQUEST_ID_LENGTH,
          identifierPattern,
        ),
      },
    fingerprint: canonicalFingerprint(args.fingerprint),
    idempotencyKey: boundedIdentifier(
      args.idempotencyKey,
      "Idempotency key",
      MAX_IDEMPOTENCY_KEY_LENGTH,
      identifierPattern,
    ),
  };
}

function normalizeRenew(args: {
  leaseId: string;
  workerSessionId: string;
  runId: string;
  expectedGeneration: number;
  expiresAt: string;
  idempotencyKey: string;
}) {
  const expiresAt = canonicalTimestamp(args.expiresAt, "Callsign lease expiry");
  return {
    leaseId: boundedIdentifier(args.leaseId, "Callsign lease ID", MAX_REQUEST_ID_LENGTH, identifierPattern),
    workerSessionId: boundedIdentifier(
      args.workerSessionId,
      "Worker session ID",
      MAX_WORKER_SESSION_ID_LENGTH,
      identifierPattern,
    ),
    runId: boundedIdentifier(args.runId, "Run ID", MAX_RUN_ID_LENGTH, runIdPattern),
    expectedGeneration: positiveGeneration(args.expectedGeneration, "Expected generation"),
    expiresAt: expiresAt.value,
    expiresAtMs: expiresAt.milliseconds,
    idempotencyKey: boundedIdentifier(
      args.idempotencyKey,
      "Idempotency key",
      MAX_IDEMPOTENCY_KEY_LENGTH,
      identifierPattern,
    ),
  };
}

function normalizeRelease(args: {
  leaseId: string;
  workerSessionId: string;
  runId: string;
  expectedGeneration: number;
  idempotencyKey: string;
}) {
  return {
    leaseId: boundedIdentifier(args.leaseId, "Callsign lease ID", MAX_REQUEST_ID_LENGTH, identifierPattern),
    workerSessionId: boundedIdentifier(
      args.workerSessionId,
      "Worker session ID",
      MAX_WORKER_SESSION_ID_LENGTH,
      identifierPattern,
    ),
    runId: boundedIdentifier(args.runId, "Run ID", MAX_RUN_ID_LENGTH, runIdPattern),
    expectedGeneration: positiveGeneration(args.expectedGeneration, "Expected generation"),
    idempotencyKey: boundedIdentifier(
      args.idempotencyKey,
      "Idempotency key",
      MAX_IDEMPOTENCY_KEY_LENGTH,
      identifierPattern,
    ),
  };
}

function reserveRequest(input: ReturnType<typeof normalizeReserve>) {
  return {
    version: 1,
    workspaceBoundByService: true,
    requestedCallsign: input.callsign,
    collisionKey: input.collisionKey,
    workerSessionId: input.workerSessionId,
    runId: input.runId,
    requestId: input.requestId,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    expectedGeneration: input.expectedGeneration,
    inheritance: input.inheritance,
    fingerprint: input.fingerprint,
  };
}

function renewRequest(input: ReturnType<typeof normalizeRenew>) {
  return {
    leaseId: input.leaseId,
    workerSessionId: input.workerSessionId,
    runId: input.runId,
    expectedGeneration: input.expectedGeneration,
    expiresAt: input.expiresAt,
  };
}

function releaseRequest(input: ReturnType<typeof normalizeRelease>) {
  return {
    leaseId: input.leaseId,
    workerSessionId: input.workerSessionId,
    runId: input.runId,
    expectedGeneration: input.expectedGeneration,
  };
}

function acceptedResult(operation: CommandOperation, lease: CallsignLease) {
  return {
    version: 1,
    operation,
    outcome: "accepted" as const,
    reason: null,
    currentGeneration: lease.generation,
    lease: publicLease(lease),
    grantsIdentityContinuity: false as const,
    grantsAuthority: false as const,
  };
}

function rejectedResult(
  operation: CommandOperation,
  reason: RejectionReason,
  lease: CallsignLease | null,
  currentGeneration: number | null,
) {
  return {
    version: 1,
    operation,
    outcome: "rejected" as const,
    reason,
    currentGeneration,
    lease: lease ? publicLease(lease) : null,
    grantsIdentityContinuity: false as const,
    grantsAuthority: false as const,
  };
}

function publicLease(lease: CallsignLease) {
  return {
    id: lease.externalId,
    callsign: lease.callsign,
    collisionKey: lease.collisionKey,
    workerSessionId: lease.workerSessionId,
    runId: lease.runId,
    generation: lease.generation,
    status: lease.status,
    reservationRequestId: lease.reservationRequestId,
    reservationFingerprint: lease.reservationFingerprint,
    acceptedAt: new Date(lease.acceptedAt).toISOString(),
    expiresAt: new Date(lease.expiresAt).toISOString(),
    lastHeartbeatAt: new Date(lease.lastHeartbeatAt).toISOString(),
    releasedAt: lease.releasedAt === undefined ? null : new Date(lease.releasedAt).toISOString(),
    expiredAt: lease.expiredAt === undefined ? null : new Date(lease.expiredAt).toISOString(),
    grantsIdentityContinuity: false as const,
    grantsAuthority: false as const,
  };
}

function boundedIdentifier(value: string, label: string, maximumLength: number, pattern: RegExp): string {
  if (unsafeTextPattern.test(value)) throw new Error(`${label} contains unsupported control characters`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if ([...normalized].length > maximumLength) {
    throw new Error(`${label} must be at most ${maximumLength} characters`);
  }
  if (!pattern.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

function positiveGeneration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function canonicalTimestamp(value: string, label: string): { value: string; milliseconds: number } {
  if (unsafeTextPattern.test(value)) throw new Error(`${label} contains unsupported control characters`);
  const normalized = value.trim();
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  const canonical = new Date(milliseconds).toISOString();
  const comparable = normalized.includes(".") ? normalized : normalized.replace(/Z$/, ".000Z");
  if (canonical !== comparable) throw new Error(`${label} must be a canonical ISO-8601 UTC timestamp`);
  return { value: canonical, milliseconds };
}

function canonicalFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!sha256Pattern.test(normalized)) {
    throw new Error("Callsign reservation fingerprint must be a SHA-256 fingerprint");
  }
  return normalized;
}
