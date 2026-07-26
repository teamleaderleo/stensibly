import { v } from "convex/values";
import {
  appendEvent,
  findWorkspace,
  normalizeWorkspace,
  requireMatchingIdempotency,
  requireServiceSecret,
} from "./lib/domain";
import {
  appendExecutionActualEvent,
  executionActualValidator,
  normalizeExecutionActual,
  readHostedRunExecution,
  sameCanonical,
} from "./lib/executionEnvelope";
import { mutation } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const terminalQueuedRunStatusValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("abandoned"),
);
const liveQueuedStatuses = new Set([
  "queued",
  "starting",
  "running",
  "waiting",
  "blocked",
]);

export const finish = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actorId: v.string(),
    expectedGeneration: v.number(),
    expectedLeaseGeneration: v.number(),
    status: terminalQueuedRunStatusValidator,
    outcome: v.optional(v.string()),
    usage: v.optional(v.any()),
    executionActual: v.optional(executionActualValidator),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Queued run ${args.id} does not exist`);
    const input = normalizeFinishInput(args);
    const run = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", workspace._id).eq("externalId", input.id)
      )
      .unique();
    if (!run || !run.continuationRef) {
      throw new Error(`Supervisor queued run ${input.id} does not exist`);
    }

    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      input.idempotencyKey,
      "run.finished",
    );
    if (existing) {
      const payload = record(existing.payload);
      if (payload?.runId !== run.externalId) {
        throw new Error("Idempotency key was already used for a different queued run finish");
      }
      requireSameRequest(payload?.request, finishRequest(input));
      const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
      const latest = execution.executionRecords.at(-1);
      if (
        !latest
        || latest.transition !== `finish:${input.status}`
        || !sameCanonical(latest.actual, input.executionActual)
      ) {
        throw new Error("Idempotency key belongs to a different queued run finish result");
      }
      const current = await ctx.db.get("queuedRuns", run._id);
      const item = await ctx.db.get("items", run.itemId);
      return publicQueuedRun(current ?? run, item?.externalId ?? String(run.itemId), execution);
    }

    if (!liveQueuedStatuses.has(run.status)) {
      throw new Error("Queued run is already terminal");
    }
    if (run.leaseOwnerExternalId !== input.actorId) {
      throw new Error("Only the queued run lease owner can finish it");
    }
    if (run.generation !== input.expectedGeneration) {
      throw new Error(
        `Queued run generation changed from ${input.expectedGeneration} to ${run.generation}`,
      );
    }
    if (run.leaseGeneration !== input.expectedLeaseGeneration) {
      throw new Error(
        `Queued run lease generation changed from ${input.expectedLeaseGeneration} to ${run.leaseGeneration}`,
      );
    }

    const execution = await readHostedRunExecution(ctx, run.itemId, run.externalId);
    if (!execution.executionEnvelope) {
      throw new Error("Supervisor queued run has no execution envelope");
    }
    if (
      execution.runGeneration !== run.generation
      || execution.leaseGeneration !== run.leaseGeneration
    ) {
      throw new Error("Queued run execution history does not match current generations");
    }

    const now = Date.now();
    const nextGeneration = run.generation + 1;
    await ctx.db.patch(run._id, {
      status: input.status,
      generation: nextGeneration,
      outcome: input.outcome,
      ...(input.usageProvided ? { usage: input.usage } : {}),
      lastHeartbeatAt: now,
      endedAt: now,
      updatedAt: now,
      nextRetryAt: undefined,
    });
    const appendedActual = await appendExecutionActualEvent(ctx, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      itemId: run.itemId,
      actorId: run.actorId,
      actorExternalId: run.actorExternalId,
      runId: run.externalId,
      runGeneration: nextGeneration,
      leaseGeneration: run.leaseGeneration,
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
        leaseGeneration: run.leaseGeneration,
        envelopeSchemaVersion: execution.executionEnvelope.schemaVersion,
        source: "supervisor_dispatch",
        request: finishRequest(input),
      },
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    });
    const updated = await ctx.db.get("queuedRuns", run._id);
    const item = await ctx.db.get("items", run.itemId);
    if (!updated || !item) throw new Error("Finished queued run disappeared");
    return publicQueuedRun(updated, item.externalId, {
      executionEnvelope: execution.executionEnvelope,
      executionRecords: [...execution.executionRecords, appendedActual],
      runGeneration: nextGeneration,
      leaseGeneration: run.leaseGeneration,
    });
  },
});

function normalizeFinishInput(args: any) {
  const id = requiredText(args.id, "Queued run ID", 240);
  const actorId = requiredText(args.actorId, "Actor ID", 120);
  const expectedGeneration = positiveInteger(args.expectedGeneration, "Expected generation");
  const expectedLeaseGeneration = positiveInteger(
    args.expectedLeaseGeneration,
    "Expected lease generation",
  );
  const outcome = optionalText(args.outcome, "Outcome", 10_000);
  const executionActual = normalizeExecutionActual(args.executionActual);
  return {
    id,
    actorId,
    expectedGeneration,
    expectedLeaseGeneration,
    status: args.status as "succeeded" | "failed" | "cancelled" | "abandoned",
    outcome,
    usage: args.usage ?? {},
    usageProvided: args.usage !== undefined,
    executionActual,
    idempotencyKey: optionalText(args.idempotencyKey, "Idempotency key", 240),
  };
}

function finishRequest(input: ReturnType<typeof normalizeFinishInput>) {
  return {
    id: input.id,
    actorId: input.actorId,
    expectedGeneration: input.expectedGeneration,
    expectedLeaseGeneration: input.expectedLeaseGeneration,
    status: input.status,
    outcome: input.outcome,
    ...(input.usageProvided ? { usage: input.usage } : {}),
    executionActual: input.executionActual,
  };
}

function requireSameRequest(existing: unknown, requested: unknown): void {
  if (!sameCanonical(existing, requested)) {
    throw new Error("Idempotency key was already used for a different queued run finish request");
  }
}

function publicQueuedRun(run: any, itemId: string, execution: any) {
  return {
    id: run.externalId,
    itemId,
    actorId: run.actorExternalId,
    runnerType: run.runnerType,
    runnerProfile: run.runnerProfile,
    externalRunId: run.externalRunId ?? null,
    status: run.status,
    generation: run.generation,
    leaseGeneration: run.leaseGeneration,
    leaseOwnerId: run.leaseOwnerExternalId ?? null,
    leaseExpiresAt: run.leaseExpiresAt === undefined
      ? null
      : new Date(run.leaseExpiresAt).toISOString(),
    lastHeartbeatAt: run.lastHeartbeatAt === undefined
      ? null
      : new Date(run.lastHeartbeatAt).toISOString(),
    checkpoint: run.checkpoint ?? null,
    outcome: run.outcome ?? null,
    continuationRef: run.continuationRef ?? null,
    usage: run.usage,
    retryAttempt: run.retryAttempt,
    maxAttempts: run.maxAttempts,
    retryBackoffSeconds: run.retryBackoffSeconds,
    nextRetryAt: run.nextRetryAt === undefined
      ? null
      : new Date(run.nextRetryAt).toISOString(),
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
    startedAt: run.startedAt === undefined ? null : new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt === undefined ? null : new Date(run.endedAt).toISOString(),
    executionEnvelope: execution.executionEnvelope,
    executionRecords: execution.executionRecords,
  };
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new Error(`${label} is required`);
  if (output.length > maximum || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new Error(`${label} is invalid`);
  }
  return output;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, label, maximum);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
