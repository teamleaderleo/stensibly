import { v } from "convex/values";
import { expireClaimIfNeeded, liveClaimHeldByOther } from "./lib/claimState";
import {
  appendEvent,
  assertOptionalText,
  assertPriority,
  assertSlug,
  assertText,
  ensureProject,
  ensureWorkspace,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicArtifact,
  publicEvent,
  publicItem,
  publicRun,
  requireMatchingIdempotency,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import {
  actorValidator,
  itemKindValidator,
  itemStatusValidator,
  serviceArgs,
} from "./lib/validators";

export const create = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    kind: itemKindValidator,
    title: v.string(),
    summary: v.optional(v.string()),
    nextAction: v.optional(v.string()),
    priority: v.number(),
    actor: v.optional(actorValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await ensureWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Failed to create workspace");

    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "item.created",
    );
    if (existing) {
      const item = await ctx.db.get("items", existing.itemId);
      if (!item) throw new Error("Idempotent item no longer exists");
      return await publicItem(ctx, item);
    }

    const projectSlug = assertSlug(args.project, "Project");
    const project = await ensureProject(ctx, workspace._id, workspaceSlug, projectSlug);
    if (!project) throw new Error("Failed to create project");
    const actor = args.actor ? await upsertActor(ctx, workspace._id, args.actor) : null;
    const now = Date.now();
    const itemId = await ctx.db.insert("items", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId: "pending",
      kind: args.kind,
      title: assertText(args.title, "Title", 240),
      summary: assertOptionalText(args.summary, "Summary", 10_000),
      status: "ready",
      priority: assertPriority(args.priority),
      nextAction: assertOptionalText(args.nextAction, "Next action", 2_000),
      claimGeneration: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const externalId = `item_${itemId}`;
    await ctx.db.patch(itemId, { externalId });
    await appendEvent(ctx, {
      workspaceId: workspace._id,
      projectId: project._id,
      itemId,
      actorId: actor?._id,
      actorExternalId: actor?.externalId,
      type: "item.created",
      payload: {
        project: projectSlug,
        kind: args.kind,
        title: args.title.trim(),
      },
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    const item = await ctx.db.get("items", itemId);
    if (!item) throw new Error("Created item disappeared");
    return await publicItem(ctx, item);
  },
});

export const list = query({
  args: {
    ...serviceArgs,
    project: v.optional(v.string()),
    status: v.optional(itemStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 500);
    const status = args.status;

    let documents: any[];
    if (args.project) {
      const project = await findProject(
        ctx,
        workspace._id,
        assertSlug(args.project, "Project"),
      );
      if (!project) return [];
      documents = status
        ? await ctx.db
            .query("items")
            .withIndex("by_project_status", (q) =>
              q.eq("projectId", project._id).eq("status", status),
            )
            .collect()
        : await ctx.db
            .query("items")
            .withIndex("by_project_status", (q) => q.eq("projectId", project._id))
            .collect();
    } else {
      documents = status
        ? await ctx.db
            .query("items")
            .withIndex("by_workspace_status", (q) =>
              q.eq("workspaceId", workspace._id).eq("status", status),
            )
            .collect()
        : await ctx.db
            .query("items")
            .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspace._id))
            .collect();
    }

    const statusRank: Record<string, number> = {
      active: 0,
      ready: 1,
      blocked: 2,
      done: 3,
      archived: 4,
    };
    documents.sort(
      (a, b) =>
        (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
        b.priority - a.priority ||
        b.createdAt - a.createdAt,
    );
    return await Promise.all(documents.slice(0, limit).map((item) => publicItem(ctx, item)));
  },
});

export const get = query({
  args: { ...serviceArgs, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.id);
    const [events, artifacts, runs, outgoing, incoming] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .collect(),
      ctx.db
        .query("artifacts")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .collect(),
      ctx.db
        .query("runs")
        .withIndex("by_item_status", (q) => q.eq("itemId", item._id))
        .collect(),
      ctx.db
        .query("dependencies")
        .withIndex("by_from_kind", (q) => q.eq("fromItemId", item._id))
        .collect(),
      ctx.db
        .query("dependencies")
        .withIndex("by_to_kind", (q) => q.eq("toItemId", item._id))
        .collect(),
    ]);

    const dependencies = [];
    for (const dependency of [...outgoing, ...incoming]) {
      const otherId = dependency.fromItemId === item._id
        ? dependency.toItemId
        : dependency.fromItemId;
      const other = await ctx.db.get("items", otherId);
      dependencies.push({
        direction: dependency.fromItemId === item._id ? "outgoing" : "incoming",
        kind: dependency.kind,
        itemId: other?.externalId ?? String(otherId),
        createdAt: new Date(dependency.createdAt).toISOString(),
      });
    }

    return {
      item: await publicItem(ctx, item),
      events: events.map((event) => ({ ...publicEvent(event), itemId: item.externalId })),
      artifacts: artifacts.map((artifact) => ({
        ...publicArtifact(artifact),
        itemId: item.externalId,
      })),
      runs: runs.map((run) => ({ ...publicRun(run), itemId: item.externalId })),
      dependencies,
    };
  },
});

export const complete = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    summary: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => transition(ctx, args, "complete"),
});

export const handoff = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    summary: v.string(),
    nextAction: v.string(),
    toActorId: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => transition(ctx, args, "handoff"),
});

export const block = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    reason: v.string(),
    nextAction: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => transition(ctx, args, "block"),
});

export const unblock = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    nextAction: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => transition(ctx, args, "unblock"),
});

async function transition(ctx: any, args: any, operation: "complete" | "handoff" | "block" | "unblock") {
  requireServiceSecret(args.serviceSecret);
  const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
  if (!workspace) throw new Error(`Item ${args.id} does not exist`);
  const eventType = {
    complete: "item.completed",
    handoff: "work.handed_off",
    block: "work.blocked",
    unblock: "work.unblocked",
  }[operation];
  const existing = await requireMatchingIdempotency(
    ctx,
    workspace._id,
    args.idempotencyKey,
    eventType,
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
  if (liveClaimHeldByOther(item, actor.externalId, now)) {
    throw new Error("Work is held by another actor");
  }

  let patch: Record<string, unknown>;
  let payload: Record<string, unknown>;
  if (operation === "complete") {
    if (item.status === "done" || item.status === "archived") {
      throw new Error("Item is already complete or archived");
    }
    const summary = assertOptionalText(args.summary, "Summary", 10_000);
    patch = {
      status: "done",
      summary: summary ?? item.summary,
      nextAction: undefined,
    };
    payload = summary ? { summary } : {};
  } else if (operation === "handoff") {
    if (!["ready", "active", "blocked"].includes(item.status)) {
      throw new Error("Work is complete or archived");
    }
    const summary = assertText(args.summary, "Summary", 10_000);
    const nextAction = assertText(args.nextAction, "Next action", 2_000);
    patch = { status: "ready", summary, nextAction };
    payload = {
      summary,
      nextAction,
      ...(args.toActorId ? { toActorId: assertText(args.toActorId, "Target actor", 120) } : {}),
    };
  } else if (operation === "block") {
    if (!["ready", "active"].includes(item.status)) {
      throw new Error("Work is already blocked, complete, or archived");
    }
    const reason = assertText(args.reason, "Reason", 10_000);
    const nextAction = assertOptionalText(args.nextAction, "Next action", 2_000);
    patch = { status: "blocked", summary: reason, nextAction: nextAction ?? item.nextAction };
    payload = { reason, ...(nextAction ? { nextAction } : {}) };
  } else {
    if (item.status !== "blocked") throw new Error("Only blocked work can be unblocked");
    const nextAction = assertOptionalText(args.nextAction, "Next action", 2_000);
    patch = { status: "ready", nextAction: nextAction ?? item.nextAction };
    payload = nextAction ? { nextAction } : {};
  }

  const commonPatch = {
    claimedByActorId: undefined,
    claimedByExternalId: undefined,
    claimExpiresAt: undefined,
    claimGeneration: item.claimGeneration + 1,
    version: item.version + 1,
    updatedAt: now,
  };
  await ctx.db.patch(item._id, { ...patch, ...commonPatch });
  await appendEvent(ctx, {
    workspaceId: item.workspaceId,
    projectId: item.projectId,
    itemId: item._id,
    actorId: actor._id,
    actorExternalId: actor.externalId,
    type: eventType,
    payload,
    idempotencyKey: args.idempotencyKey,
    createdAt: now,
  });
  const updated = await ctx.db.get("items", item._id);
  if (!updated) throw new Error("Updated item disappeared");
  return await publicItem(ctx, updated);
}
