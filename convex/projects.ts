import { v } from "convex/values";
import {
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  publicItem,
  publicRun,
  requireServiceSecret,
} from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const itemStatuses = ["ready", "active", "blocked", "done", "archived"] as const;
const itemKinds = [
  "task",
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
] as const;
const knowledgeKinds = new Set<string>(["finding", "question", "decision", "tip", "handoff", "note"]);

export const list = query({
  args: { ...serviceArgs },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    return projects.map((project) => ({
      id: project.externalId,
      slug: project.slug,
      name: project.name,
      createdAt: new Date(project.createdAt).toISOString(),
      updatedAt: new Date(project.updatedAt).toISOString(),
    }));
  },
});

export const brief = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const projectSlug = assertSlug(args.project, "Project");
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Project ${projectSlug} does not exist`);
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error(`Project ${projectSlug} does not exist`);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 10), 1), 100);

    const items = await ctx.db
      .query("items")
      .withIndex("by_project_status", (q) => q.eq("projectId", project._id))
      .collect();
    const byStatus = Object.fromEntries(
      itemStatuses.map((status) => [status, items.filter((item) => item.status === status)]),
    ) as Record<(typeof itemStatuses)[number], typeof items>;
    const countsByKind = Object.fromEntries(itemKinds.map((kind) => [kind, 0])) as Record<
      (typeof itemKinds)[number],
      number
    >;
    for (const item of items) countsByKind[item.kind] += 1;

    const newestFirst = (left: (typeof items)[number], right: (typeof items)[number]) =>
      right.updatedAt - left.updatedAt || right.priority - left.priority;
    const priorityFirst = (left: (typeof items)[number], right: (typeof items)[number]) =>
      right.priority - left.priority || right.updatedAt - left.updatedAt;
    const knowledge = items
      .filter((item) => knowledgeKinds.has(item.kind) && item.status !== "archived")
      .sort(newestFirst)
      .slice(0, limit);
    const recentArtifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(limit);
    const activeRuns = [];
    for (const status of ["running", "waiting"] as const) {
      activeRuns.push(...await ctx.db
        .query("runs")
        .withIndex("by_project_status", (q) =>
          q.eq("projectId", project._id).eq("status", status),
        )
        .collect());
    }
    activeRuns.sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
    const now = Date.now();
    const activeReservations = (await ctx.db
      .query("reservations")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", project._id).eq("status", "active"),
      )
      .collect())
      .filter((reservation) => reservation.expiresAt > now)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, limit);

    return {
      workspace: workspace.slug,
      project: project.slug,
      generatedAt: new Date(now).toISOString(),
      counts: {
        total: items.length,
        byStatus: Object.fromEntries(
          itemStatuses.map((status) => [status, byStatus[status].length]),
        ),
        byKind: countsByKind,
      },
      ready: await mapItems(ctx, byStatus.ready.sort(priorityFirst).slice(0, limit)),
      active: await mapItems(ctx, byStatus.active.sort(newestFirst).slice(0, limit)),
      blocked: await mapItems(ctx, byStatus.blocked.sort(priorityFirst).slice(0, limit)),
      knowledge: await mapItems(ctx, knowledge),
      recentlyCompleted: await mapItems(ctx, byStatus.done.sort(newestFirst).slice(0, limit)),
      recentArtifacts: await mapArtifacts(ctx, recentArtifacts),
      activeRuns: activeRuns.slice(0, limit).map(publicRun),
      activeReservations: activeReservations.map((reservation) => ({
        id: reservation.externalId,
        resource: reservation.resource,
        mode: reservation.mode,
        units: reservation.units,
        capacity: reservation.capacity,
        holderActorId: reservation.holderActorExternalId,
        expiresAt: new Date(reservation.expiresAt).toISOString(),
      })),
    };
  },
});

async function mapItems(ctx: any, items: any[]) {
  return await Promise.all(items.map((item) => publicItem(ctx, item)));
}

async function mapArtifacts(ctx: any, artifacts: any[]) {
  const output = [];
  for (const artifact of artifacts) {
    const item = await ctx.db.get("items", artifact.itemId);
    if (!item) continue;
    output.push({
      id: artifact.externalId,
      itemId: item.externalId,
      itemTitle: item.title,
      actorId: artifact.actorExternalId,
      kind: artifact.kind,
      label: artifact.label,
      uri: artifact.uri,
      createdAt: new Date(artifact.createdAt).toISOString(),
    });
  }
  return output;
}
