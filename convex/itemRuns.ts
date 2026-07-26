import { v } from "convex/values";
import {
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import {
  executionActualValidator,
  executionEnvelopeValidator,
} from "./lib/executionEnvelope";
import {
  MAX_VISIBLE_ITEM_RUNS,
  readPublicItemRuns,
} from "./lib/runVisibility";
import { query } from "./lib/server";
import { runStatusValidator, serviceArgs } from "./lib/validators";

const nullableString = v.union(v.string(), v.null());
const nullableExecutionEnvelope = v.union(executionEnvelopeValidator, v.null());
const executionRecordValidator = v.object({
  id: v.string(),
  runId: v.string(),
  runGeneration: v.number(),
  leaseGeneration: v.number(),
  transition: v.string(),
  actual: executionActualValidator,
  createdAt: v.string(),
});
const executionProjection = {
  executionEnvelope: nullableExecutionEnvelope,
  executionRecords: v.array(executionRecordValidator),
};
const legacyItemRunValidator = v.object({
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
  generation: v.number(),
  leaseGeneration: v.number(),
  childAgentCount: v.union(v.number(), v.null()),
  toolCallCount: v.union(v.number(), v.null()),
  startedAt: v.string(),
  lastHeartbeatAt: v.string(),
  endedAt: nullableString,
  outcome: nullableString,
  ...executionProjection,
});
const queuedRunStatusValidator = v.union(
  v.literal("queued"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("blocked"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("abandoned"),
);
const queuedItemRunValidator = v.object({
  id: v.string(),
  itemId: v.string(),
  actorId: v.string(),
  runnerType: v.string(),
  runnerProfile: v.string(),
  externalRunId: nullableString,
  status: queuedRunStatusValidator,
  generation: v.number(),
  leaseGeneration: v.number(),
  leaseOwnerId: nullableString,
  leaseExpiresAt: nullableString,
  lastHeartbeatAt: nullableString,
  checkpoint: nullableString,
  outcome: nullableString,
  continuationRef: nullableString,
  usage: v.any(),
  retryAttempt: v.number(),
  maxAttempts: v.number(),
  retryBackoffSeconds: v.number(),
  nextRetryAt: nullableString,
  createdAt: v.string(),
  updatedAt: v.string(),
  startedAt: nullableString,
  endedAt: nullableString,
  ...executionProjection,
});
const itemRunValidator = v.union(
  legacyItemRunValidator,
  queuedItemRunValidator,
);

export const list = query({
  args: {
    ...serviceArgs,
    itemId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(itemRunValidator),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.itemId} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.itemId);
    return await readPublicItemRuns(
      ctx,
      item,
      args.limit ?? MAX_VISIBLE_ITEM_RUNS,
    );
  },
});
