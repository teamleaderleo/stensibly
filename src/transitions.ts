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

interface TransitionInput {
  id: string;
  actor: ActorInput;
  expectedClaimGeneration: number;
  idempotencyKey?: string;
}

interface ExpectedTransitionReplay {
  itemId: string;
  actorId: string;
  type: string;
  request: Record<string, unknown>;
}

export function handoffWork(
  store: StensiblyStore,
  input: TransitionInput & {
    summary: string;
    nextAction: string;
    toActorId?: string;
  },
): Item {
  const expectedGeneration = itemGeneration(input.expectedClaimGeneration);
  const request = {
    expectedClaimGeneration: expectedGeneration,
    summary: input.summary,
    nextAction: input.nextAction,
    toActorId: input.toActorId ?? null,
  };
  const existing = findIdempotentItem(store, input.idempotencyKey, {
    itemId: input.id,
    actorId: input.actor.id,
    type: "work.handed_off",
    request,
  });
  if (existing) return existing;

  expireClaims(store);
  const transaction = store.db.transaction(() => {
    const current = store.getItem(input.id);
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

    const updated = store.getItem(input.id);
    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.handed_off",
      payload: {
        summary: input.summary,
        nextAction: input.nextAction,
        ...(input.toActorId ? { toActorId: input.toActorId } : {}),
        generation: current.claimGeneration,
        nextGeneration: updated.claimGeneration,
        request,
      },
      idempotencyKey: input.idempotencyKey,
      now,
    });

    return updated;
  });

  return transaction();
}

export function blockWork(
  store: StensiblyStore,
  input: TransitionInput & {
    reason: string;
    nextAction?: string;
  },
): Item {
  const expectedGeneration = itemGeneration(input.expectedClaimGeneration);
  const request = {
    expectedClaimGeneration: expectedGeneration,
    reason: input.reason,
    nextAction: input.nextAction ?? null,
  };
  const existing = findIdempotentItem(store, input.idempotencyKey, {
    itemId: input.id,
    actorId: input.actor.id,
    type: "work.blocked",
    request,
  });
  if (existing) return existing;

  expireClaims(store);
  const transaction = store.db.transaction(() => {
    const current = store.getItem(input.id);
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
        "Work is blocked, complete, archived, held by another actor, or the claim generation changed",
      );
    }

    const updated = store.getItem(input.id);
    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.blocked",
      payload: {
        reason: input.reason,
        ...(input.nextAction ? { nextAction: input.nextAction } : {}),
        generation: current.claimGeneration,
        nextGeneration: updated.claimGeneration,
        request,
      },
      idempotencyKey: input.idempotencyKey,
      now,
    });

    return updated;
  });

  return transaction();
}

export function unblockWork(
  store: StensiblyStore,
  input: TransitionInput & { nextAction?: string },
): Item {
  const expectedGeneration = itemGeneration(input.expectedClaimGeneration);
  const request = {
    expectedClaimGeneration: expectedGeneration,
    nextAction: input.nextAction ?? null,
  };
  const existing = findIdempotentItem(store, input.idempotencyKey, {
    itemId: input.id,
    actorId: input.actor.id,
    type: "work.unblocked",
    request,
  });
  if (existing) return existing;

  expireClaims(store);
  const transaction = store.db.transaction(() => {
    const current = store.getItem(input.id);
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
        "Only blocked work with the current claim generation can be unblocked",
      );
    }

    const updated = store.getItem(input.id);
    appendTransitionEvent(store, {
      itemId: input.id,
      actorId: input.actor.id,
      type: "work.unblocked",
      payload: {
        ...(input.nextAction ? { nextAction: input.nextAction } : {}),
        generation: current.claimGeneration,
        nextGeneration: updated.claimGeneration,
        request,
      },
      idempotencyKey: input.idempotencyKey,
      now,
    });

    return updated;
  });

  return transaction();
}

function findIdempotentItem(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  expected: ExpectedTransitionReplay,
): Item | null {
  if (!idempotencyKey) return null;
  const existing = store.db
    .query<IdempotentEventRow, [string]>(`
      SELECT item_id, actor_id, type, payload_json
      FROM events
      WHERE idempotency_key = ?1
    `)
    .get(idempotencyKey);
  if (!existing) return null;

  const payload = parsePayload(existing.payload_json);
  const existingRequest = isRecord(payload.request)
    ? payload.request
    : legacyTransitionRequest(existing.type, payload);
  if (
    existing.item_id !== expected.itemId
    || existing.actor_id !== expected.actorId
    || existing.type !== expected.type
    || stableJson(existingRequest) !== stableJson(expected.request)
  ) {
    throw new ConflictError(
      "Idempotency key was already used for a different item operation",
    );
  }
  return store.getItem(existing.item_id);
}

function legacyTransitionRequest(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "work.handed_off") {
    return {
      expectedClaimGeneration: payload.generation,
      summary: payload.summary,
      nextAction: payload.nextAction,
      toActorId: typeof payload.toActorId === "string" ? payload.toActorId : null,
    };
  }
  if (type === "work.blocked") {
    return {
      expectedClaimGeneration: payload.generation,
      reason: payload.reason,
      nextAction: typeof payload.nextAction === "string" ? payload.nextAction : null,
    };
  }
  if (type === "work.unblocked") {
    return {
      expectedClaimGeneration: payload.generation,
      nextAction: typeof payload.nextAction === "string" ? payload.nextAction : null,
    };
  }
  return {};
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
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

function itemGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Expected claim generation must be a non-negative integer");
  }
  return value;
}
