import type { StensiblyStore } from "./store.js";
import {
  recordedOperationReceipt,
  type OperationReceipt,
  type OperationReceiptInput,
  unknownOperationReceipt,
} from "./operation-receipt-contracts.js";

interface ReceiptRow {
  event_id: string;
  item_id: string;
  actor_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}

export function getSqliteOperationReceipt(
  store: StensiblyStore,
  input: OperationReceiptInput,
): OperationReceipt {
  const row = store.db.query<ReceiptRow, [string, string]>(`
    SELECT
      events.id AS event_id,
      events.item_id,
      events.actor_id,
      events.type,
      events.payload_json,
      events.created_at
    FROM events
    INNER JOIN items ON items.id = events.item_id
    WHERE events.idempotency_key = ?1
      AND items.project_id = ?2
    LIMIT 1
  `).get(input.idempotencyKey, input.project);

  if (!row) return unknownOperationReceipt(input);
  return recordedOperationReceipt(input, {
    eventId: row.event_id,
    itemId: row.item_id,
    actorId: row.actor_id,
    operation: row.type,
    payload: parsePayload(row.payload_json),
    recordedAt: row.created_at,
  });
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
