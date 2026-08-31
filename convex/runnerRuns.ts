import { v } from "convex/values";
import {
  runnerProfileClaimMatchesV1,
  runnerProfileProvenanceV1,
} from "../src/runner-profile-provenance";
import type { Doc, Id } from "./_generated/dataModel";
import {
  appendEvent,
  assertLeaseSeconds,
  assertSlug,
  assertText,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
  type MutationContext,
} from "./lib/domain";
import {
  appendExecutionActualEvent,
  executionActualValidator,
  normalizeExecutionActual,
  readHostedRunExecution,
  sameCanonical,
} from "./lib/executionEnvelope";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs, type ActorInput } from "./lib/validators";

const runStatusValidator = v.union(
  v.literal("queued"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("blocked"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("abandoned"),
);
const runCommandValidator = v.union(
  v.literal("start"),
  v.literal("run"),
  v.literal("wait"),
  v.literal("block"),
  v.literal("resume"),
  v.literal("succeed"),
  v.literal("fail"),
  v.literal("retry"),
  v.literal("cancel"),
);
const usageValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  toolCalls: v.optional(v.number()),
  childAgents: v.optional(v.number()),
});
const concurrencyValidator = v.object({
  globalLimit: v.number(),
  projectLimit: v.number(),
});

type QueuedRun = Doc<"queuedRuns">;
type RunStatus = QueuedRun["status"];
type RunCommand =
  | "start"
  | "run"
  | "wait"
  | "block"
  | "resume"
  | "succeed"
  | "fail"
  | "retry"
  | "cancel";
type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  childAgents?: number;
};

const ACTIVE_CAPACITY_STATUSES = ["starting", "running", "waiting"] as const;
const EXPIRING_STATUSES = ["queued", ...ACTIVE_CAPACITY_STATUSES] as const;
const LEASED_STATUSES = new Set<RunStatus>(["queued", ...ACTIVE_CAPACITY_STATUSES]);
const TERMINAL_STATUSES = new Set<RunStatus>(["succeeded", "cancelled", "abandoned"]);
const CANDIDATE_SCAN_LIMIT = 100;
const LIST_LIMIT = 100;
const RECONCILE_LIMIT_PER_STATUS = 100;
const INCOMPLETE_CANDIDATE_SCAN = "runner_candidate_scan_incomplete";
const INCOMPLETE_LIST_SCAN = "runner_list_scan_incomplete";
const INCOMPLETE_RECONCILIATION = "runner_reconciliation_incomplete";

export const claim = mutation({
  args: {
    ...serviceArgs,
    actor: actorValidator,
    runnerType: v.string(),
    runnerProfile: v.string(),
    runnerProfileVersion: v.optional(v.union(v.string(), v.null())),
    project: v.optional(v.string()),
    runId: v.optional(v.string()),
    externalRunId: v.optional(v.string()),
    leaseSeconds: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    concurrency: v.optional(concurrencyValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeClaim(args);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const request = claimRequest(input);
    const replay = await replayCommand(
      ctx,
      workspace._id,
      input.idempotencyKey,
      "claim",
      request,
    );
    if (replay.found) return replay.result;

    const now = Date.now();
    await reconcileExpiredRuns(ctx, workspace._id, now);
    const capacity = await readWorkspaceCapacity(ctx, workspace._id, now, input.globalLimit);
    if (!capacity.available) {
      return null;
    }

    const project = input.project
      ? await findProject(ctx, workspace._id, input.project)
      : null;
    if (input.project && !project) {
      return null;
    }
    const candidatePools = await readClaimCandidates(ctx, {
      workspaceId: workspace._id,
      projectId: project?._id,
      runnerType: input.runnerType,
      runnerProfile: input.runnerProfile,
      runnerProfileVersion: input.runnerProfileVersion,
      runId: input.runId,
      now,
    });
    let run = availableCandidate(
      candidatePools.failed.candidates,
      capacity.projectCounts,
      input.projectLimit,
    );
    if (!run && candidatePools.failed.truncated) {
      throw new Error(INCOMPLETE_CANDIDATE_SCAN);
    }
    run ??= availableCandidate(
      candidatePools.queued.candidates,
      capacity.projectCounts,
      input.projectLimit,
    );
    if (!run && candidatePools.queued.truncated) {
      throw new Error(INCOMPLETE_CANDIDATE_SCAN);
    }
    if (!run) {
      return null;
    }

    const item = await ctx.db.get("items", run.itemId);
    if (!item) throw new Error(`Run item ${String(run.itemId)} does not exist`);
    const retrying = run.status === "failed";
    const itemAvailable = item.status === "ready"
      || item.status === "active"
      || (retrying && item.status === "blocked");
    const itemHolderAvailable = item.claimedByExternalId === undefined
      || item.claimedByExternalId === input.actor.id
      || item.claimedByExternalId === run.actorExternalId
      || (item.claimExpiresAt !== undefined && item.claimExpiresAt <= now);
    if (!itemAvailable || !itemHolderAvailable) {
      throw new Error("Run item is actively claimed by another actor");
    }

    const actor = await upsertActor(ctx, workspace._id, input.actor);
    if (!actor) throw new Error("Failed to create runner actor");
    const leaseExpiresAt = now + input.leaseSeconds * 1_000;
    const generation = run.generation + 1;
    const leaseGeneration = run.leaseGeneration + 1;
    await ctx.db.patch(run._id, {
      actorId: actor._id,
      actorExternalId: actor.externalId,
      externalRunId: input.externalRunId ?? run.externalRunId,
      status: "starting",
      generation,
      leaseGeneration,
      leaseOwnerExternalId: actor.externalId,
      leaseExpiresAt,
      lastHeartbeatAt: undefined,
      outcome: undefined,
      nextRetryAt: undefined,
      updatedAt: now,
      startedAt: now,
      endedAt: undefined,
    });
    await ctx.db.patch(item._id, {
      status: "active",
      claimedByActorId: actor._id,
      claimedByExternalId: actor.externalId,
      claimExpiresAt: leaseExpiresAt,
      version: item.version + 1,
      updatedAt: now,
    });
    await appendRunEvent(ctx, run, actor._id, actor.externalId, {
      type: retrying ? "run.retry_starting" : "run.starting",
      payload: {
        runId: run.externalId,
        source: "generic_runner_claim",
        runnerType: run.runnerType,
        runnerProfile: run.runnerProfile,
        runnerProfileVersion: run.runnerProfileVersion ?? null,
        generation,
        leaseGeneration,
        leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
        previousActorId: run.actorExternalId,
        concurrency: {
          globalLimit: input.globalLimit,
          projectLimit: input.projectLimit,
        },
        ...(input.externalRunId ? { externalRunId: input.externalRunId } : {}),
        ...(retrying ? { retryAttempt: run.retryAttempt } : {}),
      },
      now,
    });
    const updated = await requiredRun(ctx, workspace._id, run.externalId);
    const result = await publicQueuedRun(ctx, updated, item.externalId);
    await storeCommand(ctx, workspace._id, input.idempotencyKey, "claim", request, result, now);
    return result;
  },
});

export const get = mutation({
  args: { ...serviceArgs, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const id = requiredText(args.id, "Run ID", 240);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Run ${id} does not exist`);
    let run = await requiredRun(ctx, workspace._id, id);
    run = await reconcileRunIfExpired(ctx, run, Date.now());
    const item = await ctx.db.get("items", run.itemId);
    if (!item) throw new Error("Run item no longer exists");
    return await publicQueuedRun(ctx, run, item.externalId);
  },
});

export const reconcile = mutation({
  args: serviceArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    await reconcileExpiredRuns(ctx, workspace._id, Date.now());
    return null;
  },
});

export const list = mutation({
  args: {
    ...serviceArgs,
    itemId: v.optional(v.string()),
    actorId: v.optional(v.string()),
    status: v.optional(runStatusValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const itemExternalId = optionalText(args.itemId, "Item ID", 240);
    const actorId = optionalText(args.actorId, "Actor ID", 120);
    await reconcileExpiredRuns(ctx, workspace._id, Date.now());

    let itemId: Id<"items"> | undefined;
    if (itemExternalId) {
      const item = await ctx.db
        .query("items")
        .withIndex("by_workspace_external", (q) =>
          q.eq("workspaceId", workspace._id).eq("externalId", itemExternalId)
        )
        .unique();
      if (!item) return [];
      itemId = item._id;
    }

    let rows: QueuedRun[];
    if (itemId) {
      rows = await ctx.db
        .query("queuedRuns")
        .withIndex("by_item_id_and_created_at", (q) => q.eq("itemId", itemId))
        .order("desc")
        .take(LIST_LIMIT + 1);
    } else if (actorId) {
      rows = await ctx.db
        .query("queuedRuns")
        .withIndex("by_workspace_id_and_actor_external_id_and_created_at", (q) =>
          q.eq("workspaceId", workspace._id).eq("actorExternalId", actorId)
        )
        .order("desc")
        .take(LIST_LIMIT + 1);
    } else if (args.status) {
      rows = await ctx.db
        .query("queuedRuns")
        .withIndex("by_workspace_id_and_status_and_created_at", (q) =>
          q.eq("workspaceId", workspace._id).eq("status", args.status!)
        )
        .order("desc")
        .take(LIST_LIMIT + 1);
    } else {
      rows = await ctx.db
        .query("queuedRuns")
        .withIndex("by_workspace_id_and_created_at", (q) => q.eq("workspaceId", workspace._id))
        .order("desc")
        .take(LIST_LIMIT + 1);
    }
    if (rows.length > LIST_LIMIT) throw new Error(INCOMPLETE_LIST_SCAN);
    const filtered = rows.filter((run) =>
      (!actorId || run.actorExternalId === actorId)
      && (!args.status || run.status === args.status)
    );
    return await Promise.all(filtered.map(async (run) => {
      const item = await ctx.db.get("items", run.itemId);
      if (!item) throw new Error("Run item no longer exists");
      return await publicQueuedRun(ctx, run, item.externalId);
    }));
  },
});

export const heartbeat = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    expectedGeneration: v.number(),
    expectedLeaseGeneration: v.number(),
    leaseSeconds: v.optional(v.number()),
    checkpoint: v.optional(v.string()),
    usage: v.optional(usageValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeHeartbeat(args);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Run ${input.id} does not exist`);
    const request = heartbeatRequest(input);
    const replay = await replayCommand(
      ctx,
      workspace._id,
      input.idempotencyKey,
      "heartbeat",
      request,
    );
    if (replay.found) return replay.result;

    const run = await requiredRun(ctx, workspace._id, input.id);
    const now = Date.now();
    requireGeneration(run, input.expectedGeneration);
    requireLiveLease(run, input.actor.id, input.expectedLeaseGeneration, now);
    if (!["starting", "running", "waiting"].includes(run.status)) {
      throw new Error(`Run cannot heartbeat while ${run.status}`);
    }
    const item = await ctx.db.get("items", run.itemId);
    if (
      !item
      || item.status !== "active"
      || item.claimedByExternalId !== input.actor.id
    ) {
      throw new Error("Run heartbeat cannot renew an item held by another actor");
    }
    const heartbeatActor = await upsertActor(ctx, workspace._id, input.actor);
    if (!heartbeatActor) throw new Error("Failed to create heartbeat actor");
    const leaseExpiresAt = now + input.leaseSeconds * 1_000;
    const usage = mergeUsage(run.usage, input.usage);
    await ctx.db.patch(run._id, {
      leaseExpiresAt,
      lastHeartbeatAt: now,
      checkpoint: input.checkpoint ?? run.checkpoint,
      usage,
      updatedAt: now,
    });
    await ctx.db.patch(item._id, {
      claimExpiresAt: leaseExpiresAt,
      version: item.version + 1,
      updatedAt: now,
    });
    await appendRunEvent(ctx, run, heartbeatActor._id, input.actor.id, {
      type: "run.heartbeat",
      payload: {
        runId: run.externalId,
        generation: run.generation,
        leaseGeneration: run.leaseGeneration,
        leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        usage,
      },
      now,
    });
    const updated = await requiredRun(ctx, workspace._id, run.externalId);
    const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
    await appendEnvelopeReference(
      ctx,
      updated,
      execution.executionEnvelope,
      "run.heartbeat",
      now,
    );
    const result = publicQueuedRunProjection(updated, item.externalId, execution);
    await storeCommand(
      ctx,
      workspace._id,
      input.idempotencyKey,
      "heartbeat",
      request,
      result,
      now,
    );
    return result;
  },
});

export const transition = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    command: runCommandValidator,
    expectedGeneration: v.number(),
    expectedLeaseGeneration: v.number(),
    leaseSeconds: v.optional(v.number()),
    checkpoint: v.optional(v.string()),
    outcome: v.optional(v.string()),
    continuationRef: v.optional(v.string()),
    usage: v.optional(usageValidator),
    executionActual: v.optional(executionActualValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeTransition(args);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Run ${input.id} does not exist`);
    const request = transitionRequest(input);
    const replay = await replayCommand(
      ctx,
      workspace._id,
      input.idempotencyKey,
      input.command,
      request,
    );
    if (replay.found) return replay.result;

    const run = await requiredRun(ctx, workspace._id, input.id);
    requireGeneration(run, input.expectedGeneration);
    if (run.leaseGeneration !== input.expectedLeaseGeneration) {
      throw new Error(
        `Run lease generation changed from ${input.expectedLeaseGeneration} to ${run.leaseGeneration}`,
      );
    }
    if (
      TERMINAL_STATUSES.has(run.status)
      || (run.status === "failed" && run.nextRetryAt === undefined)
    ) {
      throw new Error(`Run cannot ${input.command} while ${run.status}`);
    }

    const now = Date.now();
    const transitionActor = await upsertActor(ctx, workspace._id, input.actor);
    if (!transitionActor) throw new Error("Failed to create transition actor");
    const next = nextRunState(run, input, now);
    const item = await ctx.db.get("items", run.itemId);
    if (!item) throw new Error("Run item no longer exists");
    requireProjectableItem(item, run, next, input, now);

    await ctx.db.patch(run._id, {
      status: next.status,
      generation: next.generation,
      leaseGeneration: next.leaseGeneration,
      leaseOwnerExternalId: next.leaseOwnerExternalId,
      leaseExpiresAt: next.leaseExpiresAt,
      lastHeartbeatAt: next.lastHeartbeatAt,
      checkpoint: next.checkpoint,
      outcome: next.outcome,
      continuationRef: next.continuationRef,
      usage: next.usage,
      retryAttempt: next.retryAttempt,
      nextRetryAt: next.nextRetryAt,
      updatedAt: now,
      startedAt: next.startedAt,
      endedAt: next.endedAt,
    });
    await projectItem(ctx, item, run, next, input, now);

    const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
    let executionRecords = execution.executionRecords;
    if (["succeed", "fail", "cancel"].includes(input.command)) {
      if (!execution.executionEnvelope && input.executionActualProvided) {
        throw new Error("Historical run has no execution envelope and cannot accept execution actuals");
      }
      if (execution.executionEnvelope) {
        const appended = await appendExecutionActualEvent(ctx, {
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          itemId: run.itemId,
          actorId: transitionActor._id,
          actorExternalId: input.actor.id,
          runId: run.externalId,
          runGeneration: next.generation,
          leaseGeneration: next.leaseGeneration,
          transition: input.command,
          actual: input.executionActual,
          createdAt: now,
        });
        executionRecords = [...executionRecords, appended];
      }
    }
    const eventType = input.command === "retry" ? "run.retry_queued" : `run.${next.status}`;
    await appendRunEvent(ctx, run, transitionActor._id, input.actor.id, {
      type: eventType,
      payload: {
        runId: run.externalId,
        command: input.command,
        fromStatus: run.status,
        toStatus: next.status,
        generation: next.generation,
        leaseGeneration: next.leaseGeneration,
        retryAttempt: next.retryAttempt,
        ...(next.leaseExpiresAt
          ? { leaseExpiresAt: new Date(next.leaseExpiresAt).toISOString() }
          : {}),
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
      },
      now,
    });
    const updated = await requiredRun(ctx, workspace._id, run.externalId);
    await appendEnvelopeReference(
      ctx,
      updated,
      execution.executionEnvelope,
      eventType,
      now,
    );
    const result = publicQueuedRunProjection(updated, item.externalId, {
      executionEnvelope: execution.executionEnvelope,
      executionRecords,
    });
    await storeCommand(
      ctx,
      workspace._id,
      input.idempotencyKey,
      input.command,
      request,
      result,
      now,
    );
    return result;
  },
});

async function readClaimCandidates(
  ctx: MutationContext,
  input: {
    workspaceId: Id<"workspaces">;
    projectId?: Id<"projects">;
    runnerType: string;
    runnerProfile: string;
    runnerProfileVersion: string | null;
    runId?: string;
    now: number;
  },
): Promise<{
  failed: { candidates: QueuedRun[]; truncated: boolean };
  queued: { candidates: QueuedRun[]; truncated: boolean };
}> {
  if (input.runId) {
    const exact = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", input.workspaceId).eq("externalId", input.runId!)
      )
      .unique();
    const empty = { candidates: [], truncated: false };
    if (!exact || !claimEligible(exact, input)) return { failed: empty, queued: empty };
    return exact.status === "failed"
      ? { failed: { candidates: [exact], truncated: false }, queued: empty }
      : { failed: empty, queued: { candidates: [exact], truncated: false } };
  }

  let failed: QueuedRun[];
  let queued: QueuedRun[];
  if (input.projectId) {
    failed = await ctx.db
      .query("queuedRuns")
      .withIndex("by_project_id_and_status_and_next_retry_at", (q) =>
        q.eq("projectId", input.projectId!)
          .eq("status", "failed")
          .gt("nextRetryAt", 0)
          .lte("nextRetryAt", input.now)
      )
      .order("asc")
      .take(CANDIDATE_SCAN_LIMIT + 1);
    queued = await ctx.db
      .query("queuedRuns")
      .withIndex("by_project_id_and_status_and_created_at", (q) =>
        q.eq("projectId", input.projectId!)
          .eq("status", "queued")
      )
      .order("asc")
      .take(CANDIDATE_SCAN_LIMIT + 1);
  } else {
    failed = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_id_and_status_and_next_retry_at", (q) =>
        q.eq("workspaceId", input.workspaceId)
          .eq("status", "failed")
          .gt("nextRetryAt", 0)
          .lte("nextRetryAt", input.now)
      )
      .order("asc")
      .take(CANDIDATE_SCAN_LIMIT + 1);
    queued = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_id_and_status_and_created_at", (q) =>
        q.eq("workspaceId", input.workspaceId)
          .eq("status", "queued")
      )
      .order("asc")
      .take(CANDIDATE_SCAN_LIMIT + 1);
  }
  return {
    failed: candidatePool(failed, input),
    queued: candidatePool(queued, input),
  };
}

function candidatePool(
  rows: QueuedRun[],
  input: {
    projectId?: Id<"projects">;
    runnerType: string;
    runnerProfile: string;
    runnerProfileVersion: string | null;
    now: number;
  },
) {
  return {
    candidates: rows.slice(0, CANDIDATE_SCAN_LIMIT)
      .filter((run) => claimEligible(run, input)),
    truncated: rows.length > CANDIDATE_SCAN_LIMIT,
  };
}

function availableCandidate(
  candidates: QueuedRun[],
  projectCounts: Map<string, number>,
  projectLimit: number,
): QueuedRun | null {
  return candidates.find((candidate) =>
    (projectCounts.get(String(candidate.projectId)) ?? 0) < projectLimit
  ) ?? null;
}

function claimEligible(
  run: QueuedRun,
  input: {
    projectId?: Id<"projects">;
    runnerType: string;
    runnerProfile: string;
    runnerProfileVersion: string | null;
    now: number;
  },
): boolean {
  if (
    run.runnerType !== input.runnerType
    || !runnerProfileClaimMatchesV1(
      runnerProfileProvenanceV1(run.runnerProfile, run.runnerProfileVersion),
      runnerProfileProvenanceV1(input.runnerProfile, input.runnerProfileVersion),
    )
    || (input.projectId && run.projectId !== input.projectId)
  ) return false;
  if (run.status === "queued") {
    return run.leaseExpiresAt === undefined || run.leaseExpiresAt > input.now;
  }
  return run.status === "failed"
    && run.nextRetryAt !== undefined
    && run.nextRetryAt <= input.now
    && run.retryAttempt < run.maxAttempts;
}

async function readWorkspaceCapacity(
  ctx: MutationContext,
  workspaceId: Id<"workspaces">,
  now: number,
  limit: number,
): Promise<{ available: boolean; projectCounts: Map<string, number> }> {
  let count = 0;
  const projectCounts = new Map<string, number>();
  for (const status of ACTIVE_CAPACITY_STATUSES) {
    const remaining = limit - count;
    if (remaining <= 0) return { available: false, projectCounts };
    const leased = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_id_and_status_and_lease_expires_at", (q) =>
        q.eq("workspaceId", workspaceId)
          .eq("status", status)
          .gt("leaseExpiresAt", now)
      )
      .take(remaining);
    for (const run of leased) increment(projectCounts, String(run.projectId));
    count += leased.length;
    if (count >= limit) return { available: false, projectCounts };
    const missingLease = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_id_and_status_and_lease_expires_at", (q) =>
        q.eq("workspaceId", workspaceId)
          .eq("status", status)
          .eq("leaseExpiresAt", undefined)
      )
      .take(limit - count);
    for (const run of missingLease) increment(projectCounts, String(run.projectId));
    count += missingLease.length;
    if (count >= limit) return { available: false, projectCounts };
  }
  return { available: true, projectCounts };
}

async function reconcileExpiredRuns(
  ctx: MutationContext,
  workspaceId: Id<"workspaces">,
  now: number,
): Promise<void> {
  for (const status of EXPIRING_STATUSES) {
    const rows = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_id_and_status_and_lease_expires_at", (q) =>
        q.eq("workspaceId", workspaceId)
          .eq("status", status)
          .gt("leaseExpiresAt", 0)
          .lte("leaseExpiresAt", now)
      )
      .take(RECONCILE_LIMIT_PER_STATUS + 1);
    if (rows.length > RECONCILE_LIMIT_PER_STATUS) {
      throw new Error(INCOMPLETE_RECONCILIATION);
    }
    for (const run of rows) await reconcileRunIfExpired(ctx, run, now);
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

async function reconcileRunIfExpired(
  ctx: MutationContext,
  run: QueuedRun,
  now: number,
): Promise<QueuedRun> {
  if (
    !LEASED_STATUSES.has(run.status)
    || run.leaseExpiresAt === undefined
    || run.leaseExpiresAt > now
  ) return run;
  const queued = run.status === "queued";
  const holder = run.leaseOwnerExternalId ?? run.actorExternalId;
  const outcome = queued
    ? "Run lease expired before a runner claimed it."
    : "Run lease expired without a heartbeat.";
  await ctx.db.patch(run._id, {
    status: "abandoned",
    generation: run.generation + 1,
    leaseOwnerExternalId: undefined,
    leaseExpiresAt: undefined,
    outcome,
    nextRetryAt: undefined,
    updatedAt: now,
    endedAt: now,
  });
  const item = await ctx.db.get("items", run.itemId);
  const itemClaimReleased = Boolean(
    item
    && item.status === "active"
    && item.claimedByExternalId === holder,
  );
  if (item && itemClaimReleased) {
    await ctx.db.patch(item._id, {
      status: "ready",
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
      version: item.version + 1,
      updatedAt: now,
    });
  } else if (item) {
    await ctx.db.patch(item._id, {
      version: item.version + 1,
      updatedAt: now,
    });
  }
  await appendRunEvent(ctx, run, undefined, undefined, {
    type: "run.abandoned",
    payload: {
      runId: run.externalId,
      fromStatus: run.status,
      generation: run.generation + 1,
      leaseGeneration: run.leaseGeneration,
      reason: queued ? "queue_lease_expired" : "lease_expired",
      itemClaimReleased,
    },
    now,
  });
  return {
    ...run,
    status: "abandoned",
    generation: run.generation + 1,
    leaseOwnerExternalId: undefined,
    leaseExpiresAt: undefined,
    outcome,
    nextRetryAt: undefined,
    updatedAt: now,
    endedAt: now,
  };
}

function nextRunState(
  current: QueuedRun,
  input: ReturnType<typeof normalizeTransition>,
  now: number,
) {
  const common = {
    status: current.status,
    generation: current.generation + 1,
    leaseGeneration: current.leaseGeneration,
    leaseOwnerExternalId: current.leaseOwnerExternalId,
    leaseExpiresAt: current.leaseExpiresAt,
    lastHeartbeatAt: current.lastHeartbeatAt,
    checkpoint: input.checkpoint ?? current.checkpoint,
    outcome: input.outcome ?? current.outcome,
    continuationRef: input.continuationRef ?? current.continuationRef,
    usage: mergeUsage(current.usage, input.usage),
    retryAttempt: current.retryAttempt,
    nextRetryAt: current.nextRetryAt,
    startedAt: current.startedAt,
    endedAt: current.endedAt,
  };
  if (input.command === "start") {
    requireStatus(current, ["queued"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return { ...common, status: "starting" as const, startedAt: current.startedAt ?? now };
  }
  if (input.command === "run") {
    requireStatus(current, ["starting"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return { ...common, status: "running" as const, lastHeartbeatAt: now };
  }
  if (input.command === "wait") {
    requireStatus(current, ["running"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return { ...common, status: "waiting" as const, lastHeartbeatAt: now };
  }
  if (input.command === "block") {
    requireStatus(current, ["starting", "running", "waiting"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return {
      ...common,
      status: "blocked" as const,
      leaseOwnerExternalId: undefined,
      leaseExpiresAt: undefined,
      lastHeartbeatAt: now,
    };
  }
  if (input.command === "resume") {
    requireStatus(current, ["waiting", "blocked"], input.command);
    if (current.status === "waiting") {
      requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
      return { ...common, status: "running" as const, lastHeartbeatAt: now };
    }
    return {
      ...common,
      status: "running" as const,
      leaseGeneration: current.leaseGeneration + 1,
      leaseOwnerExternalId: input.actor.id,
      leaseExpiresAt: now + input.leaseSeconds * 1_000,
      lastHeartbeatAt: now,
    };
  }
  if (input.command === "succeed") {
    requireStatus(current, ["starting", "running", "waiting", "blocked"], input.command);
    if (LEASED_STATUSES.has(current.status)) {
      requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    }
    return {
      ...common,
      status: "succeeded" as const,
      leaseOwnerExternalId: undefined,
      leaseExpiresAt: undefined,
      nextRetryAt: undefined,
      endedAt: now,
    };
  }
  if (input.command === "fail") {
    requireStatus(current, ["starting", "running", "waiting", "blocked"], input.command);
    if (LEASED_STATUSES.has(current.status)) {
      requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    }
    const retryAttempt = current.retryAttempt + 1;
    const nextRetryAt = retryAttempt < current.maxAttempts
      ? now + current.retryBackoffSeconds * Math.max(retryAttempt, 1) * 1_000
      : undefined;
    return {
      ...common,
      status: "failed" as const,
      leaseOwnerExternalId: undefined,
      leaseExpiresAt: undefined,
      retryAttempt,
      nextRetryAt,
      endedAt: now,
    };
  }
  if (input.command === "retry") {
    requireStatus(current, ["failed"], input.command);
    if (current.nextRetryAt === undefined || current.nextRetryAt > now) {
      throw new Error("Run is not eligible for retry yet");
    }
    if (current.retryAttempt >= current.maxAttempts) {
      throw new Error("Run retry budget is exhausted");
    }
    return {
      ...common,
      status: "queued" as const,
      leaseGeneration: current.leaseGeneration + 1,
      leaseOwnerExternalId: input.actor.id,
      leaseExpiresAt: now + input.leaseSeconds * 1_000,
      lastHeartbeatAt: undefined,
      outcome: undefined,
      nextRetryAt: undefined,
      startedAt: undefined,
      endedAt: undefined,
    };
  }
  requireStatus(
    current,
    ["queued", "starting", "running", "waiting", "blocked", "failed"],
    input.command,
  );
  return {
    ...common,
    status: "cancelled" as const,
    leaseOwnerExternalId: undefined,
    leaseExpiresAt: undefined,
    nextRetryAt: undefined,
    endedAt: now,
  };
}

function requireProjectableItem(
  item: Doc<"items">,
  current: QueuedRun,
  next: ReturnType<typeof nextRunState>,
  input: ReturnType<typeof normalizeTransition>,
  now: number,
): void {
  const previousOwner = current.leaseOwnerExternalId ?? current.actorExternalId;
  const availableStatus = ["ready", "active", "blocked"].includes(item.status);
  const availableOwner = item.claimedByExternalId === undefined
    || item.claimedByExternalId === previousOwner
    || item.claimedByExternalId === next.leaseOwnerExternalId
    || (item.claimExpiresAt !== undefined && item.claimExpiresAt <= now);
  if (!availableStatus || !availableOwner) {
    throw new Error(
      `Run ${current.externalId} could not ${input.command} item ${item.externalId} because item ownership or status changed`,
    );
  }
}

async function projectItem(
  ctx: MutationContext,
  item: Doc<"items">,
  current: QueuedRun,
  next: ReturnType<typeof nextRunState>,
  input: ReturnType<typeof normalizeTransition>,
  now: number,
): Promise<void> {
  const common = { version: item.version + 1, updatedAt: now };
  if (LEASED_STATUSES.has(next.status)) {
    if (!next.leaseOwnerExternalId || !next.leaseExpiresAt) {
      throw new Error(`Run ${current.externalId} entered ${next.status} without a live lease`);
    }
    const actor = await ctx.db
      .query("actors")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", current.workspaceId)
          .eq("externalId", next.leaseOwnerExternalId!)
      )
      .unique();
    if (!actor) throw new Error("Run lease owner does not exist");
    await ctx.db.patch(item._id, {
      ...common,
      status: "active",
      claimedByActorId: actor._id,
      claimedByExternalId: actor.externalId,
      claimExpiresAt: next.leaseExpiresAt,
    });
    return;
  }
  if (next.status === "succeeded") {
    await ctx.db.patch(item._id, {
      ...common,
      status: "done",
      summary: next.outcome ?? item.summary,
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
    });
    return;
  }
  if (next.status === "blocked") {
    await ctx.db.patch(item._id, {
      ...common,
      status: "blocked",
      summary: next.outcome ?? next.checkpoint ?? `Run ${current.externalId} is blocked.`,
      nextAction: next.checkpoint ?? item.nextAction,
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
    });
    return;
  }
  if (next.status === "failed") {
    await ctx.db.patch(item._id, {
      ...common,
      status: "blocked",
      summary: next.outcome ?? `Run ${current.externalId} failed.`,
      nextAction: next.nextRetryAt === undefined
        ? "Review the failed run and decide how to continue."
        : `Retry is eligible after ${new Date(next.nextRetryAt).toISOString()}.`,
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
    });
    return;
  }
  if (next.status === "cancelled") {
    await ctx.db.patch(item._id, {
      ...common,
      status: "ready",
      summary: next.outcome ?? item.summary,
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
    });
    return;
  }
  throw new Error(`Run transition cannot project item state ${next.status}`);
}

async function requiredRun(
  ctx: MutationContext,
  workspaceId: Id<"workspaces">,
  id: string,
): Promise<QueuedRun> {
  const run = await ctx.db
    .query("queuedRuns")
    .withIndex("by_workspace_external", (q) =>
      q.eq("workspaceId", workspaceId).eq("externalId", id)
    )
    .unique();
  if (!run) throw new Error(`Run ${id} does not exist`);
  return run;
}

async function publicQueuedRun(
  ctx: MutationContext,
  run: QueuedRun,
  itemId: string,
) {
  const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
  return publicQueuedRunProjection(run, itemId, execution);
}

function publicQueuedRunProjection(
  run: QueuedRun,
  itemId: string,
  execution: { executionEnvelope: unknown; executionRecords: unknown[] },
) {
  return {
    id: run.externalId,
    itemId,
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
  };
}

async function appendRunEvent(
  ctx: MutationContext,
  run: QueuedRun,
  actorId: Id<"actors"> | undefined,
  actorExternalId: string | undefined,
  event: { type: string; payload: unknown; now: number },
): Promise<void> {
  await appendEvent(ctx, {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    itemId: run.itemId,
    actorId,
    actorExternalId,
    type: event.type,
    payload: event.payload,
    createdAt: event.now,
  });
}

async function appendEnvelopeReference(
  ctx: MutationContext,
  run: QueuedRun,
  envelope: { schemaVersion: number } | null,
  lifecycleEventType: string,
  createdAt: number,
): Promise<void> {
  if (!envelope) return;
  await appendEvent(ctx, {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    itemId: run.itemId,
    actorId: run.actorId,
    actorExternalId: run.actorExternalId,
    type: "run.envelope_reference",
    payload: {
      runId: run.externalId,
      generation: run.generation,
      leaseGeneration: run.leaseGeneration,
      envelopeSchemaVersion: envelope.schemaVersion,
      lifecycleEventType,
      lifecycleEventCreatedAt: createdAt,
    },
    createdAt,
  });
}

async function replayCommand(
  ctx: MutationContext,
  workspaceId: Id<"workspaces">,
  idempotencyKey: string | undefined,
  operation: string,
  request: unknown,
): Promise<{ found: boolean; result: unknown }> {
  if (!idempotencyKey) return { found: false, result: null };
  const existing = await ctx.db
    .query("runnerCommands")
    .withIndex("by_workspace_id_and_idempotency_key", (q) =>
      q.eq("workspaceId", workspaceId).eq("idempotencyKey", idempotencyKey)
    )
    .unique();
  if (!existing) return { found: false, result: null };
  if (existing.operation !== operation || !sameCanonical(existing.request, request)) {
    throw new Error("Idempotency key was already used for a different runner command");
  }
  return { found: true, result: normalizeRunnerCommandReplay(existing.result) };
}

async function storeCommand(
  ctx: MutationContext,
  workspaceId: Id<"workspaces">,
  idempotencyKey: string | undefined,
  operation: string,
  request: unknown,
  result: unknown,
  createdAt: number,
): Promise<void> {
  if (!idempotencyKey) return;
  await ctx.db.insert("runnerCommands", {
    workspaceId,
    idempotencyKey,
    operation,
    request,
    result,
    createdAt,
  });
}

function normalizeRunnerCommandReplay(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (typeof record.runnerProfile !== "string" || "runnerProfileVersion" in record) return result;
  return { ...record, runnerProfileVersion: null };
}

function normalizeClaim(args: {
  actor: ActorInput;
  runnerType: string;
  runnerProfile: string;
  runnerProfileVersion?: string | null;
  project?: string;
  runId?: string;
  externalRunId?: string;
  leaseSeconds?: number;
  idempotencyKey?: string;
  concurrency?: { globalLimit: number; projectLimit: number };
}) {
  if (args.actor.kind === "human") throw new Error("Runner actor must be an agent or service");
  const provenance = runnerProfileProvenanceV1(args.runnerProfile, args.runnerProfileVersion);
  return {
    actor: args.actor,
    runnerType: requiredText(args.runnerType, "Runner type", 80),
    runnerProfile: provenance.profileId,
    runnerProfileVersion: provenance.profileVersion,
    project: args.project === undefined ? undefined : assertSlug(args.project, "Project"),
    runId: optionalText(args.runId, "Run ID", 240),
    externalRunId: optionalText(args.externalRunId, "External run ID", 240),
    leaseSeconds: assertLeaseSeconds(args.leaseSeconds ?? 900),
    idempotencyKey: optionalText(args.idempotencyKey, "Idempotency key", 240),
    globalLimit: concurrencyLimit(args.concurrency?.globalLimit ?? 4, "Global runner concurrency limit"),
    projectLimit: concurrencyLimit(args.concurrency?.projectLimit ?? 2, "Project runner concurrency limit"),
  };
}

function normalizeHeartbeat(args: {
  id: string;
  actor: ActorInput;
  expectedGeneration: number;
  expectedLeaseGeneration: number;
  leaseSeconds?: number;
  checkpoint?: string;
  usage?: Usage;
  idempotencyKey?: string;
}) {
  return {
    id: requiredText(args.id, "Run ID", 240),
    actor: args.actor,
    expectedGeneration: positiveInteger(args.expectedGeneration, "Expected generation"),
    expectedLeaseGeneration: positiveInteger(
      args.expectedLeaseGeneration,
      "Expected lease generation",
    ),
    leaseSeconds: assertLeaseSeconds(args.leaseSeconds ?? 900),
    checkpoint: optionalText(args.checkpoint, "Checkpoint", 10_000),
    usage: normalizeUsage(args.usage),
    idempotencyKey: optionalText(args.idempotencyKey, "Idempotency key", 240),
  };
}

function normalizeTransition(args: {
  id: string;
  actor: ActorInput;
  command: RunCommand;
  expectedGeneration: number;
  expectedLeaseGeneration: number;
  leaseSeconds?: number;
  checkpoint?: string;
  outcome?: string;
  continuationRef?: string;
  usage?: Usage;
  executionActual?: unknown;
  idempotencyKey?: string;
}) {
  const terminal = ["succeed", "fail", "cancel"].includes(args.command);
  if (!terminal && args.executionActual !== undefined) {
    throw new Error("Execution actuals may be recorded only for succeed, fail, or cancel transitions");
  }
  return {
    id: requiredText(args.id, "Run ID", 240),
    actor: args.actor,
    command: args.command,
    expectedGeneration: positiveInteger(args.expectedGeneration, "Expected generation"),
    expectedLeaseGeneration: positiveInteger(
      args.expectedLeaseGeneration,
      "Expected lease generation",
    ),
    leaseSeconds: assertLeaseSeconds(args.leaseSeconds ?? 900),
    checkpoint: optionalText(args.checkpoint, "Checkpoint", 10_000),
    outcome: optionalText(args.outcome, "Outcome", 10_000),
    continuationRef: optionalText(args.continuationRef, "Continuation reference", 500),
    usage: normalizeUsage(args.usage),
    executionActual: normalizeExecutionActual(args.executionActual),
    executionActualProvided: args.executionActual !== undefined,
    idempotencyKey: optionalText(args.idempotencyKey, "Idempotency key", 240),
  };
}

function claimRequest(input: ReturnType<typeof normalizeClaim>) {
  return {
    actor: input.actor,
    runnerType: input.runnerType,
    runnerProfile: input.runnerProfile,
    ...(input.runnerProfileVersion === null
      ? {}
      : { runnerProfileVersion: input.runnerProfileVersion }),
    project: input.project ?? null,
    runId: input.runId ?? null,
    externalRunId: input.externalRunId ?? null,
    leaseSeconds: input.leaseSeconds,
  };
}

function heartbeatRequest(input: ReturnType<typeof normalizeHeartbeat>) {
  return {
    id: input.id,
    actor: input.actor,
    expectedGeneration: input.expectedGeneration,
    expectedLeaseGeneration: input.expectedLeaseGeneration,
    leaseSeconds: input.leaseSeconds,
    checkpoint: input.checkpoint ?? null,
    usage: input.usage,
  };
}

function transitionRequest(input: ReturnType<typeof normalizeTransition>) {
  return {
    id: input.id,
    actor: input.actor,
    command: input.command,
    expectedGeneration: input.expectedGeneration,
    expectedLeaseGeneration: input.expectedLeaseGeneration,
    leaseSeconds: input.leaseSeconds,
    checkpoint: input.checkpoint ?? null,
    outcome: input.outcome ?? null,
    continuationRef: input.continuationRef ?? null,
    usage: input.usage,
    executionActual: input.executionActual,
  };
}

function requireStatus(current: QueuedRun, statuses: RunStatus[], command: RunCommand): void {
  if (!statuses.includes(current.status)) {
    throw new Error(`Run cannot ${command} while ${current.status}`);
  }
}

function requireGeneration(current: QueuedRun, expected: number): void {
  if (current.generation !== expected) {
    throw new Error(`Run generation changed from ${expected} to ${current.generation}`);
  }
}

function requireLiveLease(
  current: QueuedRun,
  actorId: string,
  expectedLeaseGeneration: number,
  now: number,
): void {
  if (current.leaseGeneration !== expectedLeaseGeneration) {
    throw new Error(
      `Run lease generation changed from ${expectedLeaseGeneration} to ${current.leaseGeneration}`,
    );
  }
  if (current.leaseOwnerExternalId !== actorId) {
    throw new Error("Only the current run lease owner can perform this action");
  }
  if (current.leaseExpiresAt === undefined || current.leaseExpiresAt <= now) {
    throw new Error("Run lease has expired");
  }
}

function mergeUsage(current: unknown, patch: Usage): Usage {
  return { ...normalizeUsage(current), ...patch };
}

function normalizeUsage(value: unknown): Usage {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Run usage must be an object");
  }
  const input = value as Record<string, unknown>;
  const output: Usage = {};
  for (const [key, label] of [
    ["inputTokens", "Input tokens"],
    ["outputTokens", "Output tokens"],
    ["toolCalls", "Tool calls"],
    ["childAgents", "Child agents"],
  ] as const) {
    if (input[key] !== undefined) output[key] = nonNegativeInteger(input[key], label);
  }
  return output;
}

function concurrencyLimit(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1_000) {
    throw new Error(`${label} must be a whole number from 1 to 1000`);
  }
  return number;
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  return assertText(typeof value === "string" ? value : "", label, maximum);
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, label, maximum);
}
