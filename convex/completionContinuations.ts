import { v } from "convex/values";
import { expireClaimIfNeeded, liveClaimHeldByOther } from "./lib/claimState";
import {
  appendEvent,
  assertOptionalText,
  assertSlug,
  assertText,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicItem,
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
const draftValidator = v.object({
  sourceRunId: v.optional(v.string()),
  title: v.string(),
  rationale: v.string(),
  instruction: v.string(),
  action: actionValidator,
  evidence: v.optional(v.array(evidenceValidator)),
  approvalMode: v.optional(approvalModeValidator),
  deliveryMode: v.optional(deliveryModeValidator),
  expiresAt: v.optional(v.string()),
});

type ContinuationAction =
  | { kind: "create_item"; project: string }
  | { kind: "resume_item"; itemId: string }
  | { kind: "dispatch_item"; itemId: string; runnerProfile?: string }
  | { kind: "request_decision"; decisionType: string };

type ContinuationDraft = {
  sourceRunId?: string;
  title: string;
  rationale: string;
  instruction: string;
  action: ContinuationAction;
  evidence?: Array<{ kind: string; label: string; uri: string }>;
  approvalMode?: "automatic" | "notify" | "human";
  deliveryMode?: "current_conversation" | "human_inbox" | "supervisor";
  expiresAt?: string;
};

export const complete = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    expectedClaimGeneration: v.number(),
    summary: v.optional(v.string()),
    continuations: v.array(draftValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    if (args.continuations.length > 20) {
      throw new Error("Completion may propose at most 20 continuations");
    }

    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);

    const id = safeText(args.id, "Item ID", 240);
    const expectedGeneration = itemGeneration(args.expectedClaimGeneration);
    const summary = assertOptionalText(args.summary, "Summary", 10_000);
    const actorRequest = publicActor(args.actor);
    const drafts = (args.continuations as ContinuationDraft[]).map((draft) =>
      normalizeDraft(draft, id)
    );
    const request = {
      id,
      actor: actorRequest,
      expectedClaimGeneration: expectedGeneration,
      summary: summary ?? null,
      continuations: drafts.map((draft) => draft.request),
    };
    const idempotencyKey = safeOptionalText(args.idempotencyKey, "Idempotency key", 240);

    if (idempotencyKey) {
      const replay = await ctx.db
        .query("completionContinuationCommands")
        .withIndex("by_workspace_idempotency", (q) =>
          q.eq("workspaceId", workspace._id).eq("idempotencyKey", idempotencyKey)
        )
        .unique();
      if (replay) {
        requireSameRequest(replay.request, request, "completion request");
        if (replay.itemExternalId !== id) {
          throw new Error("Idempotency key was already used for another item");
        }
        return replay.result;
      }
      await requireUnusedIdempotencyKey(ctx, workspace._id, idempotencyKey);
    }

    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");

    const now = Date.now();
    let item = await getItemByExternalId(ctx, workspace._id, id);
    item = await expireClaimIfNeeded(ctx, item, now);
    if (item.claimGeneration !== expectedGeneration) {
      throw new Error("Item claim generation changed");
    }
    if (liveClaimHeldByOther(item, actor.externalId, now)) {
      throw new Error("Work is held by another actor");
    }
    if (item.status === "done" || item.status === "archived") {
      throw new Error("Item is already complete or archived");
    }

    const nextGeneration = item.claimGeneration + 1;
    await ctx.db.patch(item._id, {
      status: "done",
      summary: summary ?? item.summary,
      nextAction: undefined,
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
      claimGeneration: nextGeneration,
      version: item.version + 1 + drafts.length,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "item.completed",
      payload: {
        ...(summary ? { summary } : {}),
        generation: item.claimGeneration,
        nextGeneration,
      },
      idempotencyKey,
      createdAt: now,
    });

    const continuations: any[] = [];
    for (const draft of drafts) {
      const continuationId = await ctx.db.insert("continuations", {
        workspaceId: workspace._id,
        projectId: item.projectId,
        sourceItemId: item._id,
        sourceEventExternalId: "pending",
        sourceRunId: draft.sourceRunId,
        externalId: "pending",
        title: draft.title,
        rationale: draft.rationale,
        instruction: draft.instruction,
        action: draft.action,
        evidence: draft.evidence,
        suggestedByActorId: actor._id,
        suggestedByExternalId: actor.externalId,
        approvalMode: draft.approvalMode,
        deliveryMode: draft.deliveryMode,
        status: "proposed",
        generation: 1,
        expiresAt: draft.expiresAt,
        request: draft.request,
        createdAt: now,
        updatedAt: now,
      });
      const externalId = `cont_${continuationId}`;
      await ctx.db.patch(continuationId, { externalId });
      const event = await appendEvent(ctx, {
        workspaceId: workspace._id,
        projectId: item.projectId,
        itemId: item._id,
        actorId: actor._id,
        actorExternalId: actor.externalId,
        type: "continuation.proposed",
        payload: {
          continuationId: externalId,
          title: draft.title,
          actionKind: draft.action.kind,
          approvalMode: draft.approvalMode,
          deliveryMode: draft.deliveryMode,
          ...(draft.expiresAt === undefined
            ? {}
            : { expiresAt: new Date(draft.expiresAt).toISOString() }),
        },
        createdAt: now,
      });
      await ctx.db.patch(continuationId, { sourceEventExternalId: event.id });
      const created = await ctx.db.get("continuations", continuationId);
      if (!created) throw new Error("Created continuation disappeared");
      continuations.push(publicContinuation(created));
    }

    const updatedItem = await ctx.db.get("items", item._id);
    if (!updatedItem) throw new Error("Updated item disappeared");
    const result = {
      item: await publicItem(ctx, updatedItem),
      continuations,
    };

    if (idempotencyKey) {
      await ctx.db.insert("completionContinuationCommands", {
        workspaceId: workspace._id,
        itemId: item._id,
        itemExternalId: item.externalId,
        idempotencyKey,
        request,
        result,
        createdAt: now,
      });
    }
    return result;
  },
});

async function requireUnusedIdempotencyKey(ctx: any, workspaceId: any, key: string) {
  const [event, proposal, command] = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_workspace_idempotency", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("idempotencyKey", key)
      )
      .unique(),
    ctx.db
      .query("continuations")
      .withIndex("by_workspace_idempotency", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("idempotencyKey", key)
      )
      .unique(),
    ctx.db
      .query("continuationCommands")
      .withIndex("by_workspace_idempotency", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("idempotencyKey", key)
      )
      .unique(),
  ]);
  if (event || proposal || command) {
    throw new Error("Idempotency key already belongs to another operation");
  }
}

function normalizeDraft(draft: ContinuationDraft, sourceItemId: string) {
  const action = normalizeAction(draft.action);
  const evidence = normalizeEvidence(draft.evidence ?? []);
  const expiresAt = normalizeTimestamp(draft.expiresAt, "Continuation expiry");
  const normalized = {
    sourceRunId: safeOptionalText(draft.sourceRunId, "Source run ID", 240),
    title: safeText(draft.title, "Title", 240),
    rationale: safeText(draft.rationale, "Rationale", 10_000),
    instruction: safeText(draft.instruction, "Instruction", 10_000),
    action,
    evidence,
    approvalMode: draft.approvalMode ?? ("human" as const),
    deliveryMode: draft.deliveryMode ?? ("human_inbox" as const),
    expiresAt,
  };
  return {
    ...normalized,
    request: {
      sourceItemId,
      sourceRunId: normalized.sourceRunId,
      title: normalized.title,
      rationale: normalized.rationale,
      instruction: normalized.instruction,
      action: normalized.action,
      evidence: normalized.evidence,
      approvalMode: normalized.approvalMode,
      deliveryMode: normalized.deliveryMode,
      expiresAt: normalized.expiresAt,
    },
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
    resolutionActorId: null,
    resolutionNote: null,
    result: null,
    consumedAt: null,
    createdAt: new Date(continuation.createdAt).toISOString(),
    updatedAt: new Date(continuation.updatedAt).toISOString(),
  };
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

function itemGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Expected claim generation must be a non-negative integer");
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
