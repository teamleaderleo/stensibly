import { randomUUID } from "node:crypto";
import { expireClaims } from "./leases.ts";
import type { ActorInput } from "./schemas.ts";
import { ConflictError, type Item, StensiblyStore } from "./store.ts";

interface IdempotentEventRow {
  item_id: string;
}

export function handoffWork(
  store: StensiblyStore,
  input: {
    id: string;
    actor: ActorInput;
    summary: string;
    nextAction: string;
    toActorId?: string;
    idempotencyKey?: string;
  },
): Item {
  expireClaims(store);
  const existing = findIdempotentItem(store, input.idempotencyKey);
  if (existing) return existing;

  const transaction = store.db.transaction(() => {
    store.getItem(input.id);
    const now = new Date().toISOString();
    upsertActor(store, input.actor, now);

    const result = store.db
      .query(`
        UPDATE items
        SET status = 'ready',
            summary = ?1,
            next_action = ?2,
            claimed_by = NULL,
            claim_expires_at = NULL,
            version = version + 1,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active', 'blocked')
          AND (claimed_by IS NULL OR claimed_by = ?5)
      `)
      .run(input.summary, input.nextAction, now, input.id, input.actor.id);

    if (result.changes !== 1) {
      throw new ConflictError("Work is complete, archived, or held by another actor");
    }

    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.handed_off",
      payload: {
        summary: input.summary,
        nextAction: input.nextAction,
        ...(input.toActorId ? { toActorId: input.toActorId } : {}),
      },
      idempotencyKey: input.idempotencyKey,
      now,
    });

    return store.getItem(input.id);
  });

  return transaction();
}

export function blockWork(
  store: StensiblyStore,
  input: {
    id: string;
    actor: ActorInput;
    reason: string;
    nextAction?: string;
    idempotencyKey?: string;
  },
): Item {
  expireClaims(store);
  const existing = findIdempotentItem(store, input.idempotencyKey);
  if (existing) return existing;

  const transaction = store.db.transaction(() => {
    store.getItem(input.id);
    const now = new Date().toISOString();
    upsertActor(store, input.actor, now);

    const result = store.db
      .query(`
        UPDATE items
        SET status = 'blocked',
            summary = ?1,
            next_action = COALESCE(?2, next_action),
            claimed_by = NULL,
            claim_expires_at = NULL,
            version = version + 1,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active')
          AND (claimed_by IS NULL OR claimed_by = ?5)
      `)
      .run(input.reason, input.nextAction ?? null, now, input.id, input.actor.id);

    if (result.changes !== 1) {
      throw new ConflictError("Work is already blocked, complete, archived, or held by another actor");
    }

    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.blocked",
      payload: {
        reason: input.reason,
        ...(input.nextAction ? { nextAction: input.nextAction } : {}),
      },
      idempotencyKey: input.idempotencyKey,
      now,
    });

    return store.getItem(input.id);
  });

  return transaction();
}

export function unblockWork(
  store: StensiblyStore,
  input: {
    id: string;
    actor: ActorInput;
    nextAction?: string;
    idempotencyKey?: string;
  },
): Item {
  expireClaims(store);
  const existing = findIdempotentItem(store, input.idempotencyKey);
  if (existing) return existing;

  const transaction = store.db.transaction(() => {
    store.getItem(input.id);
    const now = new Date().toISOString();
    upsertActor(store, input.actor, now);

    const result = store.db
      .query(`
        UPDATE items
        SET status = 'ready',
            next_action = COALESCE(?1, next_action),
            claimed_by = NULL,
            claim_expires_at = NULL,
            version = version + 1,
            updated_at = ?2
        WHERE id = ?3 AND status = 'blocked'
      `)
      .run(input.nextAction ?? null, now, input.id);

    if (result.changes !== 1) {
      throw new ConflictError("Only blocked work can be unblocked");
    }

    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.unblocked",
      payload: input.nextAction ? { nextAction: input.nextAction } : {},
      idempotencyKey: input.idempotencyKey,
      now,
    });

    return store.getItem(input.id);
  });

  return transaction();
}

function findIdempotentItem(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
): Item | null {
  if (!idempotencyKey) return null;
  const existing = store.db
    .query<IdempotentEventRow, [string]>(
      "SELECT item_id FROM events WHERE idempotency_key = ?1",
    )
    .get(idempotencyKey);
  return existing ? store.getItem(existing.item_id) : null;
}

function upsertActor(store: StensiblyStore, actor: ActorInput, now: string): void {
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

function appendTransitionEvent(
  store: StensiblyStore,
  input: {
    itemId: string;
    actorId: string;
    type: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    now: string;
  },
): void {
  store.db
    .query(`
      INSERT INTO events (
        id, item_id, actor_id, type, payload_json, idempotency_key, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `)
    .run(
      `evt_${randomUUID()}`,
      input.itemId,
      input.actorId,
      input.type,
      JSON.stringify(input.payload),
      input.idempotencyKey ?? null,
      input.now,
    );
}
