import type { StensiblyStore } from "./store.js";
import {
  admitProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservation,
} from "./project-repository-setup-observation.js";
import {
  prepareProjectRepositorySetupObservationReplacement,
  type ProjectRepositorySetupObservationLedger,
  type RecordProjectRepositorySetupObservationInput,
} from "./project-repository-setup-ledger.js";

interface ProjectRepositorySetupObservationRow {
  sequence: number;
  id: string;
  project_id: string;
  repository_full_name: string;
  default_branch: string;
  source_kind: string;
  observed_at: string;
  fingerprint: string;
  recorded_at: string;
  is_current: number;
}

export class SqliteProjectRepositorySetupObservationLedger
  implements ProjectRepositorySetupObservationLedger {
  readonly #store: StensiblyStore;

  constructor(store: StensiblyStore) {
    this.#store = store;
    ensureProjectRepositorySetupObservationSchema(store);
  }

  async getCurrentProjectRepositorySetupObservation(
    project: string,
  ): Promise<ProjectRepositorySetupObservation | null> {
    return getSqliteProjectRepositorySetupObservation(this.#store, project);
  }

  async recordProjectRepositorySetupObservation(
    input: RecordProjectRepositorySetupObservationInput,
  ) {
    return recordSqliteProjectRepositorySetupObservation(this.#store, input);
  }
}

export function ensureProjectRepositorySetupObservationSchema(
  store: StensiblyStore,
): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS project_repository_setup_observations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repository_full_name TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (
        source_kind IN ('operator_supplied', 'github_conversation_context')
      ),
      observed_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      recorded_at TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK (is_current IN (0, 1))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repository_setup_single_current
      ON project_repository_setup_observations(project_id)
      WHERE is_current = 1;

    CREATE INDEX IF NOT EXISTS idx_project_repository_setup_history
      ON project_repository_setup_observations(project_id, sequence DESC);
  `);
}

export function getSqliteProjectRepositorySetupObservation(
  store: StensiblyStore,
  project: string,
): ProjectRepositorySetupObservation | null {
  const projectId = exactProject(project);
  const row = store.db
    .query<ProjectRepositorySetupObservationRow, [string]>(`
      SELECT *
      FROM project_repository_setup_observations
      WHERE project_id = ?1 AND is_current = 1
      ORDER BY sequence DESC
      LIMIT 1
    `)
    .get(projectId);
  return row ? mapRow(row) : null;
}

export function listSqliteProjectRepositorySetupObservationHistory(
  store: StensiblyStore,
  project: string,
  limit = 20,
): ProjectRepositorySetupObservation[] {
  const projectId = exactProject(project);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Repository setup observation history limit is invalid");
  }
  return store.db
    .query<ProjectRepositorySetupObservationRow, [string, number]>(`
      SELECT *
      FROM project_repository_setup_observations
      WHERE project_id = ?1
      ORDER BY sequence DESC
      LIMIT ?2
    `)
    .all(projectId, limit)
    .map(mapRow);
}

export function recordSqliteProjectRepositorySetupObservation(
  store: StensiblyStore,
  input: RecordProjectRepositorySetupObservationInput,
) {
  ensureProjectRepositorySetupObservationSchema(store);
  const transaction = store.db.transaction(() => {
    const current = getSqliteProjectRepositorySetupObservation(store, input.project);
    const prepared = prepareProjectRepositorySetupObservationReplacement(current, input);
    if (prepared.replay) {
      return {
        observation: prepared.replay,
        replayed: true,
        replacedFingerprint: prepared.replacedFingerprint,
      };
    }

    const observation = prepared.observation;
    const recordedAt = new Date().toISOString();
    store.db.query(`
      INSERT INTO projects (id, name, created_at)
      VALUES (?1, ?1, ?2)
      ON CONFLICT(id) DO NOTHING
    `).run(observation.project, recordedAt);

    if (current) {
      const changed = store.db.query(`
        UPDATE project_repository_setup_observations
        SET is_current = 0
        WHERE project_id = ?1 AND is_current = 1 AND fingerprint = ?2
      `).run(observation.project, current.fingerprint);
      if (changed.changes !== 1) {
        throw new Error("Repository setup observation changed during replacement");
      }
    }

    store.db.query(`
      INSERT INTO project_repository_setup_observations (
        id,
        project_id,
        repository_full_name,
        default_branch,
        source_kind,
        observed_at,
        fingerprint,
        recorded_at,
        is_current
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
    `).run(
      observation.id,
      observation.project,
      observation.repositoryFullName,
      observation.defaultBranch,
      observation.sourceKind,
      observation.observedAt,
      observation.fingerprint,
      recordedAt,
    );

    const stored = getSqliteProjectRepositorySetupObservation(
      store,
      observation.project,
    );
    if (!stored || stored.fingerprint !== observation.fingerprint) {
      throw new Error("Recorded repository setup observation disappeared");
    }
    return {
      observation: stored,
      replayed: false,
      replacedFingerprint: prepared.replacedFingerprint,
    };
  });
  return transaction();
}

function mapRow(
  row: ProjectRepositorySetupObservationRow,
): ProjectRepositorySetupObservation {
  if (row.is_current !== 0 && row.is_current !== 1) {
    throw new Error("Stored repository setup observation current state is invalid");
  }
  return admitProjectRepositorySetupObservation({
    version: 1,
    id: row.id,
    project: row.project_id,
    repositoryFullName: row.repository_full_name,
    defaultBranch: row.default_branch,
    sourceKind: row.source_kind,
    observedAt: row.observed_at,
    fingerprint: row.fingerprint,
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

function exactProject(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError("Project must be an exact lowercase slug up to 80 characters");
  }
  return value;
}
