import { v } from "convex/values";
import {
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import {
  MAX_VISIBLE_ITEM_RUNS,
  readPublicItemRuns,
} from "./lib/runVisibility";
import { query } from "./lib/server";
import { runStatusValidator, serviceArgs } from "./lib/validators";

const nullableString = v.union(v.string(), v.null());
const itemRunValidator = v.object({
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
