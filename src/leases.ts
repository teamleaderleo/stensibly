import { randomUUID } from "node:crypto";
import type { ActorInput } from "./schemas.js";
import { ConflictError, type Item, StensiblyStore } from "./store.js";

interface ExpiredClaimRow {
  id: string;
  claimed_by: string;
  claim_expires_at: string;
  claim_generation: number;
}

interface IdempotentEventRow {
  item_id: string;
}

export function expireClaims(store: StensiblyStore, now = new Date()): string[] {
  const nowIso = now.toISOString();
  const transaction = store.db.transaction(() => {
    const candidates = store.db
      .query<ExpiredClaimRow, [string]>(`
        SELECT id, claimed_by, claim_expires_at, claim_generation
        FROM items
        WHERE status = 'active'
          AND claimed_by IS NOT NULL
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at <= ?1
      `)
      .all(nowIso);

    const expiredIds: string[] = [];
    for (const claim of candidates) {
      const nextGeneration = claim.claim_generation + 1;
      const result = store.db
        .query(`
          UPDATE items
          SET status = 'ready',
              claimed_by = NULL,
              claim_expires_at = NULL,
              claim_generation = ?1,
              version = version + 1,
              updated_at = ?2
          WHERE id = ?3
            AND status = 'active'
            AND claimed_by = ?4
            AND claim_expires_at = ?5
            AND claim_generation = ?6
            AND claim_expires_at <= ?2
        `)
        .run(
          nextGeneration,
          nowIso,
          claim.id,
          claim.claimed_by,
          claim.claim_expires_at,
          claim.claim_generation,
        );

      if (result.changes !== 1) continue;

      store.db
        .query(`
          INSERT INTO events (
            id, item_id, actor_id, type, payload_json, idempotency_key, created_at
          ) VALUES (?1, ?2, NULL, 'claim.expired', ?3, NULL, ?4)
        `)
        .run(
          `evt_${randomUUID()}`,
          claim.id,
          JSON.stringify({
            previousClaimant: claim.claimed_by,
            expiredAt: claim.claim_expires_at,
            generation: claim.claim_generation,
            nextGeneration,
          }),
          nowIso,
        );

      expiredIds.push(claim.id);
    }

    return expiredIds;
  });

  return transaction();
}

export function renewClaim(
  store: StensiblyStore,
  id: string,
  actor: ActorInput,
  leaseSeconds: number,
  expectedClaimGeneration: number,
  idempotencyKey?: string,
): Item {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 86_400) {
    throw new RangeError("Lease must be between 30 and 86400 seconds");
  }

  if (idempotencyKey) {
    const existing = store.db
      .query<IdempotentEventRow, [string]>(
        "SELECT item_id FROM events WHERE idempotency_key = ?1",
      )
      .get(idempotencyKey);
    if (existing) return store.getItem(existing.item_id);
  }

  const expectedGeneration = claimGeneration(expectedClaimGeneration);
  const now = new Date();
  expireClaims(store, now);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const nextGeneration = expectedGeneration + 1;

  const transaction = store.db.transaction(() => {
    store.getItem(id);

    store.db
      .query(`
        INSERT INTO actors (id, name, kind, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          updated_at = excluded.updated_at
      `)
      .run(actor.id, actor.name, actor.kind, nowIso);

    const result = store.db
      .query(`
        UPDATE items
        SET claim_expires_at = ?1,
            claim_generation = ?2,
            version = version + 1,
            updated_at = ?3
        WHERE id = ?4
          AND status = 'active'
          AND claimed_by = ?5
          AND claim_generation = ?6
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at > ?3
      `)
      .run(
        expiresAt,
        nextGeneration,
        nowIso,
        id,
        actor.id,
        expectedGeneration,
      );

    if (result.changes !== 1) {
      throw new ConflictError(
        "Only the current claimant with the current claim generation can renew a live claim",
      );
    }

    store.db
      .query(`
        INSERT INTO events (
          id, item_id, actor_id, type, payload_json, idempotency_key, created_at
        ) VALUES (?1, ?2, ?3, 'claim.renewed', ?4, ?5, ?6)
      `)
      .run(
        `evt_${randomUUID()}`,
        id,
        actor.id,
        JSON.stringify({
          leaseSeconds,
          expiresAt,
          generation: expectedGeneration,
          nextGeneration,
        }),
        idempotencyKey ?? null,
        nowIso,
      );

    return store.getItem(id);
  });

  return transaction();
}

function claimGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("Expected claim generation must be a positive integer");
  }
  return value;
}
