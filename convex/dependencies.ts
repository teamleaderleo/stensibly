import { v } from "convex/values";
import { readVisibleDependencies } from "./lib/dependencyVisibility";
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
  itemStatusValidator,
  serviceArgs,
} from "./lib/validators";

const createdDependencyValidator = v.object({
  id: v.string(),
  fromItemId: v.string(),
  toItemId: v.string(),
  kind: dependencyKindValidator,
  createdAt: v.string(),
});

const visibleDependencyValidator = v.object({
  id: v.string(),
  direction: v.union(v.literal("outgoing"), v.literal("incoming")),
  kind: dependencyKindValidator,
  itemId: v.string(),
  title: v.string(),
  status: itemStatusValidator,
  createdAt: v.string(),
});

export const add = mutation({
  args: {
    ...serviceArgs,
    fromItemId: v.string(),
    toItemId: v.string(),
    kind: dependencyKindValidator,
    actor: actorValidator,
  },
  returns: createdDependencyValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Workspace does not exist");
    const from = await getItemByExternalId(ctx, workspace._id, args.fromItemId);
    const to = await getItemByExternalId(ctx, workspace._id, args.toItemId);
    if (from._id === to._id) throw new Error("An item cannot depend on itself");
    if (from.projectId !== to.projectId) {
      throw new Error("Dependencies must stay within one project");
    }
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
  returns: v.array(visibleDependencyValidator),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.itemId} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.itemId);
    return await readVisibleDependencies(ctx, item);
  },
});
