import { ConflictError, type StensiblyStore } from "./store.js";

interface IdempotencyEventRow {
  event_id: string;
  item_id: string;
  actor_id: string | null;
  type: string;
  payload_json: string;
  project_id: string;
}

export interface SqliteIdempotencyExpectation {
  project: string;
  operation: string;
  itemId?: string;
  actorId?: string | null;
  payload?: unknown;
  payloadSubset?: Record<string, unknown>;
}

export function requireMatchingSqliteIdempotency(
  store: StensiblyStore,
  key: string | undefined,
  expected: SqliteIdempotencyExpectation,
): IdempotencyEventRow | null {
  if (!key) return null;
  const row = store.db.query<IdempotencyEventRow, [string]>(`
    SELECT
      events.id AS event_id,
      events.item_id,
      events.actor_id,
      events.type,
      events.payload_json,
      items.project_id
    FROM events
    INNER JOIN items ON items.id = events.item_id
    WHERE events.idempotency_key = ?1
    LIMIT 1
  `).get(key);
  if (!row) return null;

  const payload = parsePayload(row.payload_json);
  const mismatch = row.project_id !== expected.project
    || row.type !== expected.operation
    || (expected.itemId !== undefined && row.item_id !== expected.itemId)
    || (Object.hasOwn(expected, "actorId") && row.actor_id !== expected.actorId)
    || (Object.hasOwn(expected, "payload") && stableJson(payload) !== stableJson(expected.payload))
    || (expected.payloadSubset !== undefined && !containsSubset(payload, expected.payloadSubset));
  if (mismatch) {
    throw new ConflictError("Idempotency key was already used for a different operation");
  }
  return row;
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function containsSubset(value: unknown, subset: Record<string, unknown>): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(subset).every(([key, expected]) =>
    Object.hasOwn(value, key) && stableJson(value[key]) === stableJson(expected)
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
