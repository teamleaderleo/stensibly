import type { StensiblyStore } from "./store.js";
import {
  ApplicationLaneBindingConflictError,
  ApplicationLaneBindingNotFoundError,
  ApplicationLaneBindingStorageError,
  admitBindApplicationLaneCommand,
  admitRetireApplicationLaneBindingCommand,
  canonicalApplicationWorkBindingInputJson,
  compileProjectApplicationLaneBindingSnapshotV1,
  exactApplicationLaneBindingId,
  exactApplicationLaneBindingIdempotencyKey,
  exactApplicationLaneBindingItemId,
  exactApplicationLaneBindingProject,
  exactApplicationLaneBindingProjectReadLimit,
  parseApplicationWorkBindingInputJson,
  retireApplicationWorkBinding,
  type ApplicationLaneBindingStore,
  type BindApplicationLaneInput,
  type ProjectApplicationLaneBindingSnapshotV1,
  type RetireApplicationLaneBindingInput,
} from "./application-lane-binding-store.js";
import type { ApplicationWorkBindingV1 } from "./application-lane-binding.js";

interface ApplicationLaneBindingRow {
  sequence: number;
  id: string;
  project_id: string;
  item_id: string;
  generation: number;
  lane_ref: string;
  lane_generation: number;
  status: "active" | "retired";
  binding_json: string;
  binding_fingerprint: string;
  is_current: number;
  idempotency_key: string;
  request_json: string;
  recorded_at: string;
}

export class SqliteApplicationLaneBindingStore
  implements ApplicationLaneBindingStore {
  constructor(readonly store: StensiblyStore) {
    ensureApplicationLaneBindingSchema(store);
  }

  async bindApplicationLane(
    input: BindApplicationLaneInput,
  ): Promise<ApplicationWorkBindingV1> {
    return putSqliteApplicationLaneBinding(this.store, input);
  }

  async getApplicationLaneBinding(
    project: string,
    bindingId: string,
  ): Promise<ApplicationWorkBindingV1 | null> {
    return getSqliteApplicationLaneBinding(this.store, project, bindingId);
  }

  async listCurrentApplicationLaneBindings(
    project: string,
    itemId: string,
  ): Promise<readonly ApplicationWorkBindingV1[]> {
    return listSqliteCurrentApplicationLaneBindings(this.store, project, itemId);
  }

  async listProjectCurrentApplicationLaneBindings(
    project: string,
    limit?: number,
  ): Promise<ProjectApplicationLaneBindingSnapshotV1> {
    return listSqliteProjectCurrentApplicationLaneBindings(this.store, project, limit);
  }

  async listApplicationLaneBindingHistory(
    project: string,
    bindingId: string,
  ): Promise<readonly ApplicationWorkBindingV1[]> {
    return listSqliteApplicationLaneBindingHistory(this.store, project, bindingId);
  }

  async retireApplicationLaneBinding(
    input: RetireApplicationLaneBindingInput,
  ): Promise<ApplicationWorkBindingV1> {
    return retireSqliteApplicationLaneBinding(this.store, input);
  }
}

export function ensureApplicationLaneBindingSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS application_lane_bindings (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      lane_ref TEXT NOT NULL,
      lane_generation INTEGER NOT NULL CHECK (lane_generation >= 1),
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      binding_json TEXT NOT NULL,
      binding_fingerprint TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE(project_id, id, generation)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_application_lane_bindings_one_current
      ON application_lane_bindings(project_id, id)
      WHERE is_current = 1;

    CREATE INDEX IF NOT EXISTS idx_application_lane_bindings_current_item
      ON application_lane_bindings(project_id, item_id, status, is_current, sequence DESC);

    CREATE INDEX IF NOT EXISTS idx_application_lane_bindings_current_project
      ON application_lane_bindings(project_id, status, is_current, item_id, id, sequence ASC);

    CREATE INDEX IF NOT EXISTS idx_application_lane_bindings_history
      ON application_lane_bindings(project_id, id, generation ASC);
  `);
}

export function putSqliteApplicationLaneBinding(
  store: StensiblyStore,
  input: BindApplicationLaneInput,
): ApplicationWorkBindingV1 {
  ensureApplicationLaneBindingSchema(store);
  const command = admitBindApplicationLaneCommand(input);

  return store.db.transaction(() => {
    const replay = getSqliteBindingByIdempotencyKey(store, command.idempotencyKey);
    if (replay) {
      if (replay.request_json !== command.requestJson) {
        throw new ApplicationLaneBindingConflictError(
          "Application lane binding idempotency key already belongs to another request",
        );
      }
      return mapBinding(replay);
    }

    const item = store.getItem(command.binding.itemId);
    if (item.project !== command.binding.project) {
      throw new ApplicationLaneBindingConflictError(
        `Item ${item.id} belongs to project ${item.project}, not ${command.binding.project}`,
      );
    }

    const existing = getSqliteLatestBindingRow(
      store,
      command.binding.project,
      command.binding.id,
    );
    if (existing) {
      throw new ApplicationLaneBindingConflictError(
        `Application lane binding ${command.binding.id} already exists`,
      );
    }

    insertBindingRow(store, command.binding, {
      idempotencyKey: command.idempotencyKey,
      requestJson: command.requestJson,
      recordedAt: command.binding.createdAt,
      isCurrent: 1,
    });

    const stored = getSqliteLatestBindingRow(
      store,
      command.binding.project,
      command.binding.id,
    );
    if (!stored) throw new ApplicationLaneBindingStorageError();
    return mapBinding(stored);
  })();
}

export function getSqliteApplicationLaneBinding(
  store: StensiblyStore,
  project: string,
  bindingId: string,
): ApplicationWorkBindingV1 | null {
  ensureApplicationLaneBindingSchema(store);
  const exactProject = exactApplicationLaneBindingProject(project);
  const exactId = exactApplicationLaneBindingId(bindingId);
  const row = store.db
    .query<ApplicationLaneBindingRow, [string, string]>(`
      SELECT *
      FROM application_lane_bindings
      WHERE project_id = ?1 AND id = ?2 AND is_current = 1
      LIMIT 1
    `)
    .get(exactProject, exactId);
  return row ? mapBinding(row) : null;
}

export function listSqliteCurrentApplicationLaneBindings(
  store: StensiblyStore,
  project: string,
  itemId: string,
): readonly ApplicationWorkBindingV1[] {
  ensureApplicationLaneBindingSchema(store);
  const exactProject = exactApplicationLaneBindingProject(project);
  const exactItem = exactApplicationLaneBindingItemId(itemId);
  return Object.freeze(store.db
    .query<ApplicationLaneBindingRow, [string, string]>(`
      SELECT *
      FROM application_lane_bindings
      WHERE project_id = ?1
        AND item_id = ?2
        AND status = 'active'
        AND is_current = 1
      ORDER BY sequence ASC
    `)
    .all(exactProject, exactItem)
    .map(mapBinding));
}

export function listSqliteProjectCurrentApplicationLaneBindings(
  store: StensiblyStore,
  project: string,
  limit?: number,
): ProjectApplicationLaneBindingSnapshotV1 {
  ensureApplicationLaneBindingSchema(store);
  const exactProject = exactApplicationLaneBindingProject(project);
  const exactLimit = exactApplicationLaneBindingProjectReadLimit(limit);
  const rows = store.db
    .query<ApplicationLaneBindingRow, [string, number]>(`
      SELECT *
      FROM application_lane_bindings
      WHERE project_id = ?1
        AND status = 'active'
        AND is_current = 1
      ORDER BY item_id ASC, id ASC, generation ASC, sequence ASC
      LIMIT ?2
    `)
    .all(exactProject, exactLimit + 1);
  return compileProjectApplicationLaneBindingSnapshotV1(
    exactProject,
    rows.map(mapBinding),
    exactLimit,
  );
}

export function listSqliteApplicationLaneBindingHistory(
  store: StensiblyStore,
  project: string,
  bindingId: string,
): readonly ApplicationWorkBindingV1[] {
  ensureApplicationLaneBindingSchema(store);
  const exactProject = exactApplicationLaneBindingProject(project);
  const exactId = exactApplicationLaneBindingId(bindingId);
  return Object.freeze(store.db
    .query<ApplicationLaneBindingRow, [string, string]>(`
      SELECT *
      FROM application_lane_bindings
      WHERE project_id = ?1 AND id = ?2
      ORDER BY generation ASC, sequence ASC
    `)
    .all(exactProject, exactId)
    .map(mapBinding));
}

export function retireSqliteApplicationLaneBinding(
  store: StensiblyStore,
  input: RetireApplicationLaneBindingInput,
): ApplicationWorkBindingV1 {
  ensureApplicationLaneBindingSchema(store);
  const command = admitRetireApplicationLaneBindingCommand(input);

  return store.db.transaction(() => {
    const replay = getSqliteBindingByIdempotencyKey(store, command.idempotencyKey);
    if (replay) {
      if (replay.request_json !== command.requestJson) {
        throw new ApplicationLaneBindingConflictError(
          "Application lane binding idempotency key already belongs to another request",
        );
      }
      return mapBinding(replay);
    }

    const currentRow = getSqliteCurrentBindingRow(
      store,
      command.project,
      command.bindingId,
    );
    if (!currentRow) {
      throw new ApplicationLaneBindingNotFoundError(
        `Application lane binding ${command.bindingId} does not exist`,
      );
    }
    const current = mapBinding(currentRow);
    const retired = retireApplicationWorkBinding(current, command);

    const updated = store.db.query(`
      UPDATE application_lane_bindings
      SET is_current = 0
      WHERE sequence = ?1 AND is_current = 1
    `).run(currentRow.sequence);
    if (updated.changes !== 1) {
      throw new ApplicationLaneBindingConflictError(
        `Application lane binding ${command.bindingId} changed during retirement`,
      );
    }

    insertBindingRow(store, retired, {
      idempotencyKey: command.idempotencyKey,
      requestJson: command.requestJson,
      recordedAt: command.retiredAt,
      isCurrent: 1,
    });

    const stored = getSqliteCurrentBindingRow(
      store,
      command.project,
      command.bindingId,
    );
    if (!stored) throw new ApplicationLaneBindingStorageError();
    return mapBinding(stored);
  })();
}

function insertBindingRow(
  store: StensiblyStore,
  binding: ApplicationWorkBindingV1,
  command: {
    idempotencyKey: string;
    requestJson: string;
    recordedAt: string;
    isCurrent: 0 | 1;
  },
): void {
  const bindingJson = canonicalApplicationWorkBindingInputJson(binding);
  store.db.query(`
    INSERT INTO application_lane_bindings (
      id,
      project_id,
      item_id,
      generation,
      lane_ref,
      lane_generation,
      status,
      binding_json,
      binding_fingerprint,
      is_current,
      idempotency_key,
      request_json,
      recorded_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
  `).run(
    binding.id,
    binding.project,
    binding.itemId,
    binding.generation,
    binding.laneRef,
    binding.laneGeneration,
    binding.retiredAt === null ? "active" : "retired",
    bindingJson,
    binding.fingerprint,
    command.isCurrent,
    exactApplicationLaneBindingIdempotencyKey(command.idempotencyKey),
    command.requestJson,
    command.recordedAt,
  );
}

function getSqliteCurrentBindingRow(
  store: StensiblyStore,
  project: string,
  bindingId: string,
): ApplicationLaneBindingRow | null {
  return store.db
    .query<ApplicationLaneBindingRow, [string, string]>(`
      SELECT *
      FROM application_lane_bindings
      WHERE project_id = ?1 AND id = ?2 AND is_current = 1
      LIMIT 1
    `)
    .get(project, bindingId);
}

function getSqliteLatestBindingRow(
  store: StensiblyStore,
  project: string,
  bindingId: string,
): ApplicationLaneBindingRow | null {
  return store.db
    .query<ApplicationLaneBindingRow, [string, string]>(`
      SELECT *
      FROM application_lane_bindings
      WHERE project_id = ?1 AND id = ?2
      ORDER BY generation DESC, sequence DESC
      LIMIT 1
    `)
    .get(project, bindingId);
}

function getSqliteBindingByIdempotencyKey(
  store: StensiblyStore,
  idempotencyKey: string,
): ApplicationLaneBindingRow | null {
  return store.db
    .query<ApplicationLaneBindingRow, [string]>(`
      SELECT *
      FROM application_lane_bindings
      WHERE idempotency_key = ?1
      LIMIT 1
    `)
    .get(idempotencyKey);
}

function mapBinding(row: ApplicationLaneBindingRow): ApplicationWorkBindingV1 {
  let binding: ApplicationWorkBindingV1;
  try {
    binding = parseApplicationWorkBindingInputJson(row.binding_json);
  } catch {
    throw new ApplicationLaneBindingStorageError();
  }
  const expectedRecordedAt = binding.retiredAt ?? binding.createdAt;
  const valid = row.id === binding.id
    && row.project_id === binding.project
    && row.item_id === binding.itemId
    && row.generation === binding.generation
    && row.lane_ref === binding.laneRef
    && row.lane_generation === binding.laneGeneration
    && row.status === (binding.retiredAt === null ? "active" : "retired")
    && row.binding_fingerprint === binding.fingerprint
    && (row.is_current === 0 || row.is_current === 1)
    && typeof row.request_json === "string"
    && row.request_json.length > 0
    && row.recorded_at === expectedRecordedAt;
  if (!valid) throw new ApplicationLaneBindingStorageError();
  return binding;
}
