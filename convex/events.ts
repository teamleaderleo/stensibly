import { v } from "convex/values";
import {
  appendEvent,
  assertText,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicEvent,
  requireMatchingIdempotency,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

export const record = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: v.optional(actorValidator),
    type: v.string(),
    payload: v.any(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const type = assertText(args.type, "Event type", 120);
    if (!/^[a-z0-9._-]+$/.test(type)) throw new Error("Event type contains invalid characters");
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      type,
    );
    if (existing) return { ...publicEvent(existing), itemId: args.id };

    const item = await getItemByExternalId(ctx, workspace._id, args.id);
    const actor = args.actor ? await upsertActor(ctx, workspace._id, args.actor) : null;
    const event = await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor?._id,
      actorExternalId: actor?.externalId,
      type,
      payload: args.payload,
      idempotencyKey: args.idempotencyKey,
    });
    return { ...event, itemId: item.externalId };
  },
});

export const list = query({
  args: {
    ...serviceArgs,
    id: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.id);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 200), 1), 1_000);
    const events = await ctx.db
      .query("events")
      .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
      .order("desc")
      .take(limit);
    return events.reverse().map((event) => ({
      ...publicEvent(event),
      itemId: item.externalId,
    }));
  },
});
