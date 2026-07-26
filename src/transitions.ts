import { randomUUID } from "node:crypto";
import { expireClaims } from "./leases.js";
import type { ActorInput } from "./schemas.js";
import { ConflictError, type Item, StensiblyStore } from "./store.js";

interface IdempotentEventRow {
  item_id: string;
  actor_id: string | null;
  type: string;
  payload_json: string;
}

export function handoffWork(
  store: StensiblyStore,
  input: {
    id: string;
    actor: ActorInput;
    expectedClaimGeneration: number;
    summary: string;
    nextAction: string;
    toActorId?: string;
    idempotencyKey?: string;
  },
): Item {
  const payload = handoffPayload(input);
  const existing = findIdempotentItem(
    store,
    input.id,
    input.actor.id,
    input.idempotencyKey,
    "work.handed_off",
    payload,
  );
  if (existing) return existing;
  const expectedGeneration = claimGeneration(input.expectedClaimGeneration);
  expireClaims(store);

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
            claim_generation = claim_generation + 1,
            version = version + 1,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active', 'blocked')
          AND claim_generation = ?5
          AND (claimed_by IS NULL OR claimed_by = ?6)
      `)
      .run(
        input.summary,
        input.nextAction,
        now,
        input.id,
        expectedGeneration,
        input.actor.id,
      );

    if (result.changes !== 1) {
      throw new ConflictError(
        "Work is complete, archived, held by another actor, or the claim generation changed",
      );
    }

    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.handed_off",
      payload,
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
    expectedClaimGeneration: number;
    reason: string;
    nextAction?: string;
    idempotencyKey?: string;
  },
): Item {
  const payload = blockPayload(input);
  const existing = findIdempotentItem(
    store,
    input.id,
    input.actor.id,
    input.idempotencyKey,
    "work.blocked",
    payload,
  );
  if (existing) return existing;
  const expectedGeneration = claimGeneration(input.expectedClaimGeneration);
  expireClaims(store);

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
            claim_generation = claim_generation + 1,
            version = version + 1,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active')
          AND claim_generation = ?5
          AND (claimed_by IS NULL OR claimed_by = ?6)
      `)
      .run(
        input.reason,
        input.nextAction ?? null,
        now,
        input.id,
        expectedGeneration,
        input.actor.id,
      );

    if (result.changes !== 1) {
      throw new ConflictError(
        "Work is already blocked, complete, archived, held by another actor, or the claim generation changed",
      );
    }

    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.blocked",
      payload,
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
    expectedClaimGeneration: number;
    nextAction?: string;
    idempotencyKey?: string;
  },
): Item {
  const payload = unblockPayload(input);
  const existing = findIdempotentItem(
    store,
    input.id,
    input.actor.id,
    input.idempotencyKey,
    "work.unblocked",
    payload,
  );
  if (existing) return existing;
  const expectedGeneration = claimGeneration(input.expectedClaimGeneration);
  expireClaims(store);

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
            claim_generation = claim_generation + 1,
            version = version + 1,
            updated_at = ?2
        WHERE id = ?3
          AND status = 'blocked'
          AND claim_generation = ?4
      `)
      .run(input.nextAction ?? null, now, input.id, expectedGeneration);

    if (result.changes !== 1) {
      throw new ConflictError(
        "Only blocked work at the current claim generation can be unblocked",
      );
    }

    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.unblocked",
      payload,
      idempotencyKey: input.idempotencyKey,
      now,
    });

    return store.getItem(input.id);
  });

  return transaction();
}

function findIdempotentItem(
  store: StensiblyStore,
  itemId: string,
  actorId: string,
  idempotencyKey: string | undefined,
  expectedType: string,
  expectedPayload: Record<string, unknown>,
): Item | null {
  if (!idempotencyKey) return null;
  const existing = store.db
    .query<IdempotentEventRow, [string]>(
      "SELECT item_id, actor_id, type, payload_json FROM events WHERE idempotency_key = ?1",
    )
    .get(idempotencyKey);
  if (!existing) return null;
  const exact = existing.item_id === itemId
    && existing.actor_id === actorId
    && existing.type === expectedType
    && stableJson(JSON.parse(existing.payload_json)) === stableJson(expectedPayload);
  if (!exact) {
    throw new ConflictError("Idempotency key was already used for a different transition request");
  }
  return store.getItem(existing.item_id);
}

function handoffPayload(input: {
  summary: string;
  nextAction: string;
  toActorId?: string;
  expectedClaimGeneration: number;
}): Record<string, unknown> {
  return {
    summary: input.summary,
    nextAction: input.nextAction,
    ...(input.toActorId ? { toActorId: input.toActorId } : {}),
    generation: input.expectedClaimGeneration,
    nextGeneration: input.expectedClaimGeneration + 1,
  };
}

function blockPayload(input: {
  reason: string;
  nextAction?: string;
  expectedClaimGeneration: number;
}): Record<string, unknown> {
  return {
    reason: input.reason,
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    generation: input.expectedClaimGeneration,
    nextGeneration: input.expectedClaimGeneration + 1,
  };
}

function unblockPayload(input: {
  nextAction?: string;
  expectedClaimGeneration: number;
}): Record<string, unknown> {
  return {
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    generation: input.expectedClaimGeneration,
    nextGeneration: input.expectedClaimGeneration + 1,
  };
}

function claimGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Expected claim generation must be a non-negative integer");
  }
  return value;
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
