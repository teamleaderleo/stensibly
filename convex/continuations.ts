import { v } from "convex/values";
import {
  appendEvent,
  assertOptionalText,
  assertSlug,
  assertText,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

const approvalModeValidator = v.union(
  v.literal("automatic"),
  v.literal("notify"),
  v.literal("human"),
);
const deliveryModeValidator = v.union(
  v.literal("current_conversation"),
  v.literal("human_inbox"),
  v.literal("supervisor"),
);
const statusValidator = v.union(
  v.literal("proposed"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("deferred"),
  v.literal("consumed"),
  v.literal("cancelled"),
  v.literal("superseded"),
  v.literal("expired"),
);
const commandValidator = v.union(
  v.literal("approve"),
  v.literal("reject"),
  v.literal("defer"),
  v.literal("consume"),
  v.literal("cancel"),
  v.literal("supersede"),
);
const actionValidator = v.union(
  v.object({ kind: v.literal("create_item"), project: v.string() }),
  v.object({ kind: v.literal("resume_item"), itemId: v.string() }),
  v.object({
    kind: v.literal("dispatch_item"),
    itemId: v.string(),
    runnerProfile: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("request_decision"), decisionType: v.string() }),
);
const evidenceValidator = v.object({
  kind: v.string(),
  label: v.string(),
  uri: v.string(),
});
const resultValidator = v.object({
  itemId: v.optional(v.string()),
  runId: v.optional(v.string()),
  decisionId: v.optional(v.string()),
  conversationRef: v.optional(v.string()),
});

type ContinuationStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "deferred"
  | "consumed"
  | "cancelled"
  | "superseded"
  | "expired";
type ContinuationCommand =
  | "approve"
  | "reject"
  | "defer"
  | "consume"
  | "cancel"
  | "supersede";

type ContinuationAction =
  | { kind: "create_item"; project: string }
  | { kind: "resume_item"; itemId: string }
  | { kind: "dispatch_item"; itemId: string; runnerProfile?: string }
  | { kind: "request_decision"; decisionType: string };
type ContinuationResult = {
  itemId?: string;
  runId?: string;
  decisionId?: string;
  conversationRef?: string;
};

const liveExpirable = new Set<ContinuationStatus>([
  "proposed",
  "deferred",
  "approved",
]);
const transitions: Record<
  ContinuationCommand,
  Partial<Record<ContinuationStatus, ContinuationStatus>>
> = {
  approve: { proposed: "approved", deferred: "approved" },
  reject: { proposed: "rejected", deferred: "rejected" },
  defer: { proposed: "deferred" },
  consume: { approved: "consumed" },
  cancel: {
    proposed: "cancelled",
    deferred: "cancelled",
    approved: "cancelled",
  },
  supersede: {
    proposed: "superseded",
    deferred: "superseded",
    approved: "superseded",
  },
};

export const propose = mutation({
  args: {
    ...serviceArgs,
    sourceItemId: v.string(),
    sourceRunId: v.optional(v.string()),
    title: v.string(),
    rationale: v.string(),
    instruction: v.string(),
    action: actionValidator,
    evidence: v.optional(v.array(evidenceValidator)),
    actor: actorValidator,
    approvalMode: v.optional(approvalModeValidator),
    deliveryMode: v.optional(deliveryModeValidator),
    expiresAt: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const sourceItem = await getItemByExternalId(
      ctx,
      workspace._id,
      safeText(args.sourceItemId, "Source item ID", 240),
    );
    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");

    const input = {
      sourceItemId: sourceItem.externalId,
      sourceRunId: safeOptionalText(args.sourceRunId, "Source run ID", 240),
      title: safeText(args.title, "Title", 240),
      rationale: safeText(args.rationale, "Rationale", 10_000),
      instruction: safeText(args.instruction, "Instruction", 10_000),
      action: normalizeAction(args.action),
      evidence: normalizeEvidence(args.evidence ?? []),
      actor: publicActor(args.actor),
      approvalMode: args.approvalMode ?? "human",
      deliveryMode: args.deliveryMode ?? "human_inbox",
      expiresAt: normalizeTimestamp(args.expiresAt, "Continuation expiry"),
    };
    const request = input;
    const idempotencyKey = safeOptionalText(
      args.idempotencyKey,
      "Idempotency key",
      240,
    );
    if (idempotencyKey) {
      const existing = await ctx.db
        .query("continuations")
        .withIndex("by_workspace_idempotency", (q) =>
          q.eq("workspaceId", workspace._id).eq("idempotencyKey", idempotencyKey)
        )
        .unique();
      if (existing) {
        requireSameRequest(existing.request, request, "continuation proposal");
        return publicContinuation(existing);
      }
    }

    const now = Date.now();
    const continuationId = await ctx.db.insert("continuations", {
      workspaceId: workspace._id,
      projectId: sourceItem.projectId,
      sourceItemId: sourceItem._id,
      sourceEventExternalId: "pending",
      sourceRunId: input.sourceRunId,
      externalId: "pending",
      title: input.title,
      rationale: input.rationale,
      instruction: input.instruction,
      action: input.action,
      evidence: input.evidence,
      suggestedByActorId: actor._id,
      suggestedByExternalId: actor.externalId,
      approvalMode: input.approvalMode,
      deliveryMode: input.deliveryMode,
      status: "proposed",
      generation: 1,
      expiresAt: input.expiresAt,
      request,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    const externalId = `cont_${continuationId}`;
    await ctx.db.patch(continuationId, { externalId });
    const event = await appendEvent(ctx, {
      workspaceId: workspace._id,
      projectId: sourceItem.projectId,
      itemId: sourceItem._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "continuation.proposed",
      payload: {
        continuationId: externalId,
        title: input.title,
        actionKind: input.action.kind,
        approvalMode: input.approvalMode,
        deliveryMode: input.deliveryMode,
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: new Date(input.expiresAt).toISOString() }),
      },
      createdAt: now,
    });
    await ctx.db.patch(continuationId, { sourceEventExternalId: event.id });
    await touchItem(ctx, sourceItem, now);
    const created = await ctx.db.get("continuations", continuationId);
    if (!created) throw new Error("Created continuation disappeared");
    return publicContinuation(created);
  },
});

export const get = mutation({
  args: { ...serviceArgs, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    let continuation = await getByExternalId(
      ctx,
      workspace._id,
      safeText(args.id, "Continuation ID", 240),
    );
    continuation = await expireIfNeeded(ctx, continuation, Date.now());
    return publicContinuation(continuation);
  },
});

export const list = mutation({
  args: {
    ...serviceArgs,
    sourceItemId: v.optional(v.string()),
    status: v.optional(statusValidator),
    deliveryMode: v.optional(deliveryModeValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const sourceItem = args.sourceItemId
      ? await getItemByExternalId(
          ctx,
          workspace._id,
          safeText(args.sourceItemId, "Source item ID", 240),
        )
      : null;
    const rows = await ctx.db
      .query("continuations")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    const now = Date.now();
    const reconciled = [];
    for (const row of rows) {
      const current = await expireIfNeeded(ctx, row, now);
      if (sourceItem && current.sourceItemId !== sourceItem._id) continue;
      if (args.status && current.status !== args.status) continue;
      if (args.deliveryMode && current.deliveryMode !== args.deliveryMode) continue;
      reconciled.push(current);
    }
    reconciled.sort((a, b) => b.createdAt - a.createdAt || b.externalId.localeCompare(a.externalId));
    return reconciled.map(publicContinuation);
  },
});

export const resolve = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    command: commandValidator,
    expectedGeneration: v.number(),
    note: v.optional(v.string()),
    result: v.optional(resultValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requiredWorkspace(ctx, args.workspace);
    const id = safeText(args.id, "Continuation ID", 240);
    const generation = positiveInteger(args.expectedGeneration, "Expected generation");
    const note = safeOptionalText(args.note, "Resolution note", 10_000);
    const request = {
      id,
      actor: publicActor(args.actor),
      command: args.command,
      expectedGeneration: generation,
      note: note ?? null,
      result: args.result ?? null,
    };
    const idempotencyKey = safeOptionalText(
      args.idempotencyKey,
      "Idempotency key",
      240,
    );
    if (idempotencyKey) {
      const replay = await ctx.db
        .query("continuationCommands")
        .withIndex("by_workspace_idempotency", (q) =>
          q.eq("workspaceId", workspace._id).eq("idempotencyKey", idempotencyKey)
        )
        .unique();
      if (replay) {
        if (replay.continuationExternalId !== id || replay.command !== args.command) {
          throw new Error(
            "Idempotency key was already used for a different continuation command",
          );
        }
        requireSameRequest(replay.request, request, "continuation command");
        return replay.result;
      }
    }

    let continuation = await getByExternalId(ctx, workspace._id, id);
    continuation = await expireIfNeeded(ctx, continuation, Date.now());
    if (continuation.generation !== generation) {
      throw new Error(
        `Continuation generation changed from ${generation} to ${continuation.generation}`,
      );
    }
    const nextStatus = transitions[args.command][continuation.status as ContinuationStatus];
    if (!nextStatus) {
      throw new Error(
        `Continuation cannot ${args.command} while ${continuation.status}`,
      );
    }
    const result = args.command === "consume"
      ? normalizeConsumptionResult(args.result, continuation.action as ContinuationAction)
      : rejectUnexpectedResult(args.result);
    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const now = Date.now();
    const nextGeneration = generation + 1;
    await ctx.db.patch(continuation._id, {
      status: nextStatus,
      generation: nextGeneration,
      resolutionActorId: actor._id,
      resolutionActorExternalId: actor.externalId,
      resolutionNote: note,
      result: result ?? undefined,
      consumedAt: args.command === "consume" ? now : undefined,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: continuation.workspaceId,
      projectId: continuation.projectId,
      itemId: continuation.sourceItemId,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: `continuation.${nextStatus}`,
      payload: {
        continuationId: continuation.externalId,
        command: args.command,
        fromStatus: continuation.status,
        toStatus: nextStatus,
        generation: nextGeneration,
        ...(note ? { note } : {}),
        ...(result ? { result } : {}),
      },
      createdAt: now,
    });
    const sourceItem = await ctx.db.get("items", continuation.sourceItemId);
    if (!sourceItem) throw new Error("Continuation source item does not exist");
    await touchItem(ctx, sourceItem, now);
    const updated = await ctx.db.get("continuations", continuation._id);
    if (!updated) throw new Error("Updated continuation disappeared");
    const publicResult = publicContinuation(updated);
    if (idempotencyKey) {
      await ctx.db.insert("continuationCommands", {
        workspaceId: workspace._id,
        continuationId: continuation._id,
        continuationExternalId: continuation.externalId,
        idempotencyKey,
        command: args.command,
        request,
        result: publicResult,
        createdAt: now,
      });
    }
    return publicResult;
  },
});

async function requiredWorkspace(ctx: any, workspaceValue: string | undefined) {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceValue));
  if (!workspace) throw new Error("Workspace does not exist");
  return workspace;
}

async function getByExternalId(ctx: any, workspaceId: any, externalId: string) {
  const continuation = await ctx.db
    .query("continuations")
    .withIndex("by_workspace_external", (q: any) =>
      q.eq("workspaceId", workspaceId).eq("externalId", externalId)
    )
    .unique();
  if (!continuation) throw new Error(`Continuation ${externalId} does not exist`);
  return continuation;
}

async function expireIfNeeded(ctx: any, continuation: any, now: number) {
  if (
    continuation.expiresAt === undefined ||
    continuation.expiresAt > now ||
    !liveExpirable.has(continuation.status)
  ) {
    return continuation;
  }
  const generation = continuation.generation + 1;
  await ctx.db.patch(continuation._id, {
    status: "expired",
    generation,
    updatedAt: now,
  });
  await appendEvent(ctx, {
    workspaceId: continuation.workspaceId,
    projectId: continuation.projectId,
    itemId: continuation.sourceItemId,
    type: "continuation.expired",
    payload: {
      continuationId: continuation.externalId,
      fromStatus: continuation.status,
      toStatus: "expired",
      generation,
    },
    createdAt: now,
  });
  const sourceItem = await ctx.db.get("items", continuation.sourceItemId);
  if (!sourceItem) throw new Error("Continuation source item does not exist");
  await touchItem(ctx, sourceItem, now);
  const updated = await ctx.db.get("continuations", continuation._id);
  if (!updated) throw new Error("Expired continuation disappeared");
  return updated;
}

async function touchItem(ctx: any, item: any, now: number) {
  await ctx.db.patch(item._id, {
    version: item.version + 1,
    updatedAt: now,
  });
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

function normalizeAction(action: ContinuationAction): ContinuationAction {
  if (action.kind === "create_item") {
    return { kind: action.kind, project: assertSlug(action.project, "Action project") };
  }
  if (action.kind === "resume_item") {
    return { kind: action.kind, itemId: safeText(action.itemId, "Action item ID", 240) };
  }
  if (action.kind === "dispatch_item") {
    return {
      kind: action.kind,
      itemId: safeText(action.itemId, "Action item ID", 240),
      ...(action.runnerProfile
        ? { runnerProfile: safeText(action.runnerProfile, "Runner profile", 240) }
        : {}),
    };
  }
  return {
    kind: action.kind,
    decisionType: safeText(action.decisionType, "Decision type", 120),
  };
}

function normalizeEvidence(evidence: Array<{ kind: string; label: string; uri: string }>) {
  if (evidence.length > 50) throw new Error("Evidence may contain at most 50 references");
  return evidence.map((entry) => ({
    kind: safeText(entry.kind, "Evidence kind", 80),
    label: safeText(entry.label, "Evidence label", 240),
    uri: safeText(entry.uri, "Evidence URI", 4096),
  }));
}

function normalizeConsumptionResult(
  result: ContinuationResult | undefined,
  action: ContinuationAction,
): ContinuationResult {
  if (!result) throw new Error("A consumption result is required");
  const normalized: ContinuationResult = {
    ...(result.itemId ? { itemId: safeText(result.itemId, "Result item ID", 240) } : {}),
    ...(result.runId ? { runId: safeText(result.runId, "Result run ID", 240) } : {}),
    ...(result.decisionId
      ? { decisionId: safeText(result.decisionId, "Result decision ID", 240) }
      : {}),
    ...(result.conversationRef
      ? {
          conversationRef: safeText(
            result.conversationRef,
            "Conversation reference",
            4096,
          ),
        }
      : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new Error("A consumption result must include a durable reference");
  }
  if (action.kind === "create_item" && !normalized.itemId) {
    throw new Error("Creating an item requires a result item ID");
  }
  if (
    action.kind === "resume_item" &&
    !normalized.itemId &&
    !normalized.runId &&
    !normalized.conversationRef
  ) {
    throw new Error("Resuming an item requires an item, run, or conversation reference");
  }
  if (
    action.kind === "resume_item" &&
    normalized.itemId &&
    normalized.itemId !== action.itemId
  ) {
    throw new Error("A resumed item result must reference the action item");
  }
  if (action.kind === "dispatch_item" && !normalized.runId) {
    throw new Error("Dispatching an item requires a result run ID");
  }
  if (
    action.kind === "request_decision" &&
    !normalized.decisionId &&
    !normalized.itemId
  ) {
    throw new Error("Requesting a decision requires a decision or item reference");
  }
  return normalized;
}

function rejectUnexpectedResult(result: ContinuationResult | undefined): null {
  if (result !== undefined) {
    throw new Error("Only the consume command accepts a continuation result");
  }
  return null;
}

function publicActor(actor: any) {
  return {
    id: safeText(actor.id, "Actor ID", 120),
    name: safeText(actor.name, "Actor name", 160),
    kind: actor.kind,
    ...(actor.capabilities ? { capabilities: actor.capabilities } : {}),
  };
}

function normalizeTimestamp(value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  const normalized = safeText(value, label, 120);
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
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
