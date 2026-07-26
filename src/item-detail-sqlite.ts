import {
  ensureArtifactSchema,
  type Artifact,
  type ArtifactKind,
} from "./artifacts.js";
import {
  ensureRunSchema,
  type RunUsage,
  type WorkRun,
  type WorkRunStatus,
} from "./runs.js";
import type { ItemEvent } from "./store.js";
import { StensiblyStore } from "./store.js";

export const MAX_ITEM_DETAIL_EVENTS = 100;
export const MAX_ITEM_DETAIL_ARTIFACTS = 100;
export const MAX_ITEM_DETAIL_RUNS = 20;

interface EventRow {
  id: string;
  item_id: string;
  actor_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  item_id: string;
  actor_id: string;
  kind: ArtifactKind;
  label: string;
  uri: string;
  mime_type: string | null;
  metadata_json: string;
  created_at: string;
}

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

export function readBoundedItemEvents(
  store: StensiblyStore,
  itemId: string,
  limit = MAX_ITEM_DETAIL_EVENTS,
): ItemEvent[] {
  store.getItem(itemId);
  const normalizedLimit = detailLimit(limit, MAX_ITEM_DETAIL_EVENTS, "Item event limit");
  return store.db
    .query<EventRow, [string, number]>(`
      SELECT id, item_id, actor_id, type, payload_json, created_at
      FROM events
      WHERE item_id = ?1
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?2
    `)
    .all(itemId, normalizedLimit)
    .reverse()
    .map(mapEvent);
}

export function readLatestItemEvent(
  store: StensiblyStore,
  itemId: string,
  type: string,
): ItemEvent | null {
  store.getItem(itemId);
  const row = store.db
    .query<EventRow, [string, string]>(`
      SELECT id, item_id, actor_id, type, payload_json, created_at
      FROM events
      WHERE item_id = ?1 AND type = ?2
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
    .get(itemId, type);
  return row ? mapEvent(row) : null;
}

export function readBoundedItemArtifacts(
  store: StensiblyStore,
  itemId: string,
  limit = MAX_ITEM_DETAIL_ARTIFACTS,
): Artifact[] {
  ensureArtifactSchema(store);
  store.getItem(itemId);
  const normalizedLimit = detailLimit(limit, MAX_ITEM_DETAIL_ARTIFACTS, "Item artifact limit");
  return store.db
    .query<ArtifactRow, [string, number]>(`
      SELECT *
      FROM artifacts
      WHERE item_id = ?1
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?2
    `)
    .all(itemId, normalizedLimit)
    .reverse()
    .map(mapArtifact);
}

export function readBoundedItemRuns(
  store: StensiblyStore,
  itemId: string,
  limit = MAX_ITEM_DETAIL_RUNS,
): WorkRun[] {
  ensureRunSchema(store);
  store.getItem(itemId);
  const normalizedLimit = detailLimit(limit, MAX_ITEM_DETAIL_RUNS, "Item run limit");
  return store.db
    .query<RunRow, [string, number]>(`
      SELECT *
      FROM work_runs
      WHERE item_id = ?1
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?2
    `)
    .all(itemId, normalizedLimit)
    .map(mapRun);
}

function detailLimit(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
  }
  return value;
}

function mapEvent(row: EventRow): ItemEvent {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    type: row.type,
    payload: recordJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    kind: row.kind,
    label: row.label,
    uri: row.uri,
    mimeType: row.mime_type,
    metadata: recordJson(row.metadata_json),
    createdAt: row.created_at,
  };
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

function recordJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function usageJson(value: string): RunUsage {
  const parsed = recordJson(value);
  const output: RunUsage = {};
  for (const key of ["inputTokens", "outputTokens", "toolCalls", "childAgents"] as const) {
    const entry = parsed[key];
    if (Number.isInteger(entry) && Number(entry) >= 0) output[key] = Number(entry);
  }
  return output;
}
