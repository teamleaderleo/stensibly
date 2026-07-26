import { v } from "convex/values";
import {
  appendEvent,
  assertLeaseSeconds,
  assertOptionalText,
  assertSlug,
  assertText,
  ensureProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicItem,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import {
  appendExecutionEnvelopeEvent,
  executionEnvelopeValidator,
  normalizeExecutionEnvelope,
} from "./lib/executionEnvelope";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

const policyModeValidator = v.union(
  v.literal("human"),
  v.literal("automatic"),
  v.literal("notify"),
);

const liveContinuationStatuses = new Set(["proposed", "deferred", "approved"]);
const liveQueuedRunStatuses = ["queued", "starting", "running", "waiting", "blocked"] as const;

export const queue = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    supervisor: actorValidator,
    expectedGeneration: v.number(),
    runnerType: v.string(),
    runnerProfile: v.string(),
    leaseSeconds: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
    retryBackoffSeconds: v.optional(v.number()),
    executionEnvelope: v.optional(executionEnvelopeValidator),
    idempotencyKey: v.optional(v.string()),
    policyMode: v.optional(policyModeValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    return await queueOne(ctx, workspace, normalizeQueueInput(args));
  },
});

export const runPolicy = mutation({
  args: {
    ...serviceArgs,
    supervisor: actorValidator,
    runnerType: v.string(),
    runnerProfile: v.string(),
    project: v.optional(v.string()),
    limit: v.optional(v.number()),
    leaseSeconds: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
    retryBackoffSeconds: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const input = normalizePolicyInput(args);
    const rows = [
      ...await ctx.db
        .query("continuations")
        .withIndex("by_delivery_status", (q: any) =>
          q
            .eq("workspaceId", workspace._id)
            .eq("deliveryMode", "supervisor")
            .eq("status", "proposed")
        )
        .collect(),
      ...await ctx.db
        .query("continuations")
        .withIndex("by_delivery_status", (q: any) =>
          q
            .eq("workspaceId", workspace._id)
            .eq("deliveryMode", "supervisor")
            .eq("status", "deferred")
        )
        .collect(),
    ];

    const candidates = [];
    for (const continuation of rows) {
      if (!["automatic", "notify"].includes(continuation.approvalMode)) continue;
      if (isExpired(continuation, Date.now())) continue;
      if (
        input.project &&
        !(await continuationTouchesOnlyProject(ctx, continuation, input.project))
      ) {
        continue;
      }
      candidates.push(continuation);
    }
    candidates.sort(policyOrder);

    const result: {
      considered: number;
      dispatched: any[];
      skipped: Array<{ id: string; generation: number; reason: string }>;
    } = {
      considered: Math.min(candidates.length, input.limit),
      dispatched: [],
      skipped: [],
    };

    for (const continuation of candidates.slice(0, input.limit)) {
      if (continuation.action.kind === "request_decision") {
        result.skipped.push({
          id: continuation.externalId,
          generation: continuation.generation,
          reason: "Decision requests remain human-owned.",
        });
        continue;
      }
      try {
        result.dispatched.push(await queueOne(ctx, workspace, {
          id: continuation.externalId,
          actor: input.supervisor,
          supervisor: input.supervisor,
          expectedGeneration: continuation.generation,
          runnerType: input.runnerType,
          runnerProfile: input.runnerProfile,
          leaseSeconds: input.leaseSeconds,
          maxAttempts: input.maxAttempts,
          retryBackoffSeconds: input.retryBackoffSeconds,
          executionEnvelope: normalizeExecutionEnvelope(
            undefined,
            executionObjective(continuation.externalId, input.runnerProfile),
          ),
          idempotencyKey: `continuation-policy:${continuation.externalId}:${continuation.generation}`,
          policyMode: continuation.approvalMode,
        }));
      } catch (error) {
        result.skipped.push({
          id: continuation.externalId,
          generation: continuation.generation,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  },
});

async function queueOne(ctx: any, workspace: any, input: ReturnType<typeof normalizeQueueInput>) {
  const request = queueRequest(input);
  if (input.idempotencyKey) {
    const replay = await ctx.db
      .query("continuationSupervisorCommands")
      .withIndex("by_workspace_idempotency", (q: any) =>
        q.eq("workspaceId", workspace._id).eq("idempotencyKey", input.idempotencyKey)
      )
      .unique();
    if (replay) {
      if (replay.continuationExternalId !== input.id) {
        throw new Error(
          "Idempotency key was already used for a different continuation supervisor request",
        );
      }
      const replayRequest = record(replay.request);
      if (!replayRequest || replayRequest.executionEnvelope === undefined) {
        throw new Error(
          "Idempotency key belongs to a legacy continuation supervisor request without an execution envelope",
        );
      }
      requireSameRequest(replay.request, request, "continuation supervisor request");
      return replay.result;
    }
  }

  let continuation = await getContinuation(ctx, workspace._id, input.id);
  const now = Date.now();
  if (isExpired(continuation, now)) {
    throw new Error("Continuation cannot queue for supervisor while expired");
  }
  if (continuation.generation !== input.expectedGeneration) {
    throw new Error(
      `Continuation generation changed from ${input.expectedGeneration} to ${continuation.generation}`,
    );
  }
  if (continuation.deliveryMode !== "supervisor" && input.policyMode !== "human") {
    throw new Error(
      `Continuation delivery mode ${continuation.deliveryMode} is not eligible for supervisor policy`,
    );
  }
  if (input.policyMode === "automatic" && continuation.approvalMode !== "automatic") {
    throw new Error(
      `Continuation approval mode ${continuation.approvalMode} is not automatic`,
    );
  }
  if (input.policyMode === "notify" && continuation.approvalMode !== "notify") {
    throw new Error(
      `Continuation approval mode ${continuation.approvalMode} does not require notification`,
    );
  }
  if (!liveContinuationStatuses.has(continuation.status)) {
    throw new Error(
      `Continuation cannot queue for supervisor while ${continuation.status}`,
    );
  }
  if (continuation.action.kind === "request_decision") {
    throw new Error("Decision-request continuations cannot be supervisor-dispatched");
  }

  const sourceItem = await ctx.db.get("items", continuation.sourceItemId);
  if (!sourceItem) throw new Error("Continuation source item does not exist");
  let target = continuation.action.kind === "create_item"
    ? null
    : await getItemByExternalId(ctx, workspace._id, continuation.action.itemId);
  if (target && !(await targetIsDispatchable(ctx, target, input.supervisor.id, now))) {
    throw new Error(
      `Continuation target ${target.externalId} is not eligible for supervisor dispatch`,
    );
  }

  const approvalActor = await upsertActor(ctx, workspace._id, input.actor);
  if (!approvalActor) throw new Error("Failed to create approval actor");
  const supervisor = await upsertActor(ctx, workspace._id, input.supervisor);
  if (!supervisor) throw new Error("Failed to create supervisor actor");

  if (continuation.status === "proposed" || continuation.status === "deferred") {
    const nextGeneration = continuation.generation + 1;
    const note = approvalNote(input.policyMode);
    await ctx.db.patch(continuation._id, {
      status: "approved",
      generation: nextGeneration,
      resolutionActorId: approvalActor._id,
      resolutionActorExternalId: approvalActor.externalId,
      resolutionNote: note,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: continuation.workspaceId,
      projectId: continuation.projectId,
      itemId: continuation.sourceItemId,
      actorId: approvalActor._id,
      actorExternalId: approvalActor.externalId,
      type: "continuation.approved",
      payload: {
        continuationId: continuation.externalId,
        command: "approve",
        fromStatus: continuation.status,
        toStatus: "approved",
        generation: nextGeneration,
        note,
      },
      createdAt: now,
    });
    await touchCurrentItem(ctx, continuation.sourceItemId, now);
    continuation = {
      ...continuation,
      status: "approved",
      generation: nextGeneration,
      resolutionActorId: approvalActor._id,
      resolutionActorExternalId: approvalActor.externalId,
      resolutionNote: note,
      updatedAt: now,
    };
  }

  let createdItemId: string | null = null;
  if (continuation.action.kind === "create_item") {
    const projectSlug = assertSlug(continuation.action.project, "Action project");
    const project = await ensureProject(ctx, workspace._id, workspace.slug, projectSlug);
    if (!project) throw new Error("Failed to create continuation target project");
    const itemId = await ctx.db.insert("items", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId: "pending",
      kind: "task",
      title: continuation.title,
      summary: continuation.rationale,
      status: "ready",
      priority: sourceItem.priority,
      nextAction: continuation.instruction,
      claimGeneration: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    createdItemId = `item_${itemId}`;
    await ctx.db.patch(itemId, { externalId: createdItemId });
    await appendEvent(ctx, {
      workspaceId: workspace._id,
      projectId: project._id,
      itemId,
      actorId: supervisor._id,
      actorExternalId: supervisor.externalId,
      type: "item.created",
      payload: {
        project: projectSlug,
        kind: "task",
        title: continuation.title,
        source: "continuation_supervisor",
        continuationId: continuation.externalId,
      },
      createdAt: now,
    });
    target = await ctx.db.get("items", itemId);
  } else {
    target = await getItemByExternalId(ctx, workspace._id, continuation.action.itemId);
  }
  if (!target) throw new Error("Continuation target item disappeared");
  if (!(await targetIsDispatchable(ctx, target, supervisor.externalId, now))) {
    throw new Error(
      `Continuation target ${target.externalId} is not eligible for supervisor dispatch`,
    );
  }

  const leaseExpiresAt = now + input.leaseSeconds * 1_000;
  await ctx.db.patch(target._id, {
    status: "active",
    claimedByActorId: supervisor._id,
    claimedByExternalId: supervisor.externalId,
    claimExpiresAt: leaseExpiresAt,
    claimGeneration: target.claimGeneration + 1,
    version: target.version + 1,
    updatedAt: now,
  });

  const runnerProfile = continuation.action.kind === "dispatch_item"
    ? continuation.action.runnerProfile ?? input.runnerProfile
    : input.runnerProfile;
  const queuedRunId = await ctx.db.insert("queuedRuns", {
    workspaceId: workspace._id,
    projectId: target.projectId,
    itemId: target._id,
    externalId: "pending",
    actorId: supervisor._id,
    actorExternalId: supervisor.externalId,
    runnerType: input.runnerType,
    runnerProfile,
    status: "queued",
    generation: 1,
    leaseGeneration: 1,
    leaseOwnerExternalId: supervisor.externalId,
    leaseExpiresAt,
    continuationRef: continuation.externalId,
    usage: {},
    retryAttempt: 0,
    maxAttempts: input.maxAttempts,
    retryBackoffSeconds: input.retryBackoffSeconds,
    createdAt: now,
    updatedAt: now,
  });
  const runExternalId = `run_${queuedRunId}`;
  await ctx.db.patch(queuedRunId, { externalId: runExternalId });
  await appendExecutionEnvelopeEvent(ctx, {
    workspaceId: workspace._id,
    projectId: target.projectId,
    itemId: target._id,
    actorId: supervisor._id,
    actorExternalId: supervisor.externalId,
    runId: runExternalId,
    runGeneration: 1,
    leaseGeneration: 1,
    envelope: input.executionEnvelope,
    createdAt: now,
  });

  await appendEvent(ctx, {
    workspaceId: workspace._id,
    projectId: target.projectId,
    itemId: target._id,
    actorId: supervisor._id,
    actorExternalId: supervisor.externalId,
    type: "claim.created",
    payload: {
      leaseSeconds: input.leaseSeconds,
      expiresAt: new Date(leaseExpiresAt).toISOString(),
      source: "supervisor_dispatch",
    },
    createdAt: now,
  });
  await appendEvent(ctx, {
    workspaceId: workspace._id,
    projectId: target.projectId,
    itemId: target._id,
    actorId: supervisor._id,
    actorExternalId: supervisor.externalId,
    type: "run.queued",
    payload: {
      runId: runExternalId,
      generation: 1,
      leaseGeneration: 1,
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      runnerType: input.runnerType,
      runnerProfile,
      source: "supervisor_dispatch",
      readyPromiseWakeups: 0,
      envelopeSchemaVersion: input.executionEnvelope.schemaVersion,
    },
    createdAt: now,
  });

  const consumedGeneration = continuation.generation + 1;
  const consumptionResult = { itemId: target.externalId, runId: runExternalId };
  const consumptionNote = `Queued run ${runExternalId} through supervisor dispatch.`;
  await ctx.db.patch(continuation._id, {
    status: "consumed",
    generation: consumedGeneration,
    resolutionActorId: supervisor._id,
    resolutionActorExternalId: supervisor.externalId,
    resolutionNote: consumptionNote,
    result: consumptionResult,
    consumedAt: now,
    updatedAt: now,
  });
  await appendEvent(ctx, {
    workspaceId: continuation.workspaceId,
    projectId: continuation.projectId,
    itemId: continuation.sourceItemId,
    actorId: supervisor._id,
    actorExternalId: supervisor.externalId,
    type: "continuation.consumed",
    payload: {
      continuationId: continuation.externalId,
      command: "consume",
      fromStatus: "approved",
      toStatus: "consumed",
      generation: consumedGeneration,
      note: consumptionNote,
      result: consumptionResult,
    },
    createdAt: now,
  });
  await touchCurrentItem(ctx, continuation.sourceItemId, now);

  const notificationRecommended = input.policyMode === "notify";
  if (notificationRecommended) {
    await appendEvent(ctx, {
      workspaceId: continuation.workspaceId,
      projectId: continuation.projectId,
      itemId: continuation.sourceItemId,
      actorId: supervisor._id,
      actorExternalId: supervisor.externalId,
      type: "continuation.supervisor_notified",
      payload: {
        continuationId: continuation.externalId,
        itemId: target.externalId,
        runId: runExternalId,
        policyMode: input.policyMode,
      },
      createdAt: now,
    });
    await touchCurrentItem(ctx, continuation.sourceItemId, now);
  }

  const [updatedContinuation, updatedTarget, queuedRun] = await Promise.all([
    ctx.db.get("continuations", continuation._id),
    ctx.db.get("items", target._id),
    ctx.db.get("queuedRuns", queuedRunId),
  ]);
  if (!updatedContinuation || !updatedTarget || !queuedRun) {
    throw new Error("Supervisor dispatch result disappeared");
  }
  const result = {
    continuation: publicContinuation(updatedContinuation),
    item: await publicItem(ctx, updatedTarget),
    run: publicQueuedRun(queuedRun, updatedTarget.externalId, {
      executionEnvelope: input.executionEnvelope,
      executionRecords: [],
    }),
    createdItemId,
    notificationRecommended,
  };
  if (input.idempotencyKey) {
    await ctx.db.insert("continuationSupervisorCommands", {
      workspaceId: workspace._id,
      continuationId: continuation._id,
      continuationExternalId: continuation.externalId,
      idempotencyKey: input.idempotencyKey,
      request,
      result,
      createdAt: now,
    });
  }
  return result;
}

async function targetIsDispatchable(
  ctx: any,
  item: any,
  supervisorId: string,
  now: number,
): Promise<boolean> {
  if (item.status !== "ready") return false;
  if (
    item.claimedByExternalId &&
    item.claimExpiresAt !== undefined &&
    item.claimExpiresAt > now &&
    item.claimedByExternalId !== supervisorId
  ) {
    return false;
  }
  for (const status of liveQueuedRunStatuses) {
    const rows = await ctx.db
      .query("queuedRuns")
      .withIndex("by_item_status", (q: any) =>
        q.eq("itemId", item._id).eq("status", status)
      )
      .take(1);
    if (rows.length > 0) return false;
  }
  const retryable = await ctx.db
    .query("queuedRuns")
    .withIndex("by_item_status", (q: any) =>
      q.eq("itemId", item._id).eq("status", "failed")
    )
    .collect();
  if (retryable.some((run: any) => run.nextRetryAt !== undefined)) return false;
  for (const status of ["running", "waiting"] as const) {
    const rows = await ctx.db
      .query("runs")
      .withIndex("by_item_status", (q: any) =>
        q.eq("itemId", item._id).eq("status", status)
      )
      .take(1);
    if (rows.length > 0) return false;
  }
  return true;
}

async function continuationTouchesOnlyProject(
  ctx: any,
  continuation: any,
  project: string,
): Promise<boolean> {
  const source = await ctx.db.get("items", continuation.sourceItemId);
  if (!source) return false;
  const sourceProject = await ctx.db.get("projects", source.projectId);
  if (!sourceProject || sourceProject.slug !== project) return false;
  if (continuation.action.kind === "create_item") {
    return continuation.action.project === project;
  }
  if (
    continuation.action.kind === "resume_item" ||
    continuation.action.kind === "dispatch_item"
  ) {
    const target = await getItemByExternalId(
      ctx,
      continuation.workspaceId,
      continuation.action.itemId,
    );
    const targetProject = await ctx.db.get("projects", target.projectId);
    return targetProject?.slug === project;
  }
  return true;
}

async function requiredWorkspace(ctx: any, workspaceValue: string | undefined) {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceValue));
  if (!workspace) throw new Error("Workspace does not exist");
  return workspace;
}

async function getContinuation(ctx: any, workspaceId: any, externalId: string) {
  const continuation = await ctx.db
    .query("continuations")
    .withIndex("by_workspace_external", (q: any) =>
      q.eq("workspaceId", workspaceId).eq("externalId", externalId)
    )
    .unique();
  if (!continuation) throw new Error(`Continuation ${externalId} does not exist`);
  return continuation;
}

async function touchCurrentItem(ctx: any, itemId: any, now: number) {
  const item = await ctx.db.get("items", itemId);
  if (!item) throw new Error("Continuation source item does not exist");
  await ctx.db.patch(itemId, { version: item.version + 1, updatedAt: now });
}

function normalizeQueueInput(input: any) {
  const id = safeText(input.id, "Continuation ID", 240);
  const runnerProfile = safeText(input.runnerProfile, "Runner profile", 160);
  return {
    id,
    actor: normalizeActor(input.actor, "Approval actor"),
    supervisor: normalizeSupervisor(input.supervisor),
    expectedGeneration: positiveInteger(input.expectedGeneration, "Expected generation"),
    runnerType: safeText(input.runnerType, "Runner type", 80),
    runnerProfile,
    leaseSeconds: assertLeaseSeconds(input.leaseSeconds ?? 900),
    maxAttempts: positiveInteger(input.maxAttempts ?? 3, "Maximum attempts", 20),
    retryBackoffSeconds: positiveInteger(
      input.retryBackoffSeconds ?? 60,
      "Retry backoff seconds",
      86_400,
      0,
    ),
    executionEnvelope: normalizeExecutionEnvelope(
      input.executionEnvelope,
      executionObjective(id, runnerProfile),
    ),
    idempotencyKey: safeOptionalText(input.idempotencyKey, "Idempotency key", 240),
    policyMode: input.policyMode ?? "human",
  };
}

function normalizePolicyInput(input: any) {
  return {
    supervisor: normalizeSupervisor(input.supervisor),
    runnerType: safeText(input.runnerType, "Runner type", 80),
    runnerProfile: safeText(input.runnerProfile, "Runner profile", 160),
    project: input.project ? assertSlug(input.project, "Project") : undefined,
    limit: positiveInteger(input.limit ?? 20, "Policy limit", 100),
    leaseSeconds: assertLeaseSeconds(input.leaseSeconds ?? 900),
    maxAttempts: positiveInteger(input.maxAttempts ?? 3, "Maximum attempts", 20),
    retryBackoffSeconds: positiveInteger(
      input.retryBackoffSeconds ?? 60,
      "Retry backoff seconds",
      86_400,
      0,
    ),
  };
}

function queueRequest(input: ReturnType<typeof normalizeQueueInput>) {
  return {
    id: input.id,
    actor: input.actor,
    supervisor: input.supervisor,
    expectedGeneration: input.expectedGeneration,
    runnerType: input.runnerType,
    runnerProfile: input.runnerProfile,
    leaseSeconds: input.leaseSeconds,
    maxAttempts: input.maxAttempts,
    retryBackoffSeconds: input.retryBackoffSeconds,
    executionEnvelope: input.executionEnvelope,
    policyMode: input.policyMode,
  };
}

function executionObjective(continuationId: string, runnerProfile: string): string {
  return `Execute continuation ${continuationId} with runner profile ${runnerProfile}`;
}

function normalizeSupervisor(actor: any) {
  const normalized = normalizeActor(actor, "Supervisor actor");
  if (normalized.kind === "human") {
    throw new Error("Supervisor actor must be an agent or service");
  }
  return normalized;
}

function normalizeActor(actor: any, label: string) {
  return {
    id: safeText(actor.id, `${label} ID`, 120),
    name: safeText(actor.name, `${label} name`, 160),
    kind: actor.kind,
    ...(actor.capabilities ? { capabilities: actor.capabilities } : {}),
  };
}

function approvalNote(mode: "human" | "automatic" | "notify") {
  if (mode === "human") {
    return "Approved for supervisor dispatch by a human-triggered command.";
  }
  if (mode === "notify") return "Approved by notify-and-dispatch supervisor policy.";
  return "Approved by automatic supervisor policy.";
}

function isExpired(continuation: any, now: number) {
  return continuation.expiresAt !== undefined &&
    continuation.expiresAt <= now &&
    liveContinuationStatuses.has(continuation.status);
}

function policyOrder(left: any, right: any) {
  const leftExpiry = left.expiresAt ?? Number.POSITIVE_INFINITY;
  const rightExpiry = right.expiresAt ?? Number.POSITIVE_INFINITY;
  return leftExpiry - rightExpiry ||
    left.createdAt - right.createdAt ||
    left.externalId.localeCompare(right.externalId);
}

function publicContinuation(continuation: any) {
  return {
    id: continuation.externalId,
    sourceItemId: continuation.request.sourceItemId,
    sourceEventId: continuation.sourceEventExternalId,
    sourceRunId: continuation.sourceRunId ?? null,
    title: continuation.title,
    rationale: continuation.rationale,
    instruction: continuation.instruction,
    action: continuation.action,
    evidence: continuation.evidence,
    suggestedBy: continuation.suggestedByExternalId,
    approvalMode: continuation.approvalMode,
    deliveryMode: continuation.deliveryMode,
    status: continuation.status,
    generation: continuation.generation,
    expiresAt: continuation.expiresAt === undefined
      ? null
      : new Date(continuation.expiresAt).toISOString(),
    resolutionActorId: continuation.resolutionActorExternalId ?? null,
    resolutionNote: continuation.resolutionNote ?? null,
    result: continuation.result ?? null,
    consumedAt: continuation.consumedAt === undefined
      ? null
      : new Date(continuation.consumedAt).toISOString(),
    createdAt: new Date(continuation.createdAt).toISOString(),
    updatedAt: new Date(continuation.updatedAt).toISOString(),
  };
}

function publicQueuedRun(
  run: any,
  itemId: string,
  execution: { executionEnvelope: unknown; executionRecords: unknown[] },
) {
  return {
    id: run.externalId,
    itemId,
    actorId: run.actorExternalId,
    runnerType: run.runnerType,
    runnerProfile: run.runnerProfile,
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

function safeText(value: string, label: string, max: number) {
  const normalized = assertText(value, label, max);
  if (/stn\.tok_/i.test(normalized)) {
    throw new Error(`${label} cannot contain credential-shaped text`);
  }
  return normalized;
}

function safeOptionalText(value: string | undefined, label: string, max: number) {
  const normalized = assertOptionalText(value, label, max);
  if (normalized && /stn\.tok_/i.test(normalized)) {
    throw new Error(`${label} cannot contain credential-shaped text`);
  }
  return normalized;
}

function positiveInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 1,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireSameRequest(existing: unknown, requested: unknown, label: string) {
  if (stableJson(existing) !== stableJson(requested)) {
    throw new Error(`Idempotency key was already used for a different ${label}`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
