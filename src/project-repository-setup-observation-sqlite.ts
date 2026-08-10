import { randomUUID } from "node:crypto";
import {
  createProjectRepositorySetupObservationRecord,
  prepareProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservationLedger,
  type ProjectRepositorySetupObservationRecord,
  type ProjectRepositorySetupObservationResult,
  type RecordProjectRepositorySetupObservationInput,
} from "./project-repository-setup-observation.js";
import type { StensiblyStore } from "./store.js";

interface ProjectRepositorySetupObservationRow {
  sequence: number;
  id: string;
  project_id: string;
  repository_full_name: string;
  default_branch: string;
  source_kind: string;
  semantic_fingerprint: string;
  observed_at: string;
}

export class SqliteProjectRepositorySetupObservationLedger
  implements ProjectRepositorySetupObservationLedger
{
  constructor(readonly store: StensiblyStore) {
    ensureProjectRepositorySetupObservationSchema(store);
  }

  async getProjectRepositorySetupObservation(
    project: string,
  ): Promise<ProjectRepositorySetupObservationRecord | null> {
    return getSqliteProjectRepositorySetupObservation(this.store, project);
  }

  async recordProjectRepositorySetupObservation(
    input: RecordProjectRepositorySetupObservationInput,
  ): Promise<ProjectRepositorySetupObservationResult> {
    return recordSqliteProjectRepositorySetupObservation(this.store, input);
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
      source_kind TEXT NOT NULL,
      semantic_fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_repository_setup_observations_current
      ON project_repository_setup_observations(project_id, sequence DESC);

    CREATE INDEX IF NOT EXISTS idx_project_repository_setup_observations_fingerprint
      ON project_repository_setup_observations(
        project_id,
        semantic_fingerprint,
        sequence DESC
      );
  `);
}

export function getSqliteProjectRepositorySetupObservation(
  store: StensiblyStore,
  project: string,
): ProjectRepositorySetupObservationRecord | null {
  const row = store.db
    .query<ProjectRepositorySetupObservationRow, [string]>(`
      SELECT *
      FROM project_repository_setup_observations
      WHERE project_id = ?1
      ORDER BY sequence DESC
      LIMIT 1
    `)
    .get(project);
  return row ? mapObservation(row) : null;
}

export function recordSqliteProjectRepositorySetupObservation(
  store: StensiblyStore,
  input: RecordProjectRepositorySetupObservationInput,
): ProjectRepositorySetupObservationResult {
  const transaction = store.db.transaction(() => {
    const current = getSqliteProjectRepositorySetupObservation(store, input.project);
    const prepared = prepareProjectRepositorySetupObservation(current, input);
    if (prepared.replay) {
      return {
        observation: prepared.replay,
        replayed: true,
        replacedObservationId: null,
      };
    }

    const observedAt = new Date().toISOString();
    const id = `repo_setup_${randomUUID()}`;
    store.db.query(`
      INSERT INTO projects (id, name, created_at)
      VALUES (?1, ?1, ?2)
      ON CONFLICT(id) DO NOTHING
    `).run(prepared.project, observedAt);
    store.db.query(`
      INSERT INTO project_repository_setup_observations (
        id,
        project_id,
        repository_full_name,
        default_branch,
        source_kind,
        semantic_fingerprint,
        observed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(
      id,
      prepared.project,
      prepared.repositoryFullName,
      prepared.defaultBranch,
      prepared.sourceKind,
      prepared.semanticFingerprint,
      observedAt,
    );

    const observation = getSqliteProjectRepositorySetupObservation(
      store,
      prepared.project,
    );
    if (!observation || observation.id !== id) {
      throw new Error("Recorded repository setup observation disappeared");
    }
    return {
      observation,
      replayed: false,
      replacedObservationId: current?.id ?? null,
    };
  });
  return transaction();
}

function mapObservation(
  row: ProjectRepositorySetupObservationRow,
): ProjectRepositorySetupObservationRecord {
  return createProjectRepositorySetupObservationRecord({
    id: row.id,
    project: row.project_id,
    repositoryFullName: row.repository_full_name,
    defaultBranch: row.default_branch,
    sourceKind: row.source_kind as ProjectRepositorySetupObservationRecord["sourceKind"],
    semanticFingerprint: row.semantic_fingerprint,
    observedAt: row.observed_at,
  });
}
