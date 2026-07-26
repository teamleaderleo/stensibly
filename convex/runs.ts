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
import {
  appendExecutionActualEvent,
  appendExecutionEnvelopeEvent,
  executionActualValidator,
  executionEnvelopeValidator,
  normalizeExecutionActual,
  normalizeExecutionEnvelope,
  readHostedRunExecution,
  sameCanonical,
} from "./lib/executionEnvelope";
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
    executionEnvelope: v.optional(executionEnvelopeValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeStartInput(args);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${input.itemId} does not exist`);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      input.idempotencyKey,
      "run.started",
    );
    if (existing) {
      const payload = record(existing.payload);
      const runExternalId = payload?.runId;
      if (typeof runExternalId !== "string") {
        throw new Error("Run idempotency record is incomplete");
      }
      const run = await ctx.db
        .query("runs")
        .withIndex("by_external_id", (q) => q.eq("externalId", runExternalId))
        .unique();
      if (!run) throw new Error("Idempotent run no longer exists");
      const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
      if (!execution.executionEnvelope) {
        if (input.executionEnvelopeProvided) {
          throw new Error(
            "Historical run start cannot be retrofitted with an execution envelope",
          );
        }
        return await publicHostedRun(ctx, run, input.itemId, execution);
      }
      requireSameRequest(payload?.request, startRequest(input), "run start request");
      return await publicHostedRun(ctx, run, input.itemId, execution);
    }

    const item = await getItemByExternalId(ctx, workspace._id, input.itemId);
    const actor = await upsertActor(ctx, workspace._id, input.actor);
    if (!actor) throw new Error("Failed to create actor");
    const now = Date.now();
    const runId = await ctx.db.insert("runs", {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      externalId: "pending",
      actorId: actor._id,
      actorExternalId: actor.externalId,
      harness: input.harness,
      model: input.model,
      externalRunId: input.externalRunId,
      repository: input.repository,
      branch: input.branch,
      worktree: input.worktree,
      status: "running",
      startedAt: now,
      lastHeartbeatAt: now,
    });
    const externalId = `run_${runId}`;
    await ctx.db.patch(runId, { externalId });
    await appendExecutionEnvelopeEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      runId: externalId,
      runGeneration: 1,
      leaseGeneration: 1,
      envelope: input.executionEnvelope,
      createdAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "run.started",
      payload: {
        runId: externalId,
        generation: 1,
        leaseGeneration: 1,
        envelopeSchemaVersion: input.executionEnvelope.schemaVersion,
        request: startRequest(input),
      },
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    });
    const run = await ctx.db.get("runs", runId);
    if (!run) throw new Error("Started run disappeared");
    return await publicHostedRun(ctx, run, item.externalId, {
      executionEnvelope: input.executionEnvelope,
      executionRecords: [],
      runGeneration: 1,
      leaseGeneration: 1,
    });
  },
});

export const heartbeat = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actorId: v.string(),
    expectedGeneration: v.optional(v.number()),
    status: v.optional(runStatusValidator),
    checkpoint: v.optional(v.string()),
    childAgentCount: v.optional(v.number()),
    toolCallCount: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const run = await getRun(ctx, args.id);
    await assertRunWorkspace(ctx, run, args.workspace);
    if (run.actorExternalId !== args.actorId) {
      throw new Error("Only the run owner can heartbeat it");
    }
    if (!["running", "waiting"].includes(run.status)) {
      throw new Error("Run is already finished");
    }
    const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
    const generation = requireExpectedGeneration(
      execution,
      args.expectedGeneration,
      "heartbeat",
    );
    const now = Date.now();
    const checkpoint = assertOptionalText(args.checkpoint, "Checkpoint", 10_000);
    const patch: Record<string, unknown> = {
      status: args.status ?? run.status,
      lastHeartbeatAt: now,
    };
    if (args.childAgentCount !== undefined) {
      patch.childAgentCount = count(args.childAgentCount, "Child agent count");
    }
    if (args.toolCallCount !== undefined) {
      patch.toolCallCount = count(args.toolCallCount, "Tool call count");
    }
    await ctx.db.patch(run._id, patch);
    await appendEvent(ctx, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      itemId: run.itemId,
      actorId: run.actorId,
      actorExternalId: run.actorExternalId,
      type: "run.heartbeat",
      payload: {
        runId: run.externalId,
        generation,
        leaseGeneration: execution.leaseGeneration ?? 1,
        envelopeSchemaVersion: execution.executionEnvelope?.schemaVersion ?? null,
        status: args.status ?? run.status,
        ...(checkpoint ? { checkpoint } : {}),
        ...(args.childAgentCount !== undefined
          ? { childAgentCount: patch.childAgentCount }
          : {}),
        ...(args.toolCallCount !== undefined
          ? { toolCallCount: patch.toolCallCount }
          : {}),
      },
      createdAt: now,
    });
    const updated = await ctx.db.get("runs", run._id);
    if (!updated) throw new Error("Run disappeared");
    const item = await ctx.db.get("items", run.itemId);
    return await publicHostedRun(
      ctx,
      updated,
      item?.externalId ?? String(run.itemId),
      execution,
    );
  },
});

export const finish = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actorId: v.string(),
    expectedGeneration: v.optional(v.number()),
    status: runStatusValidator,
    outcome: v.optional(v.string()),
    childAgentCount: v.optional(v.number()),
    toolCallCount: v.optional(v.number()),
    executionActual: v.optional(executionActualValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    if (!["succeeded", "failed", "cancelled"].includes(args.status)) {
      throw new Error("A finished run must succeed, fail, or be cancelled");
    }
    const run = await getRun(ctx, args.id);
    const workspace = await assertRunWorkspace(ctx, run, args.workspace);
    const input = normalizeFinishInput(args);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      input.idempotencyKey,
      "run.finished",
    );
    if (existing) {
      const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
      if (execution.executionRecords.length === 0) {
        if (input.executionActualProvided || input.expectedGenerationProvided) {
          throw new Error(
            "Historical run finish cannot be retrofitted with versioned execution data",
          );
        }
        const current = await ctx.db.get("runs", run._id);
        const item = await ctx.db.get("items", run.itemId);
        return await publicHostedRun(
          ctx,
          current ?? run,
          item?.externalId ?? String(run.itemId),
          execution,
        );
      }
      const payload = record(existing.payload);
      requireSameRequest(payload?.request, finishRequest(input), "run finish request");
      const actual = execution.executionRecords.at(-1);
      if (
        !actual
        || actual.transition !== `finish:${input.status}`
        || !sameCanonical(actual.actual, input.executionActual)
      ) {
        throw new Error(
          "Idempotency key belongs to a different run finish result",
        );
      }
      const current = await ctx.db.get("runs", run._id);
      const item = await ctx.db.get("items", run.itemId);
      return await publicHostedRun(
        ctx,
        current ?? run,
        item?.externalId ?? String(run.itemId),
        execution,
      );
    }
    if (run.actorExternalId !== input.actorId) {
      throw new Error("Only the run owner can finish it");
    }
    if (!["running", "waiting"].includes(run.status)) {
      throw new Error("Run is already finished");
    }
    const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
    const currentGeneration = requireExpectedGeneration(
      execution,
      input.expectedGeneration,
      "finish",
    );
    const nextGeneration = currentGeneration + 1;
    const now = Date.now();
    const patch: Record<string, unknown> = {
      status: input.status,
      outcome: input.outcome,
      lastHeartbeatAt: now,
      endedAt: now,
    };
    if (input.childAgentCount !== undefined) {
      patch.childAgentCount = input.childAgentCount;
    }
    if (input.toolCallCount !== undefined) {
      patch.toolCallCount = input.toolCallCount;
    }
    await ctx.db.patch(run._id, patch);
    const item = await ctx.db.get("items", run.itemId);
    if (!item) throw new Error("Run item no longer exists");
    const appendedActual = await appendExecutionActualEvent(ctx, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      itemId: run.itemId,
      actorId: run.actorId,
      actorExternalId: run.actorExternalId,
      runId: run.externalId,
      runGeneration: nextGeneration,
      leaseGeneration: execution.leaseGeneration ?? 1,
      transition: `finish:${input.status}`,
      actual: input.executionActual,
      createdAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      itemId: run.itemId,
      actorId: run.actorId,
      actorExternalId: run.actorExternalId,
      type: "run.finished",
      payload: {
        runId: run.externalId,
        generation: nextGeneration,
        leaseGeneration: execution.leaseGeneration ?? 1,
        envelopeSchemaVersion: execution.executionEnvelope?.schemaVersion ?? null,
        request: finishRequest(input),
      },
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    });
    const updated = await ctx.db.get("runs", run._id);
    if (!updated) throw new Error("Finished run disappeared");
    return await publicHostedRun(ctx, updated, item.externalId, {
      executionEnvelope: execution.executionEnvelope,
      executionRecords: [...execution.executionRecords, appendedActual],
      runGeneration: nextGeneration,
      leaseGeneration: execution.leaseGeneration ?? 1,
    });
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
    const runs: any[] = [];
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
      const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
      output.push(await publicHostedRun(
        ctx,
        run,
        item?.externalId ?? String(run.itemId),
        execution,
      ));
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
  if (!workspace || workspace._id !== run.workspaceId) {
    throw new Error(`Run ${run.externalId} does not exist`);
  }
  return workspace;
}

async function publicHostedRun(
  _ctx: any,
  run: any,
  itemId: string,
  execution: Awaited<ReturnType<typeof readHostedRunExecution>>,
) {
  return {
    ...publicRun(run),
    itemId,
    generation: execution.runGeneration ?? 1,
    leaseGeneration: execution.leaseGeneration ?? 1,
    executionEnvelope: execution.executionEnvelope,
    executionRecords: execution.executionRecords,
  };
}

function normalizeStartInput(args: any) {
  const itemId = assertText(args.itemId, "Item id", 240);
  const harness = assertText(args.harness, "Harness", 160);
  return {
    itemId,
    actor: args.actor,
    harness,
    model: assertOptionalText(args.model, "Model", 160),
    externalRunId: assertOptionalText(args.externalRunId, "External run id", 240),
    repository: assertOptionalText(args.repository, "Repository", 500),
    branch: assertOptionalText(args.branch, "Branch", 500),
    worktree: assertOptionalText(args.worktree, "Worktree", 1_000),
    executionEnvelopeProvided: args.executionEnvelope !== undefined,
    executionEnvelope: normalizeExecutionEnvelope(
      args.executionEnvelope,
      `Execute work item ${itemId} with harness ${harness}`,
    ),
    idempotencyKey: args.idempotencyKey as string | undefined,
  };
}

function normalizeFinishInput(args: any) {
  return {
    actorId: assertText(args.actorId, "Actor id", 120),
    expectedGenerationProvided: args.expectedGeneration !== undefined,
    expectedGeneration: args.expectedGeneration === undefined
      ? undefined
      : positiveInteger(args.expectedGeneration, "Expected generation"),
    status: args.status as "succeeded" | "failed" | "cancelled",
    outcome: assertOptionalText(args.outcome, "Outcome", 10_000),
    childAgentCount: args.childAgentCount === undefined
      ? undefined
      : count(args.childAgentCount, "Child agent count"),
    toolCallCount: args.toolCallCount === undefined
      ? undefined
      : count(args.toolCallCount, "Tool call count"),
    executionActualProvided: args.executionActual !== undefined,
    executionActual: normalizeExecutionActual(args.executionActual),
    idempotencyKey: args.idempotencyKey as string | undefined,
  };
}

function startRequest(input: ReturnType<typeof normalizeStartInput>) {
  return {
    itemId: input.itemId,
    actor: input.actor,
    harness: input.harness,
    model: input.model ?? null,
    externalRunId: input.externalRunId ?? null,
    repository: input.repository ?? null,
    branch: input.branch ?? null,
    worktree: input.worktree ?? null,
    executionEnvelope: input.executionEnvelope,
  };
}

function finishRequest(input: ReturnType<typeof normalizeFinishInput>) {
  return {
    actorId: input.actorId,
    expectedGeneration: input.expectedGeneration ?? null,
    status: input.status,
    outcome: input.outcome ?? null,
    childAgentCount: input.childAgentCount ?? null,
    toolCallCount: input.toolCallCount ?? null,
    executionActual: input.executionActual,
  };
}

function requireExpectedGeneration(
  execution: Awaited<ReturnType<typeof readHostedRunExecution>>,
  expected: unknown,
  operation: string,
): number {
  if (!execution.executionEnvelope) {
    if (expected === undefined) return 1;
    const legacyExpected = positiveInteger(expected, "Expected generation");
    if (legacyExpected !== 1) {
      throw new Error(`Run generation changed from ${legacyExpected} to 1`);
    }
    return 1;
  }
  const current = execution.runGeneration;
  if (current === null) {
    throw new Error("Versioned run has no current generation");
  }
  if (expected === undefined) {
    throw new Error(`Expected generation is required to ${operation} a versioned run`);
  }
  const normalizedExpected = positiveInteger(expected, "Expected generation");
  if (normalizedExpected !== current) {
    throw new Error(`Run generation changed from ${normalizedExpected} to ${current}`);
  }
  return current;
}

function requireSameRequest(existing: unknown, requested: unknown, label: string): void {
  if (!sameCanonical(existing, requested)) {
    throw new Error(`Idempotency key was already used for a different ${label}`);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
