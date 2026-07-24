import type {
  CompleteWithContinuationsInput,
  CompleteWithContinuationsResult,
} from "./completion-continuation-contracts.js";
import { completeWithContinuationsSchema } from "./completion-continuation-contracts.js";
import { proposeContinuation } from "./continuations.js";
import { ConflictError, type StensiblyStore } from "./store.js";

interface ReplayRow {
  item_id: string;
  request_json: string;
  result_json: string;
}

const initializedStores = new WeakSet<StensiblyStore>();

export function completeWorkWithContinuations(
  store: StensiblyStore,
  rawInput: CompleteWithContinuationsInput,
): CompleteWithContinuationsResult {
  ensureCompletionContinuationSchema(store);
  const id = requiredText(rawInput.id, "Item ID", 240);
  const parsed = completeWithContinuationsSchema.parse({
    actor: rawInput.actor,
    summary: rawInput.summary,
    continuations: rawInput.continuations,
  });
  const idempotencyKey = optionalText(
    rawInput.idempotencyKey,
    "Idempotency key",
    240,
  );
  const request = {
    id,
    actor: parsed.actor,
    summary: parsed.summary ?? null,
    continuations: parsed.continuations ?? [],
  };
  const requestJson = stableJson(request);

  const transaction = store.db.transaction(() => {
    if (idempotencyKey) {
      const replay = store.db
        .query<ReplayRow, [string]>(`
          SELECT item_id, request_json, result_json
          FROM completion_continuation_commands
          WHERE idempotency_key = ?1
        `)
        .get(idempotencyKey);
      if (replay) {
        if (replay.item_id !== id || replay.request_json !== requestJson) {
          throw new ConflictError(
            "Idempotency key was already used for a different completion request",
          );
        }
        return JSON.parse(replay.result_json) as CompleteWithContinuationsResult;
      }

      const existingEvent = store.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM events WHERE idempotency_key = ?1",
        )
        .get(idempotencyKey);
      if (existingEvent) {
        throw new ConflictError(
          "Idempotency key already belongs to another operation",
        );
      }
    }

    const item = store.completeItem(
      id,
      parsed.actor,
      parsed.summary,
      idempotencyKey,
    );
    const continuations = (parsed.continuations ?? []).map((draft) =>
      proposeContinuation(store, {
        sourceItemId: id,
        actor: parsed.actor,
        ...draft,
      })
    );
    const result = { item, continuations };

    if (idempotencyKey) {
      store.db
        .query(`
          INSERT INTO completion_continuation_commands (
            idempotency_key, item_id, request_json, result_json, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5)
        `)
        .run(
          idempotencyKey,
          id,
          requestJson,
          JSON.stringify(result),
          new Date().toISOString(),
        );
    }
    return result;
  });

  return transaction();
}

export function ensureCompletionContinuationSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS completion_continuation_commands (
      idempotency_key TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  initializedStores.add(store);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new TypeError(`${label} may contain at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label, maxLength);
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}
