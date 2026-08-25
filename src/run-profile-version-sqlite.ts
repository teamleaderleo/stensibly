import { randomUUID } from "node:crypto";
import { runnerProfileProvenanceV1 } from "./runner-profile-provenance.js";
import { ConflictError, type StensiblyStore } from "./store.js";

export interface RunnerProfileVersionCreationBinding {
  runnerProfileVersion: string | null;
  replayed: boolean;
}

interface RunProfileVersionRow {
  runner_profile: string;
  runner_profile_version: string | null;
}

const initializedStores = new WeakSet<StensiblyStore>();

export function ensureRunProfileVersionSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  const columns = store.db
    .query<{ name: string }, []>("PRAGMA table_info(work_runs)")
    .all();
  if (!columns.some((column) => column.name === "runner_profile_version")) {
    store.db.exec("ALTER TABLE work_runs ADD COLUMN runner_profile_version TEXT");
  }
  initializedStores.add(store);
}

export function prepareRunnerProfileVersionCreation(
  store: StensiblyStore,
  input: {
    idempotencyKey?: string;
    runnerProfile: string;
    runnerProfileVersion?: string | null;
  },
): RunnerProfileVersionCreationBinding {
  ensureRunProfileVersionSchema(store);
  const requested = runnerProfileProvenanceV1(
    input.runnerProfile,
    input.runnerProfileVersion,
  );
  if (!input.idempotencyKey) {
    return Object.freeze({
      runnerProfileVersion: requested.profileVersion,
      replayed: false,
    });
  }

  const existing = store.db
    .query<RunProfileVersionRow, [string]>(`
      SELECT runner_profile, runner_profile_version
      FROM work_runs
      WHERE idempotency_key = ?1
      LIMIT 1
    `)
    .get(input.idempotencyKey);
  if (!existing) {
    return Object.freeze({
      runnerProfileVersion: requested.profileVersion,
      replayed: false,
    });
  }

  const durable = runnerProfileProvenanceV1(
    existing.runner_profile,
    existing.runner_profile_version,
  );
  if (
    durable.profileId !== requested.profileId
    || durable.profileVersion !== requested.profileVersion
  ) {
    throw new ConflictError(
      "Idempotency key was already used for different runner profile provenance",
    );
  }
  return Object.freeze({
    runnerProfileVersion: requested.profileVersion,
    replayed: true,
  });
}

export function bindRunnerProfileVersion(
  store: StensiblyStore,
  input: {
    runId: string;
    runnerProfile: string;
    binding: RunnerProfileVersionCreationBinding;
  },
): void {
  ensureRunProfileVersionSchema(store);
  const row = runProfileVersionRow(store, input.runId);
  const durable = runnerProfileProvenanceV1(
    row.runner_profile,
    row.runner_profile_version,
  );
  const requested = runnerProfileProvenanceV1(
    input.runnerProfile,
    input.binding.runnerProfileVersion,
  );
  if (durable.profileId !== requested.profileId) {
    throw new ConflictError("Runner profile changed while the run was being created");
  }
  if (input.binding.replayed) {
    if (durable.profileVersion !== requested.profileVersion) {
      throw new ConflictError("Runner profile version changed during idempotent replay");
    }
    return;
  }
  if (durable.profileVersion !== null) {
    throw new ConflictError("Runner profile version is immutable after run creation");
  }
  if (requested.profileVersion === null) return;

  const result = store.db
    .query(`
      UPDATE work_runs
      SET runner_profile_version = ?1
      WHERE id = ?2 AND runner_profile = ?3 AND runner_profile_version IS NULL
    `)
    .run(requested.profileVersion, input.runId, requested.profileId);
  if (result.changes !== 1) {
    throw new ConflictError("Runner profile version changed while the run was being created");
  }
}

export function withRunnerProfileVersion<Run extends { id: string; runnerProfile: string }>(
  store: StensiblyStore,
  run: Run,
): Run & { runnerProfileVersion: string | null } {
  ensureRunProfileVersionSchema(store);
  const row = runProfileVersionRow(store, run.id);
  const durable = runnerProfileProvenanceV1(
    row.runner_profile,
    row.runner_profile_version,
  );
  if (durable.profileId !== run.runnerProfile) {
    throw new ConflictError("Durable runner profile disagrees with the run projection");
  }
  return {
    ...run,
    runnerProfileVersion: durable.profileVersion,
  };
}

export function appendRunnerProfileVersionEvent(
  store: StensiblyStore,
  input: {
    runId: string;
    itemId: string;
    actorId: string;
    generation: number;
    runnerProfile: string;
    runnerProfileVersion: string | null;
    createdAt: string;
  },
): void {
  const provenance = runnerProfileProvenanceV1(
    input.runnerProfile,
    input.runnerProfileVersion,
  );
  store.db
    .query(`
      INSERT OR IGNORE INTO events (
        id, item_id, actor_id, type, payload_json, idempotency_key, created_at
      ) VALUES (?1, ?2, ?3, 'run.profile_provenance', ?4, ?5, ?6)
    `)
    .run(
      `evt_${randomUUID()}`,
      input.itemId,
      input.actorId,
      JSON.stringify({
        runId: input.runId,
        generation: input.generation,
        runnerProfile: provenance.profileId,
        runnerProfileVersion: provenance.profileVersion,
      }),
      `run-profile-provenance:${input.runId}`,
      input.createdAt,
    );
}

function runProfileVersionRow(
  store: StensiblyStore,
  runId: string,
): RunProfileVersionRow {
  const row = store.db
    .query<RunProfileVersionRow, [string]>(`
      SELECT runner_profile, runner_profile_version
      FROM work_runs
      WHERE id = ?1
    `)
    .get(runId);
  if (!row) throw new ConflictError(`Run ${runId} does not exist`);
  return row;
}
