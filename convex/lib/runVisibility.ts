import { publicRun } from "./domain";

const activeStatuses = new Set(["running", "waiting"]);

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
