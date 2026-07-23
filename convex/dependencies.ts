import { v } from "convex/values";
import {
  appendEvent,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import {
  actorValidator,
  dependencyKindValidator,
  serviceArgs,
} from "./lib/validators";

export const add = mutation({
  args: {
    ...serviceArgs,
    fromItemId: v.string(),
    toItemId: v.string(),
    kind: dependencyKindValidator,
    actor: actorValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Workspace does not exist");
    const from = await getItemByExternalId(ctx, workspace._id, args.fromItemId);
    const to = await getItemByExternalId(ctx, workspace._id, args.toItemId);
    if (from._id === to._id) throw new Error("An item cannot depend on itself");
    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");

    const existing = await ctx.db
      .query("dependencies")
      .withIndex("by_from_kind", (q) =>
        q.eq("fromItemId", from._id).eq("kind", args.kind).eq("toItemId", to._id),
      )
      .unique();
    if (existing) {
      return {
        id: String(existing._id),
        fromItemId: from.externalId,
        toItemId: to.externalId,
        kind: existing.kind,
        createdAt: new Date(existing.createdAt).toISOString(),
      };
    }

    const now = Date.now();
    const dependencyId = await ctx.db.insert("dependencies", {
      workspaceId: workspace._id,
      projectId: from.projectId,
      fromItemId: from._id,
      toItemId: to._id,
      kind: args.kind,
      createdByActorId: actor._id,
      createdAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: workspace._id,
      projectId: from.projectId,
      itemId: from._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "dependency.added",
      payload: {
        dependencyId: String(dependencyId),
        kind: args.kind,
        toItemId: to.externalId,
      },
      createdAt: now,
    });
    return {
      id: String(dependencyId),
      fromItemId: from.externalId,
      toItemId: to.externalId,
      kind: args.kind,
      createdAt: new Date(now).toISOString(),
    };
  },
});

export const list = query({
  args: { ...serviceArgs, itemId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.itemId} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.itemId);
    const [outgoing, incoming] = await Promise.all([
      ctx.db
        .query("dependencies")
        .withIndex("by_from_kind", (q) => q.eq("fromItemId", item._id))
        .collect(),
      ctx.db
        .query("dependencies")
        .withIndex("by_to_kind", (q) => q.eq("toItemId", item._id))
        .collect(),
    ]);
    const output = [];
    for (const dependency of outgoing) {
      const target = await ctx.db.get("items", dependency.toItemId);
      output.push({
        id: String(dependency._id),
        direction: "outgoing",
        kind: dependency.kind,
        itemId: target?.externalId ?? String(dependency.toItemId),
        createdAt: new Date(dependency.createdAt).toISOString(),
      });
    }
    for (const dependency of incoming) {
      const source = await ctx.db.get("items", dependency.fromItemId);
      output.push({
        id: String(dependency._id),
        direction: "incoming",
        kind: dependency.kind,
        itemId: source?.externalId ?? String(dependency.fromItemId),
        createdAt: new Date(dependency.createdAt).toISOString(),
      });
    }
    return output;
  },
});
