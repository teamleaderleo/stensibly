import { randomUUID } from "node:crypto";
import { ensurePromiseSchema, type PromiseWakeup } from "./promises.js";
import { ConflictError, StensiblyStore } from "./store.js";

export const MAX_PROMISE_WAKEUPS_PER_DISPATCH = 32;

export type PromiseWakeupDispatchSource =
  | "local"
  | "legacy_unavailable"
  | "hosted_unavailable";

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

export interface PromiseWakeupDispatchReplay {
  dispatchCommandId: string;
  runId: string;
  consumedPromiseWakeupIds: string[];
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

interface ReplayRow {
  dispatch_command_id: string;
  run_id: string;
  wakeup_ids_json: string;
}

interface TableSqlRow {
  sql: string | null;
}

const initializedStores = new WeakSet<StensiblyStore>();

export function ensurePromiseWakeupConsumptionSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  ensurePromiseSchema(store);
  migrateWakeupStateContract(store);
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

    CREATE TABLE IF NOT EXISTS promise_wakeup_dispatch_results (
      idempotency_key TEXT PRIMARY KEY,
      dispatch_command_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES work_runs(id) ON DELETE CASCADE,
      wakeup_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
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
 * overflow sentinel. Wakeups remain durable after consumption; the state is a
 * projection backed by the append-only marker table.
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
       AND p.item_id = w.item_id
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
 * function must run inside the same SQLite transaction that creates the run and
 * stores dispatch replay evidence.
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
         AND p.item_id = w.item_id
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
    const state = store.db
      .query(`
        UPDATE promise_wakeups
        SET state = 'consumed'
        WHERE id = ?1 AND state = 'ready'
      `)
      .run(wakeup.id);
    if (state.changes !== 1) {
      throw new ConflictError(
        `Promise wakeup ${wakeup.id} changed before its consumed state committed`,
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

export function recordPromiseWakeupDispatchReplay(
  store: StensiblyStore,
  input: {
    idempotencyKey?: string;
    dispatchCommandId: string;
    runId: string;
    consumedPromiseWakeupIds: string[];
    createdAt: string;
  },
): void {
  ensurePromiseWakeupConsumptionSchema(store);
  if (!input.idempotencyKey) return;
  store.db
    .query(`
      INSERT INTO promise_wakeup_dispatch_results (
        idempotency_key, dispatch_command_id, run_id, wakeup_ids_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)
    `)
    .run(
      input.idempotencyKey,
      input.dispatchCommandId,
      input.runId,
      JSON.stringify(input.consumedPromiseWakeupIds),
      input.createdAt,
    );
}

export function readPromiseWakeupDispatchReplay(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
): PromiseWakeupDispatchReplay | null {
  ensurePromiseWakeupConsumptionSchema(store);
  if (!idempotencyKey) return null;
  const row = store.db
    .query<ReplayRow, [string]>(`
      SELECT dispatch_command_id, run_id, wakeup_ids_json
      FROM promise_wakeup_dispatch_results
      WHERE idempotency_key = ?1
    `)
    .get(idempotencyKey);
  if (!row) return null;
  const parsed = JSON.parse(row.wakeup_ids_json) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new ConflictError("Stored promise wakeup dispatch replay is malformed");
  }
  return {
    dispatchCommandId: row.dispatch_command_id,
    runId: row.run_id,
    consumedPromiseWakeupIds: parsed,
  };
}

export function appendPromiseWakeupConsumptionEvent(
  store: StensiblyStore,
  input: {
    itemId: string;
    actorId: string;
    dispatchCommandId: string;
    runId: string;
    consumedPromiseWakeupIds: string[];
    createdAt: string;
  },
): void {
  if (input.consumedPromiseWakeupIds.length === 0) return;
  store.db
    .query(`
      INSERT INTO events (id, item_id, actor_id, type, payload_json, idempotency_key, created_at)
      VALUES (?1, ?2, ?3, 'promise.wakeups_consumed', ?4, NULL, ?5)
    `)
    .run(
      `event_${randomUUID()}`,
      input.itemId,
      input.actorId,
      JSON.stringify({
        dispatchCommandId: input.dispatchCommandId,
        runId: input.runId,
        wakeupIds: input.consumedPromiseWakeupIds,
        count: input.consumedPromiseWakeupIds.length,
      }),
      input.createdAt,
    );
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
      SELECT c.*
      FROM promise_wakeup_consumptions c
      JOIN promise_wakeups w ON w.id = c.wakeup_id
      WHERE (?1 IS NULL OR c.item_id = ?1)
        AND (?2 IS NULL OR c.dispatch_command_id = ?2)
      ORDER BY c.consumed_at ASC, w.created_at ASC, w.id ASC
    `)
    .all(itemId, dispatchCommandId)
    .map(mapConsumption);
}

function migrateWakeupStateContract(store: StensiblyStore): void {
  const table = store.db
    .query<TableSqlRow, []>(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'promise_wakeups'
    `)
    .get();
  if (!table?.sql || !/CHECK\s*\(state\s*=\s*'ready'\)/i.test(table.sql)) return;

  store.db.exec(`
    DROP INDEX IF EXISTS idx_promise_wakeups_state_created;
    ALTER TABLE promise_wakeups RENAME TO promise_wakeups_ready_legacy;
    CREATE TABLE promise_wakeups (
      id TEXT PRIMARY KEY,
      promise_id TEXT NOT NULL REFERENCES work_promises(id) ON DELETE CASCADE,
      promise_generation INTEGER NOT NULL,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('ready', 'consumed')),
      created_at TEXT NOT NULL,
      UNIQUE (promise_id, promise_generation)
    );
    INSERT INTO promise_wakeups (
      id, promise_id, promise_generation, item_id, state, created_at
    )
    SELECT id, promise_id, promise_generation, item_id, state, created_at
    FROM promise_wakeups_ready_legacy;
    DROP TABLE promise_wakeups_ready_legacy;
    CREATE INDEX idx_promise_wakeups_state_created
      ON promise_wakeups(state, created_at ASC);
  `);
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
