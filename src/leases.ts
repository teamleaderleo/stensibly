import { randomUUID } from "node:crypto";
import {
  validateOptionalProjectScope,
  validateProjectScope,
} from "./project-scope.js";
import type { ActorInput } from "./schemas.js";
import { ConflictError, type Item, StensiblyStore } from "./store.js";

interface ExpiredClaimRow {
  id: string;
  project_id: string;
  claimed_by: string;
  claim_expires_at: string;
  claim_generation: number;
  version: number;
}

interface IdempotentEventRow {
  item_id: string;
}

export interface ExpectedExpiredClaim {
  id: string;
  project: string;
  claimedBy: string;
  claimExpiresAt: string;
  claimGeneration: number;
  version: number;
}

export interface ClaimExpiryAutomationAudit {
  source: string;
  policy: string;
  policyVersion: string;
  mode: string;
}

export interface ExpireClaimsOptions {
  project?: string;
  limit?: number;
  expectedClaims?: readonly ExpectedExpiredClaim[];
  audit?: ClaimExpiryAutomationAudit;
}

export function expireClaims(
  store: StensiblyStore,
  now = new Date(),
  options: ExpireClaimsOptions = {},
): string[] {
  const project = validateOptionalProjectScope(options.project);
  const limit = validateExpiryLimit(options.limit);
  const nowIso = now.toISOString();
  const transaction = store.db.transaction(() => {
    const candidates = options.expectedClaims
      ? expectedRows(options.expectedClaims, project, limit)
      : selectExpiredRows(store, nowIso, project, limit);

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
            AND project_id = ?4
            AND status = 'active'
            AND claimed_by = ?5
            AND claim_expires_at = ?6
            AND claim_generation = ?7
            AND version = ?8
            AND claim_expires_at <= ?2
        `)
        .run(
          nextGeneration,
          nowIso,
          claim.id,
          claim.project_id,
          claim.claimed_by,
          claim.claim_expires_at,
          claim.claim_generation,
          claim.version,
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
            previousVersion: claim.version,
            nextVersion: claim.version + 1,
            ...(options.audit ? { automation: options.audit } : {}),
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

function validateExpiryLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) {
    throw new RangeError("Claim expiry limit must be a whole number between 0 and 10000");
  }
  return limit;
}

function expectedRows(
  expectedClaims: readonly ExpectedExpiredClaim[],
  project: string | undefined,
  limit: number | undefined,
): ExpiredClaimRow[] {
  if (limit === 0) return [];
  const rows: ExpiredClaimRow[] = [];
  const seen = new Set<string>();
  for (const claim of expectedClaims) {
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    const claimProject = validateProjectScope(claim.project, "Expected claim project");
    if (project !== undefined && claimProject !== project) continue;
    rows.push({
      id: claim.id,
      project_id: claimProject,
      claimed_by: claim.claimedBy,
      claim_expires_at: claim.claimExpiresAt,
      claim_generation: claim.claimGeneration,
      version: claim.version,
    });
    if (limit !== undefined && rows.length >= limit) break;
  }
  return rows;
}

function selectExpiredRows(
  store: StensiblyStore,
  nowIso: string,
  project: string | undefined,
  limit: number | undefined,
): ExpiredClaimRow[] {
  const sqlLimit = limit ?? null;
  return project !== undefined
    ? store.db
        .query<ExpiredClaimRow, [string, string, number | null]>(`
          SELECT id, project_id, claimed_by, claim_expires_at, claim_generation, version
          FROM items
          WHERE status = 'active'
            AND claimed_by IS NOT NULL
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?1
            AND project_id = ?2
          ORDER BY claim_expires_at ASC, id ASC
          LIMIT COALESCE(?3, -1)
        `)
        .all(nowIso, project, sqlLimit)
    : store.db
        .query<ExpiredClaimRow, [string, number | null]>(`
          SELECT id, project_id, claimed_by, claim_expires_at, claim_generation, version
          FROM items
          WHERE status = 'active'
            AND claimed_by IS NOT NULL
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?1
          ORDER BY claim_expires_at ASC, id ASC
          LIMIT COALESCE(?2, -1)
        `)
        .all(nowIso, sqlLimit);
}
