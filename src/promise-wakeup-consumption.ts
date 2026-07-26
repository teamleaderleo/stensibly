import { ConflictError, StensiblyStore } from "./store.js";

export const MAX_PROMISE_WAKEUPS_PER_DISPATCH = 32;

export interface PromiseWakeupConsumption {
  wakeupId: string;
  promiseId: string;
  promiseGeneration: number;
  itemId: string;
  project: string;
  dispatchCommandId: string;
  runId: string;
  consumedAt: string;
}

interface WakeupRow {
  id: string;
  promise_id: string;
  promise_generation: number;
  item_id: string;
  project_id: string;
  created_at: string;
}

interface ConsumptionRow {
  wakeup_id: string;
  promise_id: string;
  promise_generation: number;
  item_id: string;
  project_id: string;
  dispatch_command_id: string;
  run_id: string;
  consumed_at: string;
}

interface SchemaRow {
  type: "table" | "view";
  sql: string | null;
}

const initializedStores = new WeakSet<StensiblyStore>();

/**
 * Installs append-only wakeup-consumption evidence. The marker is the durable
 * exactly-once record; the wakeup row's `consumed` state is a compatibility
 * projection so existing ready-only readers remain correct across restart.
 */
export function ensurePromiseWakeupConsumptionSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;

  const wakeupSchema = store.db
    .query<SchemaRow, []>(
      "SELECT type, sql FROM sqlite_master WHERE name = 'promise_wakeups' LIMIT 1",
    )
    .get();
  if (!wakeupSchema || wakeupSchema.type !== "table") {
    throw new Error("Promise wakeup storage is unavailable for consumption migration");
  }

  if (!wakeupSchema.sql?.includes("'consumed'")) {
    const migrate = store.db.transaction(() => {
      store.db.exec(`
        DROP INDEX IF EXISTS idx_promise_wakeups_state_created;
        ALTER TABLE promise_wakeups RENAME TO promise_wakeups_before_consumption;

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
        FROM promise_wakeups_before_consumption;

        DROP TABLE promise_wakeups_before_consumption;

        CREATE INDEX idx_promise_wakeups_state_created
          ON promise_wakeups(state, created_at ASC);
      `);
    });
    migrate();
  }

  store.db.exec(`
    CREATE TABLE IF NOT EXISTS promise_wakeup_consumptions (
      wakeup_id TEXT PRIMARY KEY REFERENCES promise_wakeups(id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS idx_promise_wakeup_consumptions_run
      ON promise_wakeup_consumptions(run_id, consumed_at, wakeup_id);
  `);

  initializedStores.add(store);
}

export function consumePromiseWakeupsForDispatch(
  store: StensiblyStore,
  input: {
    itemId: string;
    project: string;
    dispatchCommandId: string;
    runId: string;
    consumedAt: string;
  },
): PromiseWakeupConsumption[] {
  ensurePromiseWakeupConsumptionSchema(store);
  const wakeups = selectEligibleWakeups(store, input.itemId, input.project);
  if (wakeups.length > MAX_PROMISE_WAKEUPS_PER_DISPATCH) {
    throw new ConflictError(
      `Dispatch candidate has more than ${MAX_PROMISE_WAKEUPS_PER_DISPATCH} ready promise wakeups`,
    );
  }

  const insert = store.db.query(`
    INSERT INTO promise_wakeup_consumptions (
      wakeup_id, promise_id, promise_generation, item_id, project_id,
      dispatch_command_id, run_id, consumed_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `);
  const markConsumed = store.db.query(`
    UPDATE promise_wakeups
    SET state = 'consumed'
    WHERE id = ?1 AND state = 'ready'
  `);

  const consumed: PromiseWakeupConsumption[] = [];
  for (const wakeup of wakeups) {
    const marker = insert.run(
      wakeup.id,
      wakeup.promise_id,
      wakeup.promise_generation,
      wakeup.item_id,
      wakeup.project_id,
      input.dispatchCommandId,
      input.runId,
      input.consumedAt,
    );
    const projection = markConsumed.run(wakeup.id);
    if (marker.changes !== 1 || projection.changes !== 1) {
      throw new ConflictError(`Promise wakeup ${wakeup.id} changed before dispatch committed`);
    }
    consumed.push({
      wakeupId: wakeup.id,
      promiseId: wakeup.promise_id,
      promiseGeneration: wakeup.promise_generation,
      itemId: wakeup.item_id,
      project: wakeup.project_id,
      dispatchCommandId: input.dispatchCommandId,
      runId: input.runId,
      consumedAt: input.consumedAt,
    });
  }
  return consumed;
}

export function listPromiseWakeupConsumptions(
  store: StensiblyStore,
  input: { runId?: string; dispatchCommandId?: string; limit?: number } = {},
): PromiseWakeupConsumption[] {
  ensurePromiseWakeupConsumptionSchema(store);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Promise wakeup consumption limit must be between 1 and 100");
  }
  return store.db
    .query<ConsumptionRow, [string | null, string | null, number]>(`
      SELECT *
      FROM promise_wakeup_consumptions
      WHERE (?1 IS NULL OR run_id = ?1)
        AND (?2 IS NULL OR dispatch_command_id = ?2)
      ORDER BY consumed_at ASC, wakeup_id ASC
      LIMIT ?3
    `)
    .all(input.runId ?? null, input.dispatchCommandId ?? null, limit)
    .map(mapConsumption);
}

function selectEligibleWakeups(
  store: StensiblyStore,
  itemId: string,
  project: string,
): WakeupRow[] {
  return store.db
    .query<WakeupRow, [string, string, number]>(`
      SELECT
        wakeup.id,
        wakeup.promise_id,
        wakeup.promise_generation,
        wakeup.item_id,
        item.project_id,
        wakeup.created_at
      FROM promise_wakeups wakeup
      JOIN work_promises promise
        ON promise.id = wakeup.promise_id
       AND promise.item_id = wakeup.item_id
       AND promise.generation = wakeup.promise_generation
       AND promise.status = 'satisfied'
      JOIN items item
        ON item.id = wakeup.item_id
       AND item.project_id = ?2
      LEFT JOIN promise_wakeup_consumptions consumed
        ON consumed.wakeup_id = wakeup.id
      WHERE wakeup.item_id = ?1
        AND wakeup.state = 'ready'
        AND consumed.wakeup_id IS NULL
      ORDER BY wakeup.created_at ASC, wakeup.id ASC
      LIMIT ?3
    `)
    .all(itemId, project, MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1);
}

function mapConsumption(row: ConsumptionRow): PromiseWakeupConsumption {
  return {
    wakeupId: row.wakeup_id,
    promiseId: row.promise_id,
    promiseGeneration: row.promise_generation,
    itemId: row.item_id,
    project: row.project_id,
    dispatchCommandId: row.dispatch_command_id,
    runId: row.run_id,
    consumedAt: row.consumed_at,
  };
}
