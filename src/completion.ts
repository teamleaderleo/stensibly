import { randomUUID } from "node:crypto";
import { expireClaims } from "./leases.js";
import type { CompleteWorkInput } from "./ledger.js";
import { ConflictError, type Item, StensiblyStore } from "./store.js";

interface ReplayRow {
  item_id: string;
  type: string;
}

export function completeWork(store: StensiblyStore, input: CompleteWorkInput): Item {
  const replay = findReplay(store, input);
  if (replay) return replay;

  const expectedGeneration = claimGeneration(input.expectedClaimGeneration);
  expireClaims(store);
  const nextGeneration = expectedGeneration + 1;
  const transaction = store.db.transaction(() => {
    store.getItem(input.id);
    const now = new Date().toISOString();
    upsertActor(store, input.actor, now);

    const result = store.db
      .query(`
        UPDATE items
        SET status = 'done',
            summary = COALESCE(?1, summary),
            next_action = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            claim_generation = claim_generation + 1,
            version = version + 1,
            updated_at = ?2
        WHERE id = ?3
          AND status NOT IN ('done', 'archived')
          AND claim_generation = ?4
          AND (claimed_by IS NULL OR claimed_by = ?5)
      `)
      .run(
        input.summary ?? null,
        now,
        input.id,
        expectedGeneration,
        input.actor.id,
      );

    if (result.changes !== 1) {
      throw new ConflictError(
        "Item is complete, archived, held by another actor, or the claim generation changed",
      );
    }

    store.db
      .query(`
        INSERT INTO events (
          id, item_id, actor_id, type, payload_json, idempotency_key, created_at
        ) VALUES (?1, ?2, ?3, 'item.completed', ?4, ?5, ?6)
      `)
      .run(
        `evt_${randomUUID()}`,
        input.id,
        input.actor.id,
        JSON.stringify({
          ...(input.summary ? { summary: input.summary } : {}),
          generation: expectedGeneration,
          nextGeneration,
        }),
        input.idempotencyKey ?? null,
        now,
      );

    return store.getItem(input.id);
  });

  return transaction();
}

function findReplay(store: StensiblyStore, input: CompleteWorkInput): Item | null {
  if (!input.idempotencyKey) return null;
  const existing = store.db
    .query<ReplayRow, [string]>(`
      SELECT item_id, type
      FROM events
      WHERE idempotency_key = ?1
    `)
    .get(input.idempotencyKey);
  if (!existing) return null;
  if (existing.item_id !== input.id || existing.type !== "item.completed") {
    throw new ConflictError("Idempotency key already belongs to another operation");
  }
  return store.getItem(existing.item_id);
}

function claimGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Expected claim generation must be a non-negative integer");
  }
  return value;
}

function upsertActor(
  store: StensiblyStore,
  actor: CompleteWorkInput["actor"],
  now: string,
): void {
  store.db
    .query(`
      INSERT INTO actors (id, name, kind, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        updated_at = excluded.updated_at
    `)
    .run(actor.id, actor.name, actor.kind, now);
}
