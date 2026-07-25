import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  publicItem,
  publicRun,
  requireServiceSecret,
  type QueryContext,
} from "./lib/domain";
import { query } from "./lib/server";
import {
  artifactKindValidator,
  itemKinds,
  itemKindValidator,
  itemStatuses,
  itemStatusValidator,
  reservationModeValidator,
  runStatusValidator,
  serviceArgs,
  type ItemKind,
  type ItemStatus,
} from "./lib/validators";

const MAX_PROJECT_ITEMS = 5_000;
const MAX_WORKSPACE_PROJECTS = 1_000;
const activeRunStatuses = ["running", "waiting"] as const;
const knowledgeKinds = new Set<ItemKind>([
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
]);

const nullableString = v.union(v.string(), v.null());
const projectValidator = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
});
const publicItemValidator = v.object({
  id: v.string(),
  project: v.string(),
  kind: itemKindValidator,
  title: v.string(),
  summary: nullableString,
  status: itemStatusValidator,
  priority: v.number(),
  nextAction: nullableString,
  claimedBy: nullableString,
  claimExpiresAt: nullableString,
  version: v.number(),
  createdAt: v.string(),
  updatedAt: v.string(),
});
const briefArtifactValidator = v.object({
  id: v.string(),
  itemId: v.string(),
  itemTitle: v.string(),
  actorId: v.string(),
  kind: artifactKindValidator,
  label: v.string(),
  uri: v.string(),
  createdAt: v.string(),
});
const publicRunValidator = v.object({
  id: v.string(),
  itemId: v.string(),
  actorId: v.string(),
  harness: v.string(),
  model: nullableString,
  externalRunId: nullableString,
  repository: nullableString,
  branch: nullableString,
  worktree: nullableString,
  status: runStatusValidator,
  childAgentCount: v.union(v.number(), v.null()),
  toolCallCount: v.union(v.number(), v.null()),
  startedAt: v.string(),
  lastHeartbeatAt: v.string(),
  endedAt: nullableString,
  outcome: nullableString,
});
const reservationValidator = v.object({
  id: v.string(),
  resource: v.string(),
  mode: reservationModeValidator,
  units: v.number(),
  capacity: v.number(),
  holderActorId: v.string(),
  expiresAt: v.string(),
});
const statusCountsValidator = v.object({
  ready: v.number(),
  active: v.number(),
  blocked: v.number(),
  done: v.number(),
  archived: v.number(),
});
const kindCountsValidator = v.object({
  task: v.number(),
  finding: v.number(),
  question: v.number(),
  decision: v.number(),
  tip: v.number(),
  handoff: v.number(),
  note: v.number(),
});
const projectBriefValidator = v.object({
  workspace: v.string(),
  project: v.string(),
  generatedAt: v.string(),
  counts: v.object({
    total: v.number(),
    byStatus: statusCountsValidator,
    byKind: kindCountsValidator,
  }),
  ready: v.array(publicItemValidator),
  active: v.array(publicItemValidator),
  blocked: v.array(publicItemValidator),
  knowledge: v.array(publicItemValidator),
  recentlyCompleted: v.array(publicItemValidator),
  recentArtifacts: v.array(briefArtifactValidator),
  activeRuns: v.array(publicRunValidator),
  activeReservations: v.array(reservationValidator),
});

export const list = query({
  args: { ...serviceArgs },
  returns: v.array(projectValidator),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_WORKSPACE_PROJECTS + 1);
    if (projects.length > MAX_WORKSPACE_PROJECTS) {
      throw new Error(`Workspace ${workspace.slug} has too many projects to list safely`);
    }
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
    now: v.number(),
  },
  returns: projectBriefValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const projectSlug = assertSlug(args.project, "Project");
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Project ${projectSlug} does not exist`);
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error(`Project ${projectSlug} does not exist`);
    const limit = normalizeLimit(args.limit ?? 10);
    const now = normalizeTimestamp(args.now);

    const items = await ctx.db
      .query("items")
      .withIndex("by_project_status", (q) => q.eq("projectId", project._id))
      .take(MAX_PROJECT_ITEMS + 1);
    if (items.length > MAX_PROJECT_ITEMS) {
      throw new Error(`Project ${projectSlug} has too many items for a bounded brief`);
    }

    const byStatus = Object.fromEntries(
      itemStatuses.map((status) => [status, [] as Doc<"items">[]]),
    ) as Record<ItemStatus, Doc<"items">[]>;
    const countsByKind = Object.fromEntries(
      itemKinds.map((kind) => [kind, 0]),
    ) as Record<ItemKind, number>;
    for (const item of items) {
      byStatus[item.status].push(item);
      countsByKind[item.kind] += 1;
    }

    const newestFirst = (left: Doc<"items">, right: Doc<"items">) =>
      right.updatedAt - left.updatedAt || right.priority - left.priority;
    const priorityFirst = (left: Doc<"items">, right: Doc<"items">) =>
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

    const activeRuns = (await Promise.all(activeRunStatuses.map(async (status) =>
      await ctx.db
        .query("runs")
        .withIndex("by_project_status", (q) =>
          q.eq("projectId", project._id).eq("status", status),
        )
        .order("desc")
        .take(limit)
    )))
      .flat()
      .sort((left, right) => right.lastHeartbeatAt - left.lastHeartbeatAt)
      .slice(0, limit);

    const activeReservations = await ctx.db
      .query("reservations")
      .withIndex("by_project_status", (q) =>
        q
          .eq("projectId", project._id)
          .eq("status", "active")
          .gt("expiresAt", now),
      )
      .order("asc")
      .take(limit);

    return {
      workspace: workspace.slug,
      project: project.slug,
      generatedAt: new Date(now).toISOString(),
      counts: {
        total: items.length,
        byStatus: Object.fromEntries(
          itemStatuses.map((status) => [status, byStatus[status].length]),
        ) as Record<ItemStatus, number>,
        byKind: countsByKind,
      },
      ready: await mapItems(ctx, byStatus.ready.sort(priorityFirst).slice(0, limit)),
      active: await mapItems(ctx, byStatus.active.sort(newestFirst).slice(0, limit)),
      blocked: await mapItems(ctx, byStatus.blocked.sort(priorityFirst).slice(0, limit)),
      knowledge: await mapItems(ctx, knowledge),
      recentlyCompleted: await mapItems(ctx, byStatus.done.sort(newestFirst).slice(0, limit)),
      recentArtifacts: await mapArtifacts(ctx, recentArtifacts),
      activeRuns: activeRuns.map(publicRun),
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

async function mapItems(ctx: QueryContext, items: Doc<"items">[]) {
  return await Promise.all(items.map((item) => publicItem(ctx, item)));
}

async function mapArtifacts(ctx: QueryContext, artifacts: Doc<"artifacts">[]) {
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

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Brief limit must be between 1 and 100");
  }
  return value;
}

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 8.64e15) {
    throw new Error("Brief time must be a valid Unix timestamp in milliseconds");
  }
  return value;
}
