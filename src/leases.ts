import { randomUUID } from "node:crypto";
import type { ActorInput } from "./schemas.js";
import { ConflictError, type Item, StensiblyStore } from "./store.js";

interface ExpiredClaimRow {
  id: string;
  project: string;
  claimed_by: string;
  claim_expires_at: string;
}

interface IdempotentEventRow {
  item_id: string;
}

export interface ClaimExpiryAudit {
  source: string;
  policyVersion?: string;
  mode?: string;
}

export function expireClaims(
  store: StensiblyStore,
  now = new Date(),
  options: { project?: string; audit?: ClaimExpiryAudit } = {},
): string[] {
  const nowIso = now.toISOString();
  const candidates = options.project
    ? store.db
        .query<ExpiredClaimRow, [string, string]>(`
          SELECT id, project, claimed_by, claim_expires_at
          FROM items
          WHERE status = 'active'
            AND claimed_by IS NOT NULL
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?1
            AND project = ?2
          ORDER BY claim_expires_at ASC, id ASC
        `)
        .all(nowIso, options.project)
    : store.db
        .query<ExpiredClaimRow, [string]>(`
          SELECT id, project, claimed_by, claim_expires_at
          FROM items
          WHERE status = 'active'
            AND claimed_by IS NOT NULL
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?1
          ORDER BY claim_expires_at ASC, id ASC
        `)
        .all(nowIso);
  return expireClaimRows(store, candidates, now, options.audit);
}

export function expireClaimIds(
  store: StensiblyStore,
  ids: string[],
  now = new Date(),
  audit?: ClaimExpiryAudit,
): string[] {
  const uniqueIds = [...new Set(ids)];
  const candidates: ExpiredClaimRow[] = [];
  for (const id of uniqueIds) {
    const claim = store.db
      .query<ExpiredClaimRow, [string, string]>(`
        SELECT id, project, claimed_by, claim_expires_at
        FROM items
        WHERE id = ?1
          AND status = 'active'
          AND claimed_by IS NOT NULL
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at <= ?2
      `)
      .get(id, now.toISOString());
    if (claim) candidates.push(claim);
  }
  candidates.sort((left, right) =>
    left.claim_expires_at.localeCompare(right.claim_expires_at)
    || left.id.localeCompare(right.id),
  );
  return expireClaimRows(store, candidates, now, audit);
}

function expireClaimRows(
  store: StensiblyStore,
  candidates: ExpiredClaimRow[],
  now: Date,
  audit?: ClaimExpiryAudit,
): string[] {
  const nowIso = now.toISOString();
  const transaction = store.db.transaction(() => {
    const expiredIds: string[] = [];
    for (const claim of candidates) {
      const result = store.db
        .query(`
          UPDATE items
          SET status = 'ready',
              claimed_by = NULL,
              claim_expires_at = NULL,
              version = version + 1,
              updated_at = ?1
          WHERE id = ?2
            AND status = 'active'
            AND claimed_by = ?3
            AND claim_expires_at = ?4
            AND claim_expires_at <= ?1
        `)
        .run(nowIso, claim.id, claim.claimed_by, claim.claim_expires_at);

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
            ...(audit ? { automation: audit } : {}),
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

  const now = new Date();
  expireClaims(store, now);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

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
            version = version + 1,
            updated_at = ?2
        WHERE id = ?3
          AND status = 'active'
          AND claimed_by = ?4
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at > ?2
      `)
      .run(expiresAt, nowIso, id, actor.id);

    if (result.changes !== 1) {
      throw new ConflictError("Only the current claimant can renew a live claim");
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
        JSON.stringify({ leaseSeconds, expiresAt }),
        idempotencyKey ?? null,
        nowIso,
      );

    return store.getItem(id);
  });

  return transaction();
}
