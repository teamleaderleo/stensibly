import type { Doc } from "../_generated/dataModel";
import { publicRun, type QueryContext } from "./domain";
import { readHostedRunExecution } from "./executionEnvelope";

const legacyStatuses = [
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
const queuedStatuses = [
  "queued",
  "starting",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
] as const;
const activeStatuses = new Set(["queued", "starting", "running", "waiting", "blocked"]);
export const MAX_VISIBLE_ITEM_RUNS = 20;

type RunCandidate =
  | { family: "legacy"; run: Doc<"runs"> }
  | { family: "queued"; run: Doc<"queuedRuns"> };

export async function readPublicItemRuns(
  ctx: QueryContext,
  item: Doc<"items">,
  limit = MAX_VISIBLE_ITEM_RUNS,
) {
  const normalizedLimit = normalizeLimit(limit);
  const [legacyGroups, queuedGroups] = await Promise.all([
    readLegacyGroups(ctx, item, normalizedLimit),
    Promise.all(queuedStatuses.map(async (status) =>
      await ctx.db
        .query("queuedRuns")
        .withIndex("by_item_status", (q) =>
          q.eq("itemId", item._id).eq("status", status),
        )
        .order("desc")
        .take(normalizedLimit),
    )),
  ]);
  const selected: RunCandidate[] = [
    ...legacyGroups.flat().map((run) => ({ family: "legacy" as const, run })),
    ...queuedGroups.flat().map((run) => ({ family: "queued" as const, run })),
  ]
    .sort(compareCandidates)
    .slice(0, normalizedLimit);

  return await Promise.all(selected.map(async (candidate) => {
    const execution = await readHostedRunExecution(
      ctx,
      item._id,
      candidate.run.externalId,
    );
    return candidate.family === "legacy"
      ? publicLegacyRun(candidate.run, item.externalId, execution)
      : publicQueuedRun(candidate.run, item.externalId, execution);
  }));
}

export async function readPublicLegacyItemRuns(
  ctx: QueryContext,
  item: Doc<"items">,
  limit = MAX_VISIBLE_ITEM_RUNS,
) {
  const normalizedLimit = normalizeLimit(limit);
  const groups = await readLegacyGroups(ctx, item, normalizedLimit);
  const selected = groups
    .flat()
    .sort((left, right) =>
      Number(activeStatuses.has(right.status)) - Number(activeStatuses.has(left.status))
      || right.lastHeartbeatAt - left.lastHeartbeatAt
      || right.startedAt - left.startedAt
      || left.externalId.localeCompare(right.externalId),
    )
    .slice(0, normalizedLimit);
  return await Promise.all(selected.map(async (run) =>
    publicLegacyRun(
      run,
      item.externalId,
      await readHostedRunExecution(ctx, item._id, run.externalId),
    )
  ));
}

export function publicItemRuns(
  runs: Doc<"runs">[],
  itemExternalId: string,
  limit = MAX_VISIBLE_ITEM_RUNS,
) {
  const normalizedLimit = normalizeLimit(limit);
  return [...runs]
    .sort((left, right) =>
      Number(activeStatuses.has(right.status)) - Number(activeStatuses.has(left.status))
      || right.lastHeartbeatAt - left.lastHeartbeatAt
      || right.startedAt - left.startedAt
      || left.externalId.localeCompare(right.externalId),
    )
    .slice(0, normalizedLimit)
    .map((run) => ({
      ...publicRun(run),
      itemId: itemExternalId,
    }));
}

async function readLegacyGroups(
  ctx: QueryContext,
  item: Doc<"items">,
  limit: number,
) {
  return await Promise.all(legacyStatuses.map(async (status) =>
    await ctx.db
      .query("runs")
      .withIndex("by_item_status", (q) =>
        q.eq("itemId", item._id).eq("status", status),
      )
      .order("desc")
      .take(limit),
  ));
}

function compareCandidates(left: RunCandidate, right: RunCandidate): number {
  return Number(activeStatuses.has(right.run.status))
    - Number(activeStatuses.has(left.run.status))
    || candidateUpdatedAt(right) - candidateUpdatedAt(left)
    || candidateCreatedAt(right) - candidateCreatedAt(left)
    || left.run.externalId.localeCompare(right.run.externalId);
}

function candidateUpdatedAt(candidate: RunCandidate): number {
  return candidate.family === "legacy"
    ? candidate.run.lastHeartbeatAt
    : candidate.run.updatedAt;
}

function candidateCreatedAt(candidate: RunCandidate): number {
  return candidate.family === "legacy"
    ? candidate.run.startedAt
    : candidate.run.createdAt;
}

function publicLegacyRun(
  run: Doc<"runs">,
  itemId: string,
  execution: Awaited<ReturnType<typeof readHostedRunExecution>>,
) {
  return {
    ...publicRun(run),
    itemId,
    generation: 1,
    leaseGeneration: 1,
    executionEnvelope: execution.executionEnvelope,
    executionRecords: execution.executionRecords,
  };
}

function publicQueuedRun(
  run: Doc<"queuedRuns">,
  itemId: string,
  execution: Awaited<ReturnType<typeof readHostedRunExecution>>,
) {
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

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_VISIBLE_ITEM_RUNS) {
    throw new Error(`Item run limit must be between 1 and ${MAX_VISIBLE_ITEM_RUNS}`);
  }
  return value;
}
