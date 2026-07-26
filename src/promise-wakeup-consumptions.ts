import { randomUUID } from "node:crypto";
import { ensurePromiseSchema, type PromiseWakeup } from "./promises.js";
import { ConflictError, StensiblyStore } from "./store.js";

export const MAX_PROMISE_WAKEUPS_PER_DISPATCH = 32;

export interface PromiseWakeupConsumption {
  id: string;
  wakeupId: string;
  promiseId: string;
  promiseGeneration: number;
  itemId: string;
  projectId: string;
  dispatchCommandId: string;
  runId: string;
  consumedAt: string;
}

interface ReadyWakeupRow {
  id: string;
  promise_id: string;
  promise_generation: number;
  item_id: string;
  state: "ready";
  created_at: string;
}

interface ConsumptionRow {
  id: string;
  wakeup_id: string;
  promise_id: string;
  promise_generation: number;
  item_id: string;
  project_id: string;
  dispatch_command_id: string;
  run_id: string;
  consumed_at: string;
}

const initializedStores = new WeakSet<StensiblyStore>();

export function ensurePromiseWakeupConsumptionSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  ensurePromiseSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS promise_wakeup_consumptions (
      id TEXT PRIMARY KEY,
      wakeup_id TEXT NOT NULL UNIQUE REFERENCES promise_wakeups(id) ON DELETE CASCADE,
      promise_id TEXT NOT NULL REFERENCES work_promises(id) ON DELETE CASCADE,
      promise_generation INTEGER NOT NULL CHECK (promise_generation >= 1),
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      dispatch_command_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES work_runs(id) ON DELETE CASCADE,
      consumed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_promise_wakeup_consumptions_dispatch
      ON promise_wakeup_consumptions(dispatch_command_id, consumed_at, wakeup_id);
    CREATE INDEX IF NOT EXISTS idx_promise_wakeup_consumptions_item
      ON promise_wakeup_consumptions(item_id, consumed_at, wakeup_id);
  `);
  initializedStores.add(store);
}

/**
 * Returns the deterministic exact-current unconsumed wakeup set plus one
 * overflow sentinel. Wakeups are immutable; consumption is represented only by
 * the append-only marker table.
 */
export function listDispatchablePromiseWakeups(
  store: StensiblyStore,
  itemId: string,
  projectId: string,
  limit = MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1,
): PromiseWakeup[] {
  ensurePromiseWakeupConsumptionSchema(store);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1) {
    throw new RangeError(
      `Promise wakeup limit must be between 1 and ${MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1}`,
    );
  }
  return store.db
    .query<ReadyWakeupRow, [string, string, number]>(`
      SELECT w.*
      FROM promise_wakeups w
      JOIN work_promises p
        ON p.id = w.promise_id
       AND p.generation = w.promise_generation
       AND p.status = 'satisfied'
      JOIN items i
        ON i.id = w.item_id
       AND i.project_id = ?2
      LEFT JOIN promise_wakeup_consumptions c
        ON c.wakeup_id = w.id
      WHERE w.item_id = ?1
        AND w.state = 'ready'
        AND c.wakeup_id IS NULL
      ORDER BY w.created_at ASC, w.id ASC
      LIMIT ?3
    `)
    .all(itemId, projectId, limit)
    .map(mapWakeup);
}

/**
 * Consumes the exact deterministic set selected for a committed dispatch. This
 * function must be called inside the same SQLite transaction that creates the
 * run and stores dispatch replay evidence.
 */
export function consumePromiseWakeupsForDispatch(
  store: StensiblyStore,
  input: {
    itemId: string;
    projectId: string;
    dispatchCommandId: string;
    runId: string;
    consumedAt: string;
  },
): PromiseWakeupConsumption[] {
  ensurePromiseWakeupConsumptionSchema(store);
  const selected = listDispatchablePromiseWakeups(
    store,
    input.itemId,
    input.projectId,
    MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1,
  );
  if (selected.length > MAX_PROMISE_WAKEUPS_PER_DISPATCH) {
    throw new ConflictError(
      `Dispatch has more than ${MAX_PROMISE_WAKEUPS_PER_DISPATCH} ready promise wakeups`,
    );
  }

  const consumed: PromiseWakeupConsumption[] = [];
  for (const wakeup of selected) {
    const id = `wakeup_consumption_${randomUUID()}`;
    const result = store.db
      .query(`
        INSERT INTO promise_wakeup_consumptions (
          id, wakeup_id, promise_id, promise_generation, item_id, project_id,
          dispatch_command_id, run_id, consumed_at
        )
        SELECT
          ?1, w.id, w.promise_id, w.promise_generation, w.item_id, i.project_id,
          ?2, ?3, ?4
        FROM promise_wakeups w
        JOIN work_promises p
          ON p.id = w.promise_id
         AND p.generation = w.promise_generation
         AND p.status = 'satisfied'
        JOIN items i
          ON i.id = w.item_id
         AND i.project_id = ?5
        WHERE w.id = ?6
          AND w.item_id = ?7
          AND w.state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM promise_wakeup_consumptions c WHERE c.wakeup_id = w.id
          )
      `)
      .run(
        id,
        input.dispatchCommandId,
        input.runId,
        input.consumedAt,
        input.projectId,
        wakeup.id,
        input.itemId,
      );
    if (result.changes !== 1) {
      throw new ConflictError(
        `Promise wakeup ${wakeup.id} changed before dispatch consumption committed`,
      );
    }
    const row = store.db
      .query<ConsumptionRow, [string]>(
        "SELECT * FROM promise_wakeup_consumptions WHERE id = ?1",
      )
      .get(id);
    if (!row) throw new Error(`Promise wakeup consumption ${id} disappeared`);
    consumed.push(mapConsumption(row));
  }
  return consumed;
}

export function listPromiseWakeupConsumptions(
  store: StensiblyStore,
  input: { itemId?: string; dispatchCommandId?: string } = {},
): PromiseWakeupConsumption[] {
  ensurePromiseWakeupConsumptionSchema(store);
  const itemId = input.itemId ?? null;
  const dispatchCommandId = input.dispatchCommandId ?? null;
  return store.db
    .query<ConsumptionRow, [string | null, string | null]>(`
      SELECT *
      FROM promise_wakeup_consumptions
      WHERE (?1 IS NULL OR item_id = ?1)
        AND (?2 IS NULL OR dispatch_command_id = ?2)
      ORDER BY consumed_at ASC, wakeup_id ASC
    `)
    .all(itemId, dispatchCommandId)
    .map(mapConsumption);
}

function mapWakeup(row: ReadyWakeupRow): PromiseWakeup {
  return {
    id: row.id,
    promiseId: row.promise_id,
    promiseGeneration: row.promise_generation,
    itemId: row.item_id,
    state: "ready",
    createdAt: row.created_at,
  };
}

function mapConsumption(row: ConsumptionRow): PromiseWakeupConsumption {
  return {
    id: row.id,
    wakeupId: row.wakeup_id,
    promiseId: row.promise_id,
    promiseGeneration: row.promise_generation,
    itemId: row.item_id,
    projectId: row.project_id,
    dispatchCommandId: row.dispatch_command_id,
    runId: row.run_id,
    consumedAt: row.consumed_at,
  };
}
