import {
  ensureArtifactSchema,
  type Artifact,
  type ArtifactKind,
} from "./artifacts.js";
import type { ItemEvent } from "./store.js";
import { ensureRunSchema, getWorkRun, type WorkRun } from "./runs.js";
import { StensiblyStore } from "./store.js";

export const MAX_ITEM_DETAIL_EVENTS = 500;
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

interface RunIdRow {
  id: string;
}

export interface BoundedSqliteItemDetail {
  item: ReturnType<StensiblyStore["getItem"]>;
  events: ItemEvent[];
  artifacts: Artifact[];
  runs: WorkRun[];
  dependencies: unknown[];
  reservations: unknown[];
}

export function readBoundedSqliteItemDetail(
  store: StensiblyStore,
  itemId: string,
  now: Date,
): BoundedSqliteItemDetail {
  ensureArtifactSchema(store);
  ensureRunSchema(store);
  const item = store.getItem(itemId);
  const events = store.db
    .query<EventRow, [string, number]>(`
      SELECT id, item_id, actor_id, type, payload_json, created_at
      FROM events
      WHERE item_id = ?1
      ORDER BY created_at DESC, id DESC
      LIMIT ?2
    `)
    .all(itemId, MAX_ITEM_DETAIL_EVENTS)
    .reverse()
    .map(mapEvent);
  const artifacts = store.db
    .query<ArtifactRow, [string, number]>(`
      SELECT id, item_id, actor_id, kind, label, uri, mime_type, metadata_json, created_at
      FROM artifacts
      WHERE item_id = ?1
      ORDER BY created_at DESC, id DESC
      LIMIT ?2
    `)
    .all(itemId, MAX_ITEM_DETAIL_ARTIFACTS)
    .reverse()
    .map(mapArtifact);
  const runIds = store.db
    .query<RunIdRow, [string, number]>(`
      SELECT id
      FROM work_runs
      WHERE item_id = ?1
      ORDER BY created_at DESC, id DESC
      LIMIT ?2
    `)
    .all(itemId, MAX_ITEM_DETAIL_RUNS);

  return {
    item,
    events,
    artifacts,
    runs: runIds.map(({ id }) => getWorkRun(store, id, now)),
    dependencies: [],
    reservations: [],
  };
}

function mapEvent(row: EventRow): ItemEvent {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    type: row.type,
    payload: parseRecord(row.payload_json),
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
    metadata: parseRecord(row.metadata_json),
    createdAt: row.created_at,
  };
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
