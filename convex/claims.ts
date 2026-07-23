import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { expireClaimIfNeeded } from "./lib/claimState";
import {
  appendEvent,
  assertLeaseSeconds,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicItem,
  requireMatchingIdempotency,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { internalMutation, mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

const expireScheduledRef = makeFunctionReference<"mutation">("claims:expireScheduled");

export const acquire = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    leaseSeconds: v.number(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "claim.created",
    );
    if (existing) {
      const item = await ctx.db.get("items", existing.itemId);
      if (!item) throw new Error("Idempotent item no longer exists");
      return await publicItem(ctx, item);
    }

    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const leaseSeconds = assertLeaseSeconds(args.leaseSeconds);
    const now = Date.now();
    let item = await getItemByExternalId(ctx, workspace._id, args.id);
    item = await expireClaimIfNeeded(ctx, item, now);

    if (!['ready', 'active'].includes(item.status)) {
      throw new Error("Item is unavailable");
    }
    if (
      item.claimedByActorId !== undefined &&
      item.claimExpiresAt !== undefined &&
      item.claimExpiresAt > now &&
      item.claimedByExternalId !== actor.externalId
    ) {
      throw new Error("Item is held by another actor");
    }

    const expiresAt = now + leaseSeconds * 1_000;
    const generation = item.claimGeneration + 1;
    await ctx.db.patch(item._id, {
      status: "active",
      claimedByActorId: actor._id,
      claimedByExternalId: actor.externalId,
      claimExpiresAt: expiresAt,
      claimGeneration: generation,
      version: item.version + 1,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "claim.created",
      payload: { leaseSeconds, expiresAt: new Date(expiresAt).toISOString(), generation },
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    await ctx.scheduler.runAt(expiresAt, expireScheduledRef, {
      itemId: item._id,
      generation,
    });
    const updated = await ctx.db.get("items", item._id);
    if (!updated) throw new Error("Claimed item disappeared");
    return await publicItem(ctx, updated);
  },
});

export const renew = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    leaseSeconds: v.number(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "claim.renewed",
    );
    if (existing) {
      const item = await ctx.db.get("items", existing.itemId);
      if (!item) throw new Error("Idempotent item no longer exists");
      return await publicItem(ctx, item);
    }

    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const leaseSeconds = assertLeaseSeconds(args.leaseSeconds);
    const now = Date.now();
    let item = await getItemByExternalId(ctx, workspace._id, args.id);
    item = await expireClaimIfNeeded(ctx, item, now);
    if (
      item.status !== "active" ||
      item.claimedByExternalId !== actor.externalId ||
      item.claimExpiresAt === undefined ||
      item.claimExpiresAt <= now
    ) {
      throw new Error("Only the current claimant can renew a live claim");
    }

    const expiresAt = now + leaseSeconds * 1_000;
    const generation = item.claimGeneration + 1;
    await ctx.db.patch(item._id, {
      claimExpiresAt: expiresAt,
      claimGeneration: generation,
      version: item.version + 1,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "claim.renewed",
      payload: { leaseSeconds, expiresAt: new Date(expiresAt).toISOString(), generation },
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    await ctx.scheduler.runAt(expiresAt, expireScheduledRef, {
      itemId: item._id,
      generation,
    });
    const updated = await ctx.db.get("items", item._id);
    if (!updated) throw new Error("Renewed item disappeared");
    return await publicItem(ctx, updated);
  },
});

export const release = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "claim.released",
    );
    if (existing) {
      const item = await ctx.db.get("items", existing.itemId);
      if (!item) throw new Error("Idempotent item no longer exists");
      return await publicItem(ctx, item);
    }

    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const now = Date.now();
    let item = await getItemByExternalId(ctx, workspace._id, args.id);
    item = await expireClaimIfNeeded(ctx, item, now);
    if (item.status !== "active" || item.claimedByExternalId !== actor.externalId) {
      throw new Error("Only the current claimant can release this item");
    }

    await ctx.db.patch(item._id, {
      status: "ready",
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
      claimGeneration: item.claimGeneration + 1,
      version: item.version + 1,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "claim.released",
      payload: {},
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    const updated = await ctx.db.get("items", item._id);
    if (!updated) throw new Error("Released item disappeared");
    return await publicItem(ctx, updated);
  },
});

export const expireScheduled = internalMutation({
  args: {
    itemId: v.id("items"),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get("items", args.itemId);
    const now = Date.now();
    if (
      !item ||
      item.status !== "active" ||
      item.claimGeneration !== args.generation ||
      item.claimExpiresAt === undefined ||
      item.claimExpiresAt > now
    ) {
      return null;
    }

    const previousClaimant = item.claimedByExternalId;
    const expiredAt = item.claimExpiresAt;
    await ctx.db.patch(item._id, {
      status: "ready",
      claimedByActorId: undefined,
      claimedByExternalId: undefined,
      claimExpiresAt: undefined,
      claimGeneration: item.claimGeneration + 1,
      version: item.version + 1,
      updatedAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      type: "claim.expired",
      payload: {
        previousClaimant,
        expiredAt: new Date(expiredAt).toISOString(),
        generation: args.generation,
      },
      createdAt: now,
    });
    return null;
  },
});
