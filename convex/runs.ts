import { v } from "convex/values";
import {
  appendEvent,
  assertOptionalText,
  assertSlug,
  assertText,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicRun,
  requireMatchingIdempotency,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { actorValidator, runStatusValidator, serviceArgs } from "./lib/validators";

export const start = mutation({
  args: {
    ...serviceArgs,
    itemId: v.string(),
    actor: actorValidator,
    harness: v.string(),
    model: v.optional(v.string()),
    externalRunId: v.optional(v.string()),
    repository: v.optional(v.string()),
    branch: v.optional(v.string()),
    worktree: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.itemId} does not exist`);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "run.started",
    );
    if (existing) {
      const runExternalId = (existing.payload as { runId?: unknown }).runId;
      if (typeof runExternalId !== "string") throw new Error("Run idempotency record is incomplete");
      const run = await ctx.db
        .query("runs")
        .withIndex("by_external_id", (q) => q.eq("externalId", runExternalId))
        .unique();
      if (!run) throw new Error("Idempotent run no longer exists");
      return { ...publicRun(run), itemId: args.itemId };
    }

    const item = await getItemByExternalId(ctx, workspace._id, args.itemId);
    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const now = Date.now();
    const runId = await ctx.db.insert("runs", {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      externalId: "pending",
      actorId: actor._id,
      actorExternalId: actor.externalId,
      harness: assertText(args.harness, "Harness", 160),
      model: assertOptionalText(args.model, "Model", 160),
      externalRunId: assertOptionalText(args.externalRunId, "External run id", 240),
      repository: assertOptionalText(args.repository, "Repository", 500),
      branch: assertOptionalText(args.branch, "Branch", 500),
      worktree: assertOptionalText(args.worktree, "Worktree", 1_000),
      status: "running",
      startedAt: now,
      lastHeartbeatAt: now,
    });
    const externalId = `run_${runId}`;
    await ctx.db.patch(runId, { externalId });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "run.started",
      payload: {
        runId: externalId,
        harness: args.harness.trim(),
        ...(args.model ? { model: args.model.trim() } : {}),
      },
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    const run = await ctx.db.get("runs", runId);
    if (!run) throw new Error("Started run disappeared");
    return { ...publicRun(run), itemId: item.externalId };
  },
});

export const heartbeat = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actorId: v.string(),
    status: v.optional(runStatusValidator),
    childAgentCount: v.optional(v.number()),
    toolCallCount: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const run = await getRun(ctx, args.id);
    await assertRunWorkspace(ctx, run, args.workspace);
    if (run.actorExternalId !== args.actorId) throw new Error("Only the run owner can heartbeat it");
    if (!['running', 'waiting'].includes(run.status)) throw new Error("Run is already finished");
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: args.status ?? run.status,
      childAgentCount: count(args.childAgentCount, "Child agent count"),
      toolCallCount: count(args.toolCallCount, "Tool call count"),
      lastHeartbeatAt: now,
    });
    const updated = await ctx.db.get("runs", run._id);
    if (!updated) throw new Error("Run disappeared");
    const item = await ctx.db.get("items", run.itemId);
    return { ...publicRun(updated), itemId: item?.externalId ?? String(run.itemId) };
  },
});

export const finish = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actorId: v.string(),
    status: runStatusValidator,
    outcome: v.optional(v.string()),
    childAgentCount: v.optional(v.number()),
    toolCallCount: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    if (!['succeeded', 'failed', 'cancelled'].includes(args.status)) {
      throw new Error("A finished run must succeed, fail, or be cancelled");
    }
    const run = await getRun(ctx, args.id);
    const workspace = await assertRunWorkspace(ctx, run, args.workspace);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "run.finished",
    );
    if (existing) {
      const current = await ctx.db.get("runs", run._id);
      const item = await ctx.db.get("items", run.itemId);
      return { ...publicRun(current ?? run), itemId: item?.externalId ?? String(run.itemId) };
    }
    if (run.actorExternalId !== args.actorId) throw new Error("Only the run owner can finish it");
    if (!['running', 'waiting'].includes(run.status)) throw new Error("Run is already finished");
    const now = Date.now();
    const outcome = assertOptionalText(args.outcome, "Outcome", 10_000);
    await ctx.db.patch(run._id, {
      status: args.status,
      outcome,
      childAgentCount: count(args.childAgentCount, "Child agent count"),
      toolCallCount: count(args.toolCallCount, "Tool call count"),
      lastHeartbeatAt: now,
      endedAt: now,
    });
    const item = await ctx.db.get("items", run.itemId);
    if (!item) throw new Error("Run item no longer exists");
    await appendEvent(ctx, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      itemId: run.itemId,
      actorId: run.actorId,
      actorExternalId: run.actorExternalId,
      type: "run.finished",
      payload: { runId: run.externalId, status: args.status, ...(outcome ? { outcome } : {}) },
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    const updated = await ctx.db.get("runs", run._id);
    if (!updated) throw new Error("Finished run disappeared");
    return { ...publicRun(updated), itemId: item.externalId };
  },
});

export const listActive = query({
  args: {
    ...serviceArgs,
    project: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 500);
    let runs: any[] = [];
    if (args.project) {
      const project = await findProject(ctx, workspace._id, assertSlug(args.project, "Project"));
      if (!project) return [];
      for (const status of ["running", "waiting"] as const) {
        runs.push(...await ctx.db
          .query("runs")
          .withIndex("by_project_status", (q) =>
            q.eq("projectId", project._id).eq("status", status),
          )
          .collect());
      }
    } else {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_workspace_slug", (q) => q.eq("workspaceId", workspace._id))
        .collect();
      for (const project of projects) {
        for (const status of ["running", "waiting"] as const) {
          runs.push(...await ctx.db
            .query("runs")
            .withIndex("by_project_status", (q) =>
              q.eq("projectId", project._id).eq("status", status),
            )
            .collect());
        }
      }
    }
    runs.sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
    const output = [];
    for (const run of runs.slice(0, limit)) {
      const item = await ctx.db.get("items", run.itemId);
      output.push({ ...publicRun(run), itemId: item?.externalId ?? String(run.itemId) });
    }
    return output;
  },
});

async function getRun(ctx: any, externalId: string) {
  const run = await ctx.db
    .query("runs")
    .withIndex("by_external_id", (q: any) => q.eq("externalId", externalId))
    .unique();
  if (!run) throw new Error(`Run ${externalId} does not exist`);
  return run;
}

async function assertRunWorkspace(ctx: any, run: any, workspaceValue: string | undefined) {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceValue));
  if (!workspace || workspace._id !== run.workspaceId) throw new Error(`Run ${run.externalId} does not exist`);
  return workspace;
}

function count(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
