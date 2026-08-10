import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
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

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const slugPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

const canonicalEnrolmentValidator = v.object({
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
type WorkspaceId = Id<"workspaces">;
type Operation = "enrol" | "heartbeat" | "release";
type RejectionReason =
  | "callsign_join_pending"
  | "project_not_found"
  | "expired_request"
  | "active_session_exists"
  | "worker_not_found"
  | "worker_not_active";

export const enrol = mutation({
  args: {
    ...serviceArgs,
    actorId: v.string(),
    clientId: v.string(),
    oauthAccountId: v.optional(v.string()),
    request: canonicalEnrolmentValidator,
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const owner = normalizeOwner(args);
    const request = normalizeCanonicalEnrolment(args.request);
    const idempotencyKey = boundedIdentifier(
      args.idempotencyKey,
      "Idempotency key",
      limits.idempotencyKey,
    );
    const replay = await replayCommand(
      ctx,
      workspace._id,
      owner.actorId,
      owner.clientId,
      idempotencyKey,
      "enrol",
      request,
    );
    if (replay.found) return replay.result;

    const now = Date.now();
    if (request.callsign !== null) {
      const result = rejectedResult("enrol", "callsign_join_pending", null);
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "enrol",
        request,
        result,
        now,
      );
      return result;
    }

    const missingProject = await firstMissingProject(ctx, workspace._id, request.projectScope);
    if (missingProject !== null) {
      const result = {
        ...rejectedResult("enrol", "project_not_found", null),
        missingProject,
      };
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "enrol",
        request,
        result,
        now,
      );
      return result;
    }

    if (request.expiresAtMs <= now) {
      const result = rejectedResult("enrol", "expired_request", null);
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "enrol",
        request,
        result,
        now,
      );
      return result;
    }

    const active = await activeEnrolmentForSession(
      ctx,
      workspace._id,
      owner.actorId,
      owner.clientId,
      request.workerSessionId,
      now,
    );
    if (active) {
      const result = rejectedResult("enrol", "active_session_exists", active);
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "enrol",
        request,
        result,
        now,
      );
      return result;
    }

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
      acceptedAt: now,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(enrolmentId, { externalId: `wrk_${enrolmentId}` });
    await ctx.scheduler.runAt(request.expiresAtMs, expireEnrolmentRef, { enrolmentId });
    const enrolment = await ctx.db.get("workerEnrolments", enrolmentId);
    if (!enrolment) throw new Error("Accepted worker enrolment disappeared");
    const result = acceptedResult("enrol", enrolment);
    await storeCommand(
      ctx,
      workspace._id,
      owner.actorId,
      owner.clientId,
      idempotencyKey,
      "enrol",
      request,
      result,
      now,
    );
    return result;
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
    const replay = await replayCommand(
      ctx,
      workspace._id,
      owner.actorId,
      owner.clientId,
      idempotencyKey,
      "heartbeat",
      request,
    );
    if (replay.found) return replay.result;

    const now = Date.now();
    let enrolment = await ownedEnrolment(ctx, workspace._id, workerRef, owner);
    if (enrolment) enrolment = await reconcileIfExpired(ctx, enrolment, now);
    if (!enrolment) {
      const result = rejectedResult("heartbeat", "worker_not_found", null);
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "heartbeat",
        request,
        result,
        now,
      );
      return result;
    }
    if (enrolment.status !== "active") {
      const result = rejectedResult("heartbeat", "worker_not_active", enrolment);
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "heartbeat",
        request,
        result,
        now,
      );
      return result;
    }

    await ctx.db.patch(enrolment._id, { lastHeartbeatAt: now, updatedAt: now });
    const updated = await ctx.db.get("workerEnrolments", enrolment._id);
    if (!updated) throw new Error("Heartbeated worker enrolment disappeared");
    const result = acceptedResult("heartbeat", updated);
    await storeCommand(
      ctx,
      workspace._id,
      owner.actorId,
      owner.clientId,
      idempotencyKey,
      "heartbeat",
      request,
      result,
      now,
    );
    return result;
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
    const replay = await replayCommand(
      ctx,
      workspace._id,
      owner.actorId,
      owner.clientId,
      idempotencyKey,
      "release",
      request,
    );
    if (replay.found) return replay.result;

    const now = Date.now();
    let enrolment = await ownedEnrolment(ctx, workspace._id, workerRef, owner);
    if (enrolment) enrolment = await reconcileIfExpired(ctx, enrolment, now);
    if (!enrolment) {
      const result = rejectedResult("release", "worker_not_found", null);
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "release",
        request,
        result,
        now,
      );
      return result;
    }
    if (enrolment.status !== "active") {
      const result = rejectedResult("release", "worker_not_active", enrolment);
      await storeCommand(
        ctx,
        workspace._id,
        owner.actorId,
        owner.clientId,
        idempotencyKey,
        "release",
        request,
        result,
        now,
      );
      return result;
    }

    await ctx.db.patch(enrolment._id, { status: "released", releasedAt: now, updatedAt: now });
    const updated = await ctx.db.get("workerEnrolments", enrolment._id);
    if (!updated) throw new Error("Released worker enrolment disappeared");
    const result = acceptedResult("release", updated);
    await storeCommand(
      ctx,
      workspace._id,
      owner.actorId,
      owner.clientId,
      idempotencyKey,
      "release",
      request,
      result,
      now,
    );
    return result;
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
    if (!enrolment || enrolment.status !== "active" || enrolment.expiresAt > Date.now()) {
      return null;
    }
    await expireEnrolment(ctx, enrolment, Date.now());
    return null;
  },
});

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
  actorId: string,
  clientId: string,
  workerSessionId: string,
  now: number,
): Promise<WorkerEnrolment | null> {
  const candidates = await ctx.db
    .query("workerEnrolments")
    .withIndex("by_workspace_owner_session_status", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("actorId", actorId)
        .eq("clientId", clientId)
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
  owner: { actorId: string; clientId: string },
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
  await ctx.db.patch(enrolment._id, {
    status: "expired",
    expiredAt: enrolment.expiresAt,
    updatedAt: now,
  });
}

async function replayCommand(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  actorId: string,
  clientId: string,
  idempotencyKey: string,
  operation: Operation,
  request: unknown,
): Promise<{ found: boolean; result: unknown }> {
  const existing = await ctx.db
    .query("workerEnrolmentCommands")
    .withIndex("by_workspace_owner_idempotency", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("actorId", actorId)
        .eq("clientId", clientId)
        .eq("idempotencyKey", idempotencyKey)
    )
    .unique();
  if (!existing) return { found: false, result: null };
  if (existing.operation !== operation || !sameCanonical(existing.request, request)) {
    throw new Error("Idempotency key was already used for a different worker enrolment command");
  }
  return { found: true, result: existing.result };
}

async function storeCommand(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  actorId: string,
  clientId: string,
  idempotencyKey: string,
  operation: Operation,
  request: unknown,
  result: unknown,
  createdAt: number,
): Promise<void> {
  await ctx.db.insert("workerEnrolmentCommands", {
    workspaceId,
    actorId,
    clientId,
    idempotencyKey,
    operation,
    request,
    result,
    createdAt,
  });
}

function normalizeOwner(args: {
  actorId: string;
  clientId: string;
  oauthAccountId?: string;
}): { actorId: string; clientId: string; oauthAccountId: string | null } {
  return {
    actorId: boundedIdentifier(args.actorId, "Actor ID", limits.actorId),
    clientId: boundedIdentifier(args.clientId, "Client ID", limits.clientId),
    oauthAccountId: args.oauthAccountId === undefined
      ? null
      : boundedIdentifier(args.oauthAccountId, "OAuth account ID", limits.oauthAccountId),
  };
}

function normalizeCanonicalEnrolment(value: {
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
  const startedAt = canonicalTimestamp(value.startedAt, "Enrolment start");
  const expiresAt = canonicalTimestamp(value.expiresAt, "Enrolment expiry");
  if (expiresAt.milliseconds <= startedAt.milliseconds) {
    throw new Error("Enrolment expiry must be later than start");
  }
  const heartbeatSeconds = canonicalHeartbeat(value.heartbeatSeconds);
  if (expiresAt.milliseconds - startedAt.milliseconds < heartbeatSeconds * 1_000) {
    throw new Error("Enrolment lifetime must include at least one heartbeat interval");
  }
  const callsign = value.callsign === null ? null : canonicalDisplay(value.callsign, "Worker callsign", 80);
  return {
    version: 1 as const,
    adapter: canonicalSlug(value.adapter, "Runner adapter", limits.adapter),
    profile: canonicalSlug(value.profile, "Runner profile", limits.profile),
    workerSessionId: canonicalIdentifier(
      value.workerSessionId,
      "Worker session ID",
      limits.workerSessionId,
    ),
    callsign,
    capabilities: canonicalSlugList(
      value.capabilities,
      "Capability",
      limits.capability,
      1,
      limits.capabilities,
    ),
    toolAllowlist: canonicalSlugList(value.toolAllowlist, "Tool", limits.tool, 0, limits.tools),
    projectScope: canonicalProjectList(value.projectScope),
    preferredStances: canonicalSlugList(
      value.preferredStances,
      "Preferred stance",
      limits.stance,
      0,
      limits.stances,
    ),
    startedAt: startedAt.value,
    startedAtMs: startedAt.milliseconds,
    expiresAt: expiresAt.value,
    expiresAtMs: expiresAt.milliseconds,
    heartbeatSeconds,
    correlationId: value.correlationId === null
      ? null
      : canonicalIdentifier(value.correlationId, "Correlation ID", limits.relationId),
    causationId: value.causationId === null
      ? null
      : canonicalIdentifier(value.causationId, "Causation ID", limits.relationId),
    grantsAuthority: false as const,
    fingerprint: canonicalFingerprint(value.fingerprint),
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

function rejectedResult(
  operation: Operation,
  reason: RejectionReason,
  enrolment: WorkerEnrolment | null,
) {
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
    callsign: null,
    callsignLeaseId: null,
    callsignLeaseGeneration: null,
    grantsAuthority: false as const,
  };
}

function boundedIdentifier(value: string, label: string, maximumLength: number): string {
  if (unsafeTextPattern.test(value)) throw new Error(`${label} contains unsupported control characters`);
  const normalized = value.trim();
  if (!normalized || [...normalized].length > maximumLength || !identifierPattern.test(normalized)) {
    throw new Error(`${label} contains unsupported characters or exceeds ${maximumLength} characters`);
  }
  return normalized;
}

function canonicalIdentifier(value: string, label: string, maximumLength: number): string {
  const normalized = boundedIdentifier(value, label, maximumLength);
  if (value !== normalized) throw new Error(`${label} must already be canonical`);
  return normalized;
}

function canonicalDisplay(value: string, label: string, maximumLength: number): string {
  if (unsafeTextPattern.test(value)) throw new Error(`${label} contains unsupported control characters`);
  const normalized = value.trim().replace(/ {2,}/g, " ");
  if (!normalized || [...normalized].length > maximumLength) {
    throw new Error(`${label} must be between 1 and ${maximumLength} characters`);
  }
  if (value !== normalized) throw new Error(`${label} must already be canonical`);
  return normalized;
}

function canonicalSlug(value: string, label: string, maximumLength: number): string {
  if (unsafeTextPattern.test(value)) throw new Error(`${label} contains unsupported control characters`);
  if (
    value.length === 0
    || [...value].length > maximumLength
    || !slugPattern.test(value)
    || value !== value.toLowerCase()
  ) {
    throw new Error(`${label} must already be a canonical lowercase slug`);
  }
  return value;
}

function canonicalSlugList(
  values: string[],
  label: string,
  maximumEntryLength: number,
  minimumItems: number,
  maximumItems: number,
): string[] {
  if (values.length < minimumItems || values.length > maximumItems) {
    throw new Error(`${label} list must contain ${minimumItems} to ${maximumItems} entries`);
  }
  const canonical = values.map((value) => canonicalSlug(value, label, maximumEntryLength));
  return requireSortedUnique(canonical, `${label} list`);
}

function canonicalProjectList(values: string[]): string[] {
  if (values.length < 1 || values.length > limits.projects) {
    throw new Error(`Project scope must contain 1 to ${limits.projects} entries`);
  }
  const canonical = values.map((value) => {
    if (
      unsafeTextPattern.test(value)
      || [...value].length > limits.project
      || !projectPattern.test(value)
      || value !== value.toLowerCase()
    ) {
      throw new Error("Project scope must contain canonical lowercase project slugs");
    }
    return value;
  });
  return requireSortedUnique(canonical, "Project scope");
}

function requireSortedUnique(values: string[], label: string): string[] {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      throw new Error(`${label} must be sorted and unique`);
    }
  }
  return values;
}

function canonicalTimestamp(value: string, label: string): { value: string; milliseconds: number } {
  if (unsafeTextPattern.test(value) || !timestampPattern.test(value)) {
    throw new Error(`${label} must be a canonical ISO-8601 UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a valid canonical ISO-8601 UTC timestamp`);
  }
  return { value, milliseconds };
}

function canonicalHeartbeat(value: number): number {
  if (!Number.isInteger(value) || value < 30 || value > 86_400) {
    throw new Error("Heartbeat interval must be an integer from 30 to 86400 seconds");
  }
  return value;
}

function canonicalFingerprint(value: string): string {
  if (!fingerprintPattern.test(value)) {
    throw new Error("Worker enrolment fingerprint must be a SHA-256 fingerprint");
  }
  return value;
}
