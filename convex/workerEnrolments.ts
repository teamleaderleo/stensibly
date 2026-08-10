import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canonicalHostedCallsign,
  MAX_HOSTED_CALLSIGN_LEASE_SECONDS,
} from "./lib/callsign";
import {
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type MutationContext,
} from "./lib/domain";
import { sameCanonical } from "./lib/executionEnvelope";
import { internalMutation, mutation } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const expireEnrolmentRef = makeFunctionReference<"mutation">("workerEnrolments:expireScheduled");
const expireCallsignLeaseRef = makeFunctionReference<"mutation">("callsignLeases:expireScheduled");
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const slugPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;

const limits = {
  actorId: 240,
  clientId: 280,
  oauthAccountId: 240,
  adapter: 80,
  profile: 120,
  workerSessionId: 160,
  capability: 80,
  tool: 120,
  project: 80,
  stance: 80,
  relationId: 160,
  idempotencyKey: 240,
  workerRef: 240,
  capabilities: 32,
  tools: 100,
  projects: 50,
  stances: 16,
} as const;

const enrolmentRequestValidator = v.object({
  version: v.literal(1),
  adapter: v.string(),
  profile: v.string(),
  workerSessionId: v.string(),
  callsign: v.union(v.string(), v.null()),
  capabilities: v.array(v.string()),
  toolAllowlist: v.array(v.string()),
  projectScope: v.array(v.string()),
  preferredStances: v.array(v.string()),
  startedAt: v.string(),
  expiresAt: v.string(),
  heartbeatSeconds: v.number(),
  correlationId: v.union(v.string(), v.null()),
  causationId: v.union(v.string(), v.null()),
  grantsAuthority: v.literal(false),
  fingerprint: v.string(),
});

type WorkerEnrolment = Doc<"workerEnrolments">;
type CallsignLease = Doc<"callsignLeases">;
type WorkspaceId = Id<"workspaces">;
type Operation = "enrol" | "heartbeat" | "release";
type Owner = { actorId: string; clientId: string; oauthAccountId: string | null };
type RejectionReason =
  | "project_not_found"
  | "expired_request"
  | "active_session_exists"
  | "callsign_invalid"
  | "callsign_active_collision"
  | "callsign_lifetime_too_long"
  | "worker_not_found"
  | "worker_not_active";
type CallsignPlan = {
  display: string;
  collisionKey: string;
  generation: number;
};

export const enrol = mutation({
  args: {
    ...serviceArgs,
    actorId: v.string(),
    clientId: v.string(),
    oauthAccountId: v.optional(v.string()),
    request: enrolmentRequestValidator,
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const owner = normalizeOwner(args);
    const request = normalizeRequest(args.request);
    const idempotencyKey = boundedIdentifier(
      args.idempotencyKey,
      "Idempotency key",
      limits.idempotencyKey,
    );

    return withCommand(
      ctx,
      workspace._id,
      owner,
      idempotencyKey,
      "enrol",
      request,
      async () => {
        const now = Date.now();
        const missingProject = await firstMissingProject(ctx, workspace._id, request.projectScope);
        if (missingProject !== null) {
          return { ...rejectedResult("enrol", "project_not_found", null), missingProject };
        }
        if (request.expiresAtMs <= now) {
          return rejectedResult("enrol", "expired_request", null);
        }
        const active = await activeEnrolmentForSession(
          ctx,
          workspace._id,
          owner,
          request.workerSessionId,
          now,
        );
        if (active) return rejectedResult("enrol", "active_session_exists", active);

        const callsignPlan = request.callsign === null
          ? { outcome: "none" as const }
          : await planCallsign(
            ctx,
            workspace._id,
            request.callsign,
            request.expiresAtMs,
            now,
          );
        if (callsignPlan.outcome === "rejected") {
          return rejectedResult("enrol", callsignPlan.reason, null);
        }

        const acceptedCallsign = callsignPlan.outcome === "accepted"
          ? callsignPlan.plan.display
          : null;
        const enrolmentId = await ctx.db.insert("workerEnrolments", {
          workspaceId: workspace._id,
          externalId: "pending",
          actorId: owner.actorId,
          clientId: owner.clientId,
          ...(owner.oauthAccountId === null ? {} : { oauthAccountId: owner.oauthAccountId }),
          adapter: request.adapter,
          profile: request.profile,
          workerSessionId: request.workerSessionId,
          capabilities: request.capabilities,
          toolAllowlist: request.toolAllowlist,
          projectScope: request.projectScope,
          preferredStances: request.preferredStances,
          startedAt: request.startedAtMs,
          expiresAt: request.expiresAtMs,
          heartbeatSeconds: request.heartbeatSeconds,
          ...(request.correlationId === null ? {} : { correlationId: request.correlationId }),
          ...(request.causationId === null ? {} : { causationId: request.causationId }),
          requestFingerprint: request.fingerprint,
          status: "active",
          ...(acceptedCallsign === null ? {} : { callsign: acceptedCallsign }),
          acceptedAt: now,
          lastHeartbeatAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.patch(enrolmentId, { externalId: `wrk_${enrolmentId}` });

        if (callsignPlan.outcome === "accepted") {
          const leaseId = await insertEnrolmentCallsignLease(ctx, {
            workspaceId: workspace._id,
            workerEnrolmentId: enrolmentId,
            workerSessionId: request.workerSessionId,
            reservationRequestId: idempotencyKey,
            reservationFingerprint: request.fingerprint,
            expiresAtMs: request.expiresAtMs,
            now,
            plan: callsignPlan.plan,
          });
          await ctx.db.patch(enrolmentId, {
            callsignLeaseId: leaseId,
            callsignLeaseGeneration: callsignPlan.plan.generation,
          });
        }

        await ctx.scheduler.runAt(request.expiresAtMs, expireEnrolmentRef, { enrolmentId });
        const enrolment = await ctx.db.get("workerEnrolments", enrolmentId);
        if (!enrolment) throw new Error("Accepted worker enrolment disappeared");
        return acceptedResult("enrol", enrolment);
      },
    );
  },
});

export const heartbeat = mutation({
  args: {
    ...serviceArgs,
    actorId: v.string(),
    clientId: v.string(),
    workerRef: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const owner = normalizeOwner(args);
    const workerRef = boundedIdentifier(args.workerRef, "Worker reference", limits.workerRef);
    const idempotencyKey = boundedIdentifier(
      args.idempotencyKey,
      "Idempotency key",
      limits.idempotencyKey,
    );
    const request = { workerRef };

    return withCommand(
      ctx,
      workspace._id,
      owner,
      idempotencyKey,
      "heartbeat",
      request,
      async () => {
        const now = Date.now();
        let enrolment = await ownedEnrolment(ctx, workspace._id, workerRef, owner);
        if (enrolment) enrolment = await reconcileIfExpired(ctx, enrolment, now);
        if (!enrolment) return rejectedResult("heartbeat", "worker_not_found", null);
        if (enrolment.status !== "active") {
          return rejectedResult("heartbeat", "worker_not_active", enrolment);
        }
        await ctx.db.patch(enrolment._id, { lastHeartbeatAt: now, updatedAt: now });
        const updated = await ctx.db.get("workerEnrolments", enrolment._id);
        if (!updated) throw new Error("Heartbeated worker enrolment disappeared");
        return acceptedResult("heartbeat", updated);
      },
    );
  },
});

export const release = mutation({
  args: {
    ...serviceArgs,
    actorId: v.string(),
    clientId: v.string(),
    workerRef: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const owner = normalizeOwner(args);
    const workerRef = boundedIdentifier(args.workerRef, "Worker reference", limits.workerRef);
    const idempotencyKey = boundedIdentifier(
      args.idempotencyKey,
      "Idempotency key",
      limits.idempotencyKey,
    );
    const request = { workerRef };

    return withCommand(
      ctx,
      workspace._id,
      owner,
      idempotencyKey,
      "release",
      request,
      async () => {
        const now = Date.now();
        let enrolment = await ownedEnrolment(ctx, workspace._id, workerRef, owner);
        if (enrolment) enrolment = await reconcileIfExpired(ctx, enrolment, now);
        if (!enrolment) return rejectedResult("release", "worker_not_found", null);
        if (enrolment.status !== "active") {
          return rejectedResult("release", "worker_not_active", enrolment);
        }
        await settleAttachedCallsign(ctx, enrolment, "released", now);
        await ctx.db.patch(enrolment._id, {
          status: "released",
          releasedAt: now,
          updatedAt: now,
        });
        const updated = await ctx.db.get("workerEnrolments", enrolment._id);
        if (!updated) throw new Error("Released worker enrolment disappeared");
        return acceptedResult("release", updated);
      },
    );
  },
});

export const get = mutation({
  args: {
    ...serviceArgs,
    actorId: v.string(),
    clientId: v.string(),
    workerRef: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const owner = normalizeOwner(args);
    const workerRef = boundedIdentifier(args.workerRef, "Worker reference", limits.workerRef);
    let enrolment = await ownedEnrolment(ctx, workspace._id, workerRef, owner);
    if (!enrolment) return null;
    enrolment = await reconcileIfExpired(ctx, enrolment, Date.now());
    return publicWorker(enrolment);
  },
});

export const resolveCurrent = mutation({
  args: {
    ...serviceArgs,
    actorId: v.string(),
    clientId: v.string(),
    workerRef: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const owner = normalizeOwner(args);
    const workerRef = boundedIdentifier(args.workerRef, "Worker reference", limits.workerRef);
    let enrolment = await ownedEnrolment(ctx, workspace._id, workerRef, owner);
    if (!enrolment) return null;
    enrolment = await reconcileIfExpired(ctx, enrolment, Date.now());
    return enrolment.status === "active" ? publicWorker(enrolment) : null;
  },
});

export const expireScheduled = internalMutation({
  args: { enrolmentId: v.id("workerEnrolments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const enrolment = await ctx.db.get("workerEnrolments", args.enrolmentId);
    if (!enrolment || enrolment.status !== "active" || enrolment.expiresAt > Date.now()) return null;
    await expireEnrolment(ctx, enrolment, Date.now());
    return null;
  },
});

async function withCommand(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  owner: Owner,
  idempotencyKey: string,
  operation: Operation,
  request: unknown,
  execute: () => Promise<unknown>,
): Promise<unknown> {
  const existing = await ctx.db
    .query("workerEnrolmentCommands")
    .withIndex("by_workspace_owner_idempotency", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("actorId", owner.actorId)
        .eq("clientId", owner.clientId)
        .eq("idempotencyKey", idempotencyKey)
    )
    .unique();
  if (existing) {
    if (existing.operation !== operation || !sameCanonical(existing.request, request)) {
      throw new Error("Idempotency key was already used for a different worker enrolment command");
    }
    return existing.result;
  }
  const result = await execute();
  await ctx.db.insert("workerEnrolmentCommands", {
    workspaceId,
    actorId: owner.actorId,
    clientId: owner.clientId,
    idempotencyKey,
    operation,
    request,
    result,
    createdAt: Date.now(),
  });
  return result;
}

async function requiredWorkspace(ctx: MutationContext, workspaceValue: string | undefined) {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceValue));
  if (!workspace) throw new Error("Workspace does not exist");
  return workspace;
}

async function firstMissingProject(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  projectScope: string[],
): Promise<string | null> {
  for (const project of projectScope) {
    if (!await findProject(ctx, workspaceId, project)) return project;
  }
  return null;
}

async function activeEnrolmentForSession(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  owner: Owner,
  workerSessionId: string,
  now: number,
): Promise<WorkerEnrolment | null> {
  const candidates = await ctx.db
    .query("workerEnrolments")
    .withIndex("by_workspace_owner_session_status", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("actorId", owner.actorId)
        .eq("clientId", owner.clientId)
        .eq("workerSessionId", workerSessionId)
        .eq("status", "active")
    )
    .collect();
  const active: WorkerEnrolment[] = [];
  for (const candidate of candidates) {
    const reconciled = await reconcileIfExpired(ctx, candidate, now);
    if (reconciled.status === "active") active.push(reconciled);
  }
  if (active.length > 1) throw new Error("Worker session enrolment invariant violated");
  return active[0] ?? null;
}

async function ownedEnrolment(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  workerRef: string,
  owner: Pick<Owner, "actorId" | "clientId">,
): Promise<WorkerEnrolment | null> {
  const enrolment = await ctx.db
    .query("workerEnrolments")
    .withIndex("by_workspace_external", (q) =>
      q.eq("workspaceId", workspaceId).eq("externalId", workerRef)
    )
    .unique();
  if (!enrolment || enrolment.actorId !== owner.actorId || enrolment.clientId !== owner.clientId) {
    return null;
  }
  return enrolment;
}

async function reconcileIfExpired(
  ctx: MutationContext,
  enrolment: WorkerEnrolment,
  now: number,
): Promise<WorkerEnrolment> {
  if (enrolment.status !== "active" || enrolment.expiresAt > now) return enrolment;
  await expireEnrolment(ctx, enrolment, now);
  const updated = await ctx.db.get("workerEnrolments", enrolment._id);
  if (!updated) throw new Error("Expired worker enrolment disappeared");
  return updated;
}

async function expireEnrolment(
  ctx: MutationContext,
  enrolment: WorkerEnrolment,
  now: number,
): Promise<void> {
  await settleAttachedCallsign(ctx, enrolment, "expired", now);
  await ctx.db.patch(enrolment._id, {
    status: "expired",
    expiredAt: enrolment.expiresAt,
    updatedAt: now,
  });
}

async function planCallsign(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  requestedCallsign: string,
  enrolmentExpiresAt: number,
  now: number,
): Promise<
  | { outcome: "accepted"; plan: CallsignPlan }
  | { outcome: "rejected"; reason: "callsign_invalid" | "callsign_active_collision" | "callsign_lifetime_too_long" }
> {
  let canonical: ReturnType<typeof canonicalHostedCallsign>;
  try {
    canonical = canonicalHostedCallsign(requestedCallsign);
  } catch {
    return { outcome: "rejected", reason: "callsign_invalid" };
  }
  if (enrolmentExpiresAt - now > MAX_HOSTED_CALLSIGN_LEASE_SECONDS * 1_000) {
    return { outcome: "rejected", reason: "callsign_lifetime_too_long" };
  }
  const active = await currentCallsignLease(ctx, workspaceId, canonical.collisionKey, now);
  if (active) return { outcome: "rejected", reason: "callsign_active_collision" };
  return {
    outcome: "accepted",
    plan: {
      ...canonical,
      generation: await maximumCallsignGeneration(ctx, workspaceId, canonical.collisionKey) + 1,
    },
  };
}

async function currentCallsignLease(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  collisionKey: string,
  now: number,
): Promise<CallsignLease | null> {
  const candidates = await ctx.db
    .query("callsignLeases")
    .withIndex("by_workspace_collision_status", (q) =>
      q.eq("workspaceId", workspaceId).eq("collisionKey", collisionKey).eq("status", "active")
    )
    .collect();
  const active: CallsignLease[] = [];
  for (const candidate of candidates) {
    if (candidate.expiresAt <= now) {
      await ctx.db.patch(candidate._id, {
        status: "expired",
        expiredAt: candidate.expiresAt,
        updatedAt: now,
      });
    } else {
      active.push(candidate);
    }
  }
  if (active.length > 1) throw new Error(`Callsign collision invariant violated for ${collisionKey}`);
  return active[0] ?? null;
}

async function maximumCallsignGeneration(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  collisionKey: string,
): Promise<number> {
  const leases = await ctx.db
    .query("callsignLeases")
    .withIndex("by_workspace_collision_generation", (q) =>
      q.eq("workspaceId", workspaceId).eq("collisionKey", collisionKey)
    )
    .collect();
  return leases.reduce((maximum, lease) => Math.max(maximum, lease.generation), 0);
}

async function insertEnrolmentCallsignLease(
  ctx: MutationContext,
  input: {
    workspaceId: WorkspaceId;
    workerEnrolmentId: Id<"workerEnrolments">;
    workerSessionId: string;
    reservationRequestId: string;
    reservationFingerprint: string;
    expiresAtMs: number;
    now: number;
    plan: CallsignPlan;
  },
): Promise<Id<"callsignLeases">> {
  const leaseId = await ctx.db.insert("callsignLeases", {
    workspaceId: input.workspaceId,
    externalId: "pending",
    callsign: input.plan.display,
    collisionKey: input.plan.collisionKey,
    workerSessionId: input.workerSessionId,
    workerEnrolmentId: input.workerEnrolmentId,
    generation: input.plan.generation,
    status: "active",
    reservationRequestId: input.reservationRequestId,
    reservationFingerprint: input.reservationFingerprint,
    acceptedAt: input.now,
    expiresAt: input.expiresAtMs,
    lastHeartbeatAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await ctx.db.patch(leaseId, { externalId: `csl_${leaseId}` });
  await ctx.scheduler.runAt(input.expiresAtMs, expireCallsignLeaseRef, {
    leaseId,
    generation: input.plan.generation,
  });
  return leaseId;
}

async function settleAttachedCallsign(
  ctx: MutationContext,
  enrolment: WorkerEnrolment,
  outcome: "released" | "expired",
  now: number,
): Promise<void> {
  if (enrolment.callsignLeaseId === undefined || enrolment.callsignLeaseGeneration === undefined) return;
  const lease = await ctx.db.get("callsignLeases", enrolment.callsignLeaseId);
  if (!lease || lease.status !== "active") return;
  if (
    lease.workerEnrolmentId !== enrolment._id
    || lease.workerSessionId !== enrolment.workerSessionId
    || lease.generation !== enrolment.callsignLeaseGeneration
  ) {
    throw new Error("Worker callsign lease binding invariant violated");
  }
  if (lease.expiresAt <= now || outcome === "expired") {
    await ctx.db.patch(lease._id, {
      status: "expired",
      expiredAt: lease.expiresAt,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(lease._id, {
    status: "released",
    releasedAt: now,
    updatedAt: now,
  });
}

function normalizeOwner(args: {
  actorId: string;
  clientId: string;
  oauthAccountId?: string;
}): Owner {
  return {
    actorId: boundedIdentifier(args.actorId, "Actor ID", limits.actorId),
    clientId: boundedIdentifier(args.clientId, "Client ID", limits.clientId),
    oauthAccountId: args.oauthAccountId === undefined
      ? null
      : boundedIdentifier(args.oauthAccountId, "OAuth account ID", limits.oauthAccountId),
  };
}

function normalizeRequest(value: {
  version: 1;
  adapter: string;
  profile: string;
  workerSessionId: string;
  callsign: string | null;
  capabilities: string[];
  toolAllowlist: string[];
  projectScope: string[];
  preferredStances: string[];
  startedAt: string;
  expiresAt: string;
  heartbeatSeconds: number;
  correlationId: string | null;
  causationId: string | null;
  grantsAuthority: false;
  fingerprint: string;
}) {
  const startedAt = timestamp(value.startedAt, "Enrolment start");
  const expiresAt = timestamp(value.expiresAt, "Enrolment expiry");
  const heartbeatSeconds = heartbeatInterval(value.heartbeatSeconds);
  if (expiresAt.ms <= startedAt.ms) throw new Error("Enrolment expiry must be later than start");
  if (expiresAt.ms - startedAt.ms < heartbeatSeconds * 1_000) {
    throw new Error("Enrolment lifetime must include at least one heartbeat interval");
  }
  return {
    version: 1 as const,
    adapter: slug(value.adapter, "Runner adapter", limits.adapter),
    profile: slug(value.profile, "Runner profile", limits.profile),
    workerSessionId: boundedIdentifier(value.workerSessionId, "Worker session ID", limits.workerSessionId),
    callsign: value.callsign === null ? null : display(value.callsign, "Worker callsign", 80),
    capabilities: slugList(value.capabilities, "Capability", limits.capability, 1, limits.capabilities),
    toolAllowlist: slugList(value.toolAllowlist, "Tool", limits.tool, 0, limits.tools),
    projectScope: projectList(value.projectScope),
    preferredStances: slugList(
      value.preferredStances,
      "Preferred stance",
      limits.stance,
      0,
      limits.stances,
    ),
    startedAt: startedAt.value,
    startedAtMs: startedAt.ms,
    expiresAt: expiresAt.value,
    expiresAtMs: expiresAt.ms,
    heartbeatSeconds,
    correlationId: value.correlationId === null
      ? null
      : boundedIdentifier(value.correlationId, "Correlation ID", limits.relationId),
    causationId: value.causationId === null
      ? null
      : boundedIdentifier(value.causationId, "Causation ID", limits.relationId),
    grantsAuthority: false as const,
    fingerprint: fingerprint(value.fingerprint),
  };
}

function acceptedResult(operation: Operation, enrolment: WorkerEnrolment) {
  return {
    version: 1,
    operation,
    outcome: "accepted" as const,
    reason: null,
    worker: publicWorker(enrolment),
    grantsAuthority: false as const,
  };
}

function rejectedResult(operation: Operation, reason: RejectionReason, enrolment: WorkerEnrolment | null) {
  return {
    version: 1,
    operation,
    outcome: "rejected" as const,
    reason,
    worker: enrolment ? publicWorker(enrolment) : null,
    grantsAuthority: false as const,
  };
}

function publicWorker(enrolment: WorkerEnrolment) {
  return {
    workerRef: enrolment.externalId,
    adapter: enrolment.adapter,
    profile: enrolment.profile,
    workerSessionId: enrolment.workerSessionId,
    capabilities: enrolment.capabilities,
    toolAllowlist: enrolment.toolAllowlist,
    projectScope: enrolment.projectScope,
    preferredStances: enrolment.preferredStances,
    startedAt: new Date(enrolment.startedAt).toISOString(),
    expiresAt: new Date(enrolment.expiresAt).toISOString(),
    heartbeatSeconds: enrolment.heartbeatSeconds,
    correlationId: enrolment.correlationId ?? null,
    causationId: enrolment.causationId ?? null,
    requestFingerprint: enrolment.requestFingerprint,
    status: enrolment.status,
    acceptedAt: new Date(enrolment.acceptedAt).toISOString(),
    lastHeartbeatAt: new Date(enrolment.lastHeartbeatAt).toISOString(),
    releasedAt: enrolment.releasedAt === undefined ? null : new Date(enrolment.releasedAt).toISOString(),
    expiredAt: enrolment.expiredAt === undefined ? null : new Date(enrolment.expiredAt).toISOString(),
    callsign: enrolment.callsign ?? null,
    callsignLeaseId: enrolment.callsignLeaseId === undefined ? null : `csl_${enrolment.callsignLeaseId}`,
    callsignLeaseGeneration: enrolment.callsignLeaseGeneration ?? null,
    grantsAuthority: false as const,
  };
}

function boundedIdentifier(value: string, label: string, maximumLength: number): string {
  safe(value, label);
  const normalized = value.trim();
  if (!normalized || [...normalized].length > maximumLength || !identifierPattern.test(normalized)) {
    throw new Error(`${label} contains unsupported characters or exceeds ${maximumLength} characters`);
  }
  return normalized;
}

function display(value: string, label: string, maximumLength: number): string {
  safe(value, label);
  const normalized = value.trim().replace(/ {2,}/g, " ");
  if (!normalized || [...normalized].length > maximumLength) {
    throw new Error(`${label} must be between 1 and ${maximumLength} characters`);
  }
  return normalized;
}

function slug(value: string, label: string, maximumLength: number): string {
  safe(value, label);
  const normalized = value.trim().toLowerCase();
  if ([...normalized].length > maximumLength || !slugPattern.test(normalized)) {
    throw new Error(`${label} must be a lowercase slug`);
  }
  return normalized;
}

function slugList(
  values: string[],
  label: string,
  maximumEntryLength: number,
  minimumItems: number,
  maximumItems: number,
): string[] {
  if (values.length < minimumItems || values.length > maximumItems) {
    throw new Error(`${label} list must contain ${minimumItems} to ${maximumItems} entries`);
  }
  return sortedUnique(values.map((value) => slug(value, label, maximumEntryLength)), label);
}

function projectList(values: string[]): string[] {
  if (values.length < 1 || values.length > limits.projects) {
    throw new Error(`Project scope must contain 1 to ${limits.projects} entries`);
  }
  return sortedUnique(values.map((value) => {
    safe(value, "Project");
    const normalized = value.trim().toLowerCase();
    if ([...normalized].length > limits.project || !projectPattern.test(normalized)) {
      throw new Error("Project must be a lowercase project slug");
    }
    return normalized;
  }), "Project");
}

function sortedUnique(values: string[], label: string): string[] {
  const unique = [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (unique.length !== values.length) throw new Error(`${label} list contains duplicate entries`);
  return unique;
}

function timestamp(value: string, label: string): { value: string; ms: number } {
  safe(value, label);
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return { value: new Date(ms).toISOString(), ms };
}

function heartbeatInterval(value: number): number {
  if (!Number.isInteger(value) || value < 30 || value > 86_400) {
    throw new Error("Heartbeat interval must be an integer from 30 to 86400 seconds");
  }
  return value;
}

function fingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!fingerprintPattern.test(normalized)) {
    throw new Error("Worker enrolment fingerprint must be a SHA-256 fingerprint");
  }
  return normalized;
}

function safe(value: string, label: string): void {
  if (unsafeTextPattern.test(value)) throw new Error(`${label} contains unsupported control characters`);
}
