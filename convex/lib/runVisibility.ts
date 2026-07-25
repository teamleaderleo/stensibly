import { publicRun } from "./domain";

const statuses = ["running", "waiting", "succeeded", "failed", "cancelled"] as const;
const activeStatuses = new Set(["running", "waiting"]);

export async function loadItemRuns(ctx: any, itemId: any, limit = 20) {
  const groups = await Promise.all(statuses.map(async (status) =>
    await ctx.db
      .query("runs")
      .withIndex("by_item_status", (q: any) =>
        q.eq("itemId", itemId).eq("status", status),
      )
      .order("desc")
      .take(limit),
  ));
  return groups.flat();
}

export function publicItemRuns(runs: any[], itemExternalId: string, limit = 20) {
  return [...runs]
    .sort((a, b) =>
      Number(activeStatuses.has(b.status)) - Number(activeStatuses.has(a.status))
      || b.lastHeartbeatAt - a.lastHeartbeatAt
      || b.startedAt - a.startedAt
      || a.externalId.localeCompare(b.externalId),
    )
    .slice(0, limit)
    .map((run) => ({ ...publicRun(run), itemId: itemExternalId }));
}
