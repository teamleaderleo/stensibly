import { randomUUID } from "node:crypto";
import {
  ensureRunSchema,
  type WorkRun,
  type WorkRunStatus,
} from "./runs.js";
import { StensiblyStore } from "./store.js";

interface StaleRunRow {
  id: string;
  item_id: string;
  actor_id: string;
  status: WorkRunStatus;
  generation: number;
  lease_generation: number;
  lease_expires_at: string;
}

const leasedStatuses = new Set<WorkRunStatus>([
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function reconcileStaleRunItems(
  store: StensiblyStore,
  now = new Date(),
): string[] {
  ensureRunSchema(store);
  const timestamp = validDate(now).toISOString();
  const transaction = store.db.transaction(() => {
    const rows = store.db
      .query<StaleRunRow, [string]>(`
        SELECT id, item_id, actor_id, status, generation, lease_generation, lease_expires_at
        FROM work_runs
        WHERE status IN ('queued', 'starting', 'running', 'waiting')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?1
        ORDER BY lease_expires_at ASC, id ASC
      `)
      .all(timestamp);
    const abandoned: string[] = [];

    for (const current of rows) {
      const nextGeneration = current.generation + 1;
      const queued = current.status === "queued";
      const outcome = queued
        ? "Run lease expired before a runner claimed it."
        : "Run lease expired without a heartbeat.";
      const result = store.db
        .query(`
          UPDATE work_runs
          SET status = 'abandoned',
              generation = ?1,
              lease_owner_id = NULL,
              lease_expires_at = NULL,
              outcome = ?2,
              next_retry_at = NULL,
              updated_at = ?3,
              ended_at = ?3
          WHERE id = ?4
            AND generation = ?5
            AND status = ?6
            AND lease_expires_at = ?7
            AND lease_expires_at <= ?3
        `)
        .run(
          nextGeneration,
          outcome,
          timestamp,
          current.id,
          current.generation,
          current.status,
          current.lease_expires_at,
        );
      if (result.changes !== 1) continue;

      const itemClaimReleased = releaseItemClaim(
        store,
        current.item_id,
        current.actor_id,
        timestamp,
      );
      appendEvent(store, {
        itemId: current.item_id,
        type: "run.abandoned",
        payload: {
          runId: current.id,
          fromStatus: current.status,
          generation: nextGeneration,
          leaseGeneration: current.lease_generation,
          reason: queued ? "queue_lease_expired" : "lease_expired",
          itemClaimReleased,
        },
        now: timestamp,
      });
      touchItem(store, current.item_id, timestamp);
      abandoned.push(current.id);
    }

    return abandoned;
  });
  return transaction();
}

export function syncItemLeaseFromRun(
  store: StensiblyStore,
  run: WorkRun,
  now = new Date(),
  releaseActorId = run.actorId,
): void {
  const timestamp = validDate(now).toISOString();
  const transaction = store.db.transaction(() => {
    if (leasedStatuses.has(run.status) && run.leaseOwnerId && run.leaseExpiresAt) {
      const item = store.getItem(run.itemId);
      if (item.status === "ready" && item.claimedBy === null) {
        store.db
          .query(`
            UPDATE items
            SET status = 'active',
                claimed_by = ?1,
                claim_expires_at = ?2,
                version = version + 1,
                updated_at = ?3
            WHERE id = ?4 AND status = 'ready' AND claimed_by IS NULL
          `)
          .run(run.leaseOwnerId, run.leaseExpiresAt, timestamp, run.itemId);
        return;
      }
      if (item.status === "active" && item.claimedBy === run.leaseOwnerId) {
        store.db
          .query(`
            UPDATE items
            SET claim_expires_at = ?1,
                version = version + 1,
                updated_at = ?2
            WHERE id = ?3
              AND status = 'active'
              AND claimed_by = ?4
              AND (claim_expires_at IS NULL OR claim_expires_at <> ?1)
          `)
          .run(run.leaseExpiresAt, timestamp, run.itemId, run.leaseOwnerId);
      }
      return;
    }

    if (releaseItemClaim(store, run.itemId, releaseActorId, timestamp)) {
      touchItem(store, run.itemId, timestamp);
    }
  });
  transaction();
}

function releaseItemClaim(
  store: StensiblyStore,
  itemId: string,
  actorId: string,
  timestamp: string,
): boolean {
  const result = store.db
    .query(`
      UPDATE items
      SET status = 'ready',
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = ?1
      WHERE id = ?2 AND status = 'active' AND claimed_by = ?3
    `)
    .run(timestamp, itemId, actorId);
  return result.changes === 1;
}

function appendEvent(
  store: StensiblyStore,
  input: {
    itemId: string;
    type: string;
    payload: Record<string, unknown>;
    now: string;
  },
): void {
  store.db
    .query(`
      INSERT INTO events (id, item_id, actor_id, type, payload_json, idempotency_key, created_at)
      VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5)
    `)
    .run(
      `evt_${randomUUID()}`,
      input.itemId,
      input.type,
      JSON.stringify(input.payload),
      input.now,
    );
}

function touchItem(store: StensiblyStore, itemId: string, timestamp: string): void {
  store.db
    .query(`
      UPDATE items
      SET version = version + 1,
          updated_at = ?1
      WHERE id = ?2
    `)
    .run(timestamp, itemId);
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Current time must be a valid date");
  }
  return value;
}
