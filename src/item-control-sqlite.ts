import {
  ensureRunSchema,
  type RunUsage,
  type WorkRun,
  type WorkRunStatus,
} from "./runs.js";
import { StensiblyStore } from "./store.js";

export const MAX_ITEM_CONTROL_RUNS_PER_STATUS = 2;

const liveStatuses = ["queued", "starting", "running", "waiting"] as const;
const indexedStores = new WeakSet<StensiblyStore>();

interface RunRow {
  id: string;
  item_id: string;
  actor_id: string;
  runner_type: string;
  runner_profile: string;
  external_run_id: string | null;
  status: WorkRunStatus;
  generation: number;
  lease_generation: number;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  checkpoint: string | null;
  outcome: string | null;
  continuation_ref: string | null;
  usage_json: string;
  retry_attempt: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export function readItemControlRuns(
  store: StensiblyStore,
  itemId: string,
  now: Date,
): WorkRun[] {
  ensureRunSchema(store);
  ensureIndex(store);
  const runs: WorkRun[] = [];
  const timestamp = now.toISOString();
  for (const status of liveStatuses) {
    const rows = store.db
      .query<RunRow, [string, WorkRunStatus, string, number]>(`
        SELECT *
        FROM work_runs
        WHERE item_id = ?1 AND status = ?2
          AND (
            lease_expires_at IS NULL
            OR julianday(lease_expires_at) IS NULL
            OR julianday(lease_expires_at) > julianday(?3)
          )
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?4
      `)
      .all(itemId, status, timestamp, MAX_ITEM_CONTROL_RUNS_PER_STATUS);
    runs.push(...rows.map(mapRun));
  }
  return runs;
}

function ensureIndex(store: StensiblyStore): void {
  if (indexedStores.has(store)) return;
  store.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_runs_item_status_lease_created
    ON work_runs(item_id, status, lease_expires_at, created_at DESC)
  `);
  indexedStores.add(store);
}

function mapRun(row: RunRow): WorkRun {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    runnerType: row.runner_type,
    runnerProfile: row.runner_profile,
    externalRunId: row.external_run_id,
    status: row.status,
    generation: row.generation,
    leaseGeneration: row.lease_generation,
    leaseOwnerId: row.lease_owner_id,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    checkpoint: row.checkpoint,
    outcome: row.outcome,
    continuationRef: row.continuation_ref,
    usage: usageJson(row.usage_json),
    retryAttempt: row.retry_attempt,
    maxAttempts: row.max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function usageJson(value: string): RunUsage {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const output: RunUsage = {};
    for (const key of ["inputTokens", "outputTokens", "toolCalls", "childAgents"] as const) {
      const entry = (parsed as Record<string, unknown>)[key];
      if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0) {
        output[key] = entry;
      }
    }
    return output;
  } catch {
    return {};
  }
}
