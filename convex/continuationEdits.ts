import { v } from "convex/values";
import {
  appendEvent,
  assertOptionalText,
  assertText,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

export const edit = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    expectedGeneration: v.number(),
    instruction: v.string(),
    note: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Continuation ${args.id} does not exist`);

    const id = safeText(args.id, "Continuation ID", 240);
    const expectedGeneration = positiveInteger(
      args.expectedGeneration,
      "Expected generation",
    );
    const instruction = safeText(args.instruction, "Instruction", 10_000);
    const note = safeOptionalText(args.note, "Edit note", 10_000);
    const idempotencyKey = safeOptionalText(
      args.idempotencyKey,
      "Idempotency key",
      240,
    );
    const request = {
      id,
      actor: publicActor(args.actor),
      expectedGeneration,
      instruction,
      note: note ?? null,
    };

    if (idempotencyKey) {
      const replay = await ctx.db
        .query("continuationCommands")
        .withIndex("by_workspace_idempotency", (q) =>
          q.eq("workspaceId", workspace._id).eq("idempotencyKey", idempotencyKey)
        )
        .unique();
      if (replay) {
        if (replay.continuationExternalId !== id || replay.command !== "edit") {
          throw new Error(
            "Idempotency key was already used for a different continuation command",
          );
        }
        requireSameRequest(replay.request, request, "continuation edit");
        return replay.result;
      }
    }

    const continuation = await ctx.db
      .query("continuations")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", workspace._id).eq("externalId", id)
      )
      .unique();
    if (!continuation) throw new Error(`Continuation ${id} does not exist`);
    if (continuation.generation !== expectedGeneration) {
      throw new Error(
        `Continuation generation changed from ${expectedGeneration} to ${continuation.generation}`,
      );
    }
    if (continuation.status !== "proposed" && continuation.status !== "deferred") {
      throw new Error(`Continuation cannot edit while ${continuation.status}`);
    }
    if (continuation.expiresAt !== undefined && continuation.expiresAt <= Date.now()) {
      throw new Error("Continuation cannot edit while expired");
    }

    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const now = Date.now();
    const nextGeneration = continuation.generation + 1;
    await ctx.db.patch(continuation._id, {
      instruction,
      generation: nextGeneration,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: continuation.workspaceId,
      projectId: continuation.projectId,
      itemId: continuation.sourceItemId,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "continuation.edited",
      payload: {
        continuationId: continuation.externalId,
        status: continuation.status,
        generation: nextGeneration,
        instruction,
        ...(note ? { note } : {}),
      },
      createdAt: now,
    });
    const sourceItem = await ctx.db.get("items", continuation.sourceItemId);
    if (!sourceItem) throw new Error("Continuation source item does not exist");
    await ctx.db.patch(sourceItem._id, {
      version: sourceItem.version + 1,
      updatedAt: now,
    });

    const updated = await ctx.db.get("continuations", continuation._id);
    if (!updated) throw new Error("Updated continuation disappeared");
    const result = publicContinuation(updated);
    if (idempotencyKey) {
      await ctx.db.insert("continuationCommands", {
        workspaceId: workspace._id,
        continuationId: continuation._id,
        continuationExternalId: continuation.externalId,
        idempotencyKey,
        command: "edit",
        request,
        result,
        createdAt: now,
      });
    }
    return result;
  },
});

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

function publicActor(actor: any) {
  return {
    id: safeText(actor.id, "Actor ID", 120),
    name: safeText(actor.name, "Actor name", 160),
    kind: actor.kind,
    ...(actor.capabilities ? { capabilities: actor.capabilities } : {}),
  };
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
