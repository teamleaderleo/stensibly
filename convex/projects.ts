import { v } from "convex/values";
import {
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  publicArtifact,
  publicItem,
  publicRun,
  requireServiceSecret,
} from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

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
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    const projectSlug = assertSlug(args.project, "Project");
    if (!workspace) return emptyBrief(projectSlug);
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return emptyBrief(projectSlug);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 10), 1), 100);

    const items = await ctx.db
      .query("items")
      .withIndex("by_project_status", (q) => q.eq("projectId", project._id))
      .collect();
    const byStatus = {
      ready: items.filter((item) => item.status === "ready"),
      active: items.filter((item) => item.status === "active"),
      blocked: items.filter((item) => item.status === "blocked"),
      done: items.filter((item) => item.status === "done"),
      archived: items.filter((item) => item.status === "archived"),
    };
    const countsByKind: Record<string, number> = {};
    for (const item of items) countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1;

    const knowledgeKinds = new Set(["finding", "question", "decision", "tip", "handoff", "note"]);
    const recentKnowledge = items
      .filter((item) => knowledgeKinds.has(item.kind) && item.status !== "archived")
      .sort((a, b) => b.updatedAt - a.updatedAt)
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
    const activeReservations = (await ctx.db.query("reservations").collect())
      .filter(
        (reservation) =>
          reservation.projectId === project._id &&
          reservation.status === "active" &&
          reservation.expiresAt > Date.now(),
      )
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, limit);

    return {
      workspace: workspace.slug,
      project: project.slug,
      generatedAt: new Date().toISOString(),
      counts: {
        total: items.length,
        byStatus: Object.fromEntries(
          Object.entries(byStatus).map(([status, values]) => [status, values.length]),
        ),
        byKind: countsByKind,
      },
      ready: await mapItems(
        ctx,
        byStatus.ready
          .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
          .slice(0, limit),
      ),
      active: await mapItems(
        ctx,
        byStatus.active.sort((a, b) => (a.claimExpiresAt ?? Infinity) - (b.claimExpiresAt ?? Infinity)).slice(0, limit),
      ),
      blocked: await mapItems(
        ctx,
        byStatus.blocked.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt).slice(0, limit),
      ),
      recentKnowledge: await mapItems(ctx, recentKnowledge),
      recentlyCompleted: await mapItems(
        ctx,
        byStatus.done.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),
      ),
      recentArtifacts: recentArtifacts.map((artifact) => publicArtifact(artifact)),
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

function emptyBrief(project: string) {
  return {
    workspace: null,
    project,
    generatedAt: new Date().toISOString(),
    counts: { total: 0, byStatus: {}, byKind: {} },
    ready: [],
    active: [],
    blocked: [],
    recentKnowledge: [],
    recentlyCompleted: [],
    recentArtifacts: [],
    activeRuns: [],
    activeReservations: [],
  };
}
