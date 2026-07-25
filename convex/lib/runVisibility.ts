import type { Doc } from "../_generated/dataModel";
import { publicRun, type QueryContext } from "./domain";

const visibleStatuses = [
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
const activeStatuses = new Set<Doc<"runs">["status"]>(["running", "waiting"]);
export const MAX_VISIBLE_ITEM_RUNS = 20;

export async function readPublicItemRuns(
  ctx: QueryContext,
  item: Doc<"items">,
  limit = MAX_VISIBLE_ITEM_RUNS,
) {
  const normalizedLimit = normalizeLimit(limit);
  const groups = await Promise.all(visibleStatuses.map(async (status) =>
    await ctx.db
      .query("runs")
      .withIndex("by_item_status", (q) =>
        q.eq("itemId", item._id).eq("status", status),
      )
      .order("desc")
      .take(normalizedLimit),
  ));

  return groups
    .flat()
    .sort((left, right) =>
      Number(activeStatuses.has(right.status)) - Number(activeStatuses.has(left.status))
      || right.lastHeartbeatAt - left.lastHeartbeatAt
      || right.startedAt - left.startedAt
      || left.externalId.localeCompare(right.externalId),
    )
    .slice(0, normalizedLimit)
    .map((run) => ({
      ...publicRun(run),
      itemId: item.externalId,
    }));
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_VISIBLE_ITEM_RUNS) {
    throw new Error(`Item run limit must be between 1 and ${MAX_VISIBLE_ITEM_RUNS}`);
  }
  return value;
}
