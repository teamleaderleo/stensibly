import {
  ensureRunSchema,
  transitionWorkRun,
  type TransitionWorkRunInput,
  type WorkRun,
  type WorkRunStatus,
} from "./runs.js";
import { ConflictError, NotFoundError, StensiblyStore } from "./store.js";

interface SourceRunRow {
  id: string;
  item_id: string;
  actor_id: string;
  status: WorkRunStatus;
  generation: number;
  lease_owner_id: string | null;
}

const leasedStatuses = new Set<WorkRunStatus>([
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function transitionWorkRunWithItemProjection(
  store: StensiblyStore,
  input: TransitionWorkRunInput,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  const timestamp = validDate(now).toISOString();
  const transaction = store.db.transaction(() => {
    const source = sourceRun(store, input.id);
    const replay = source.generation !== input.expectedGeneration;
    const run = transitionWorkRun(store, input, now);
    if (replay) return run;

    projectRunToItem(store, source, run, input, timestamp);
    return run;
  });
  return transaction();
}

function projectRunToItem(
  store: StensiblyStore,
  source: SourceRunRow,
  run: WorkRun,
  input: TransitionWorkRunInput,
  timestamp: string,
): void {
  const previousOwner = source.lease_owner_id ?? source.actor_id;
  if (leasedStatuses.has(run.status)) {
    if (!run.leaseOwnerId || !run.leaseExpiresAt) {
      throw new ConflictError(`Run ${run.id} entered ${run.status} without a live lease`);
    }
    requireItemUpdate(store.db
      .query(`
        UPDATE items
        SET status = 'active',
            claimed_by = ?1,
            claim_expires_at = ?2,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active', 'blocked')
          AND (
            claimed_by IS NULL
            OR claimed_by = ?1
            OR claimed_by = ?5
            OR (claim_expires_at IS NOT NULL AND claim_expires_at <= ?3)
          )
      `)
      .run(
        run.leaseOwnerId,
        run.leaseExpiresAt,
        timestamp,
        run.itemId,
        previousOwner,
      ).changes, run, "activate");
    return;
  }

  if (run.status === "succeeded") {
    requireItemUpdate(store.db
      .query(`
        UPDATE items
        SET status = 'done',
            summary = COALESCE(?1, summary),
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = ?2
        WHERE id = ?3
          AND status IN ('ready', 'active', 'blocked')
          AND (
            claimed_by IS NULL
            OR claimed_by = ?4
            OR (claim_expires_at IS NOT NULL AND claim_expires_at <= ?2)
          )
      `)
      .run(run.outcome, timestamp, run.itemId, previousOwner).changes, run, "complete");
    return;
  }

  if (run.status === "blocked") {
    const reason = run.outcome ?? run.checkpoint ?? `Run ${run.id} is blocked.`;
    requireItemUpdate(store.db
      .query(`
        UPDATE items
        SET status = 'blocked',
            summary = ?1,
            next_action = COALESCE(?2, next_action),
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active')
          AND (
            claimed_by IS NULL
            OR claimed_by = ?5
            OR (claim_expires_at IS NOT NULL AND claim_expires_at <= ?3)
          )
      `)
      .run(reason, run.checkpoint, timestamp, run.itemId, previousOwner).changes, run, "block");
    return;
  }

  if (run.status === "failed") {
    const reason = run.outcome ?? `Run ${run.id} failed.`;
    const nextAction = run.nextRetryAt
      ? `Retry is eligible after ${run.nextRetryAt}.`
      : "Review the failed run and decide how to continue.";
    requireItemUpdate(store.db
      .query(`
        UPDATE items
        SET status = 'blocked',
            summary = ?1,
            next_action = ?2,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active', 'blocked')
          AND (
            claimed_by IS NULL
            OR claimed_by = ?5
            OR (claim_expires_at IS NOT NULL AND claim_expires_at <= ?3)
          )
      `)
      .run(reason, nextAction, timestamp, run.itemId, previousOwner).changes, run, "record failure for");
    return;
  }

  if (run.status === "cancelled") {
    requireItemUpdate(store.db
      .query(`
        UPDATE items
        SET status = 'ready',
            summary = COALESCE(?1, summary),
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = ?2
        WHERE id = ?3
          AND status IN ('ready', 'active', 'blocked')
          AND (
            claimed_by IS NULL
            OR claimed_by = ?4
            OR (claim_expires_at IS NOT NULL AND claim_expires_at <= ?2)
          )
      `)
      .run(run.outcome, timestamp, run.itemId, previousOwner).changes, run, "cancel");
  }
}

function sourceRun(store: StensiblyStore, id: string): SourceRunRow {
  const row = store.db
    .query<SourceRunRow, [string]>(`
      SELECT id, item_id, actor_id, status, generation, lease_owner_id
      FROM work_runs
      WHERE id = ?1
    `)
    .get(id);
  if (!row) throw new NotFoundError(`Run not found: ${id}`);
  return row;
}

function requireItemUpdate(changes: number, run: WorkRun, action: string): void {
  if (changes !== 1) {
    throw new ConflictError(
      `Run ${run.id} could not ${action} item ${run.itemId} because item ownership or status changed`,
    );
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Current time must be a valid date");
  }
  return value;
}
