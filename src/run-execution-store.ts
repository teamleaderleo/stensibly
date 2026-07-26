import { randomUUID } from "node:crypto";
import {
  executionEnvelopeJson,
  parseExecutionActual,
  parseExecutionEnvelope,
  type ExecutionActual,
  type ExecutionEnvelope,
} from "./execution-envelope.js";
import type { WorkRun as CoreWorkRun } from "./runs-core.js";
import { ConflictError, StensiblyStore } from "./store.js";

export interface RunExecutionRecord {
  id: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  transition: string;
  actual: ExecutionActual;
  createdAt: string;
}

export type HydratedWorkRun = CoreWorkRun & {
  executionEnvelope: ExecutionEnvelope | null;
  executionRecords: RunExecutionRecord[];
};

interface EnvelopeRow {
  envelope_json: string;
}

interface EnvelopeIdentityRow {
  run_id: string;
  envelope_json: string;
}

interface ExistingKeyRow {
  exists_flag: number;
}

interface ExecutionRecordRow {
  id: string;
  run_id: string;
  run_generation: number;
  lease_generation: number;
  transition: string;
  actual_json: string;
  created_at: string;
}

const initializedStores = new WeakSet<StensiblyStore>();
const terminalCommands = new Set(["succeed", "fail", "cancel", "abandon"]);

export function ensureRunExecutionSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS run_execution_envelopes (
      run_id TEXT PRIMARY KEY REFERENCES work_runs(id) ON DELETE CASCADE,
      envelope_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_execution_records (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES work_runs(id) ON DELETE CASCADE,
      run_generation INTEGER NOT NULL CHECK (run_generation >= 1),
      lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
      transition TEXT NOT NULL,
      actual_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dispatch_execution_envelopes (
      idempotency_key TEXT PRIMARY KEY,
      envelope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_execution_records_run
      ON run_execution_records(run_id, created_at);
  `);
  initializedStores.add(store);
}

export function requiredExecutionEnvelope(value: unknown): ExecutionEnvelope {
  return parseExecutionEnvelope(value);
}

export function hasExecutionEnvelope(
  store: StensiblyStore,
  runId: string,
): boolean {
  ensureRunExecutionSchema(store);
  return store.db
    .query<ExistingKeyRow, [string]>(`
      SELECT 1 AS exists_flag
      FROM run_execution_envelopes
      WHERE run_id = ?1
      LIMIT 1
    `)
    .get(runId) !== null;
}

export function assertEnvelopeIdempotency(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  envelope: ExecutionEnvelope,
  label: string,
): void {
  if (!idempotencyKey) return;
  ensureRunExecutionSchema(store);
  const existing = store.db
    .query<EnvelopeIdentityRow, [string]>(`
      SELECT run_id, envelope_json
      FROM run_execution_envelopes
      WHERE idempotency_key = ?1
    `)
    .get(idempotencyKey);
  if (existing) {
    if (existing.envelope_json !== executionEnvelopeJson(envelope)) {
      throw new ConflictError(
        `Idempotency key was already used with a different ${label} execution envelope`,
      );
    }
    return;
  }
  const legacy = store.db
    .query<ExistingKeyRow, [string]>(`
      SELECT 1 AS exists_flag
      FROM work_runs
      WHERE idempotency_key = ?1
      LIMIT 1
    `)
    .get(idempotencyKey);
  if (legacy) {
    throw new ConflictError(
      `Idempotency key belongs to a legacy ${label} without an execution envelope`,
    );
  }
}

export function bindExecutionEnvelope(
  store: StensiblyStore,
  runId: string,
  envelope: ExecutionEnvelope,
  idempotencyKey: string | undefined,
  createdAt: string,
): void {
  ensureRunExecutionSchema(store);
  const envelopeJson = executionEnvelopeJson(envelope);
  const existing = store.db
    .query<EnvelopeIdentityRow, [string]>(`
      SELECT run_id, envelope_json
      FROM run_execution_envelopes
      WHERE run_id = ?1
    `)
    .get(runId);
  if (existing) {
    if (existing.envelope_json !== envelopeJson) {
      throw new ConflictError("Execution envelope is immutable after run creation");
    }
    return;
  }
  store.db
    .query(`
      INSERT INTO run_execution_envelopes (
        run_id, envelope_json, idempotency_key, created_at
      ) VALUES (?1, ?2, ?3, ?4)
    `)
    .run(runId, envelopeJson, idempotencyKey ?? null, createdAt);
}

export function recordDispatchEnvelopeIdempotency(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  envelope: ExecutionEnvelope,
  createdAt: string,
): void {
  if (!idempotencyKey) return;
  ensureRunExecutionSchema(store);
  store.db
    .query(`
      INSERT OR IGNORE INTO dispatch_execution_envelopes (
        idempotency_key, envelope_json, created_at
      ) VALUES (?1, ?2, ?3)
    `)
    .run(idempotencyKey, executionEnvelopeJson(envelope), createdAt);
}

export function hydrateWorkRun(
  store: StensiblyStore,
  run: CoreWorkRun,
): HydratedWorkRun {
  ensureRunExecutionSchema(store);
  const envelopeRow = store.db
    .query<EnvelopeRow, [string]>(`
      SELECT envelope_json
      FROM run_execution_envelopes
      WHERE run_id = ?1
    `)
    .get(run.id);
  const executionEnvelope = envelopeRow
    ? parseExecutionEnvelope(JSON.parse(envelopeRow.envelope_json) as unknown)
    : null;
  const executionRecords = store.db
    .query<ExecutionRecordRow, [string]>(`
      SELECT id, run_id, run_generation, lease_generation,
             transition, actual_json, created_at
      FROM run_execution_records
      WHERE run_id = ?1
      ORDER BY created_at ASC, rowid ASC
    `)
    .all(run.id)
    .map(mapExecutionRecord);
  return { ...run, executionEnvelope, executionRecords };
}

export function hydrateWorkRuns(
  store: StensiblyStore,
  runs: CoreWorkRun[],
): HydratedWorkRun[] {
  return runs.map((run) => hydrateWorkRun(store, run));
}

export function appendExecutionRecord(
  store: StensiblyStore,
  input: {
    run: CoreWorkRun;
    transition: string;
    actual?: unknown;
    idempotencyKey?: string;
    createdAt: string;
  },
): void {
  if (!terminalCommands.has(input.transition)) {
    if (input.actual !== undefined) {
      throw new TypeError("Execution actuals may be recorded only for terminal transitions");
    }
    return;
  }
  ensureRunExecutionSchema(store);
  if (!hasExecutionEnvelope(store, input.run.id)) return;
  const actual = parseExecutionActual(input.actual);
  if (input.idempotencyKey) {
    const existing = store.db
      .query<ExecutionRecordRow, [string]>(`
        SELECT id, run_id, run_generation, lease_generation,
               transition, actual_json, created_at
        FROM run_execution_records
        WHERE idempotency_key = ?1
      `)
      .get(input.idempotencyKey);
    if (existing) {
      const same = existing.run_id === input.run.id
        && existing.run_generation === input.run.generation
        && existing.lease_generation === input.run.leaseGeneration
        && existing.transition === input.transition
        && existing.actual_json === JSON.stringify(actual);
      if (!same) {
        throw new ConflictError(
          "Idempotency key was already used for a different execution result",
        );
      }
      return;
    }
  }
  store.db
    .query(`
      INSERT INTO run_execution_records (
        id, run_id, run_generation, lease_generation,
        transition, actual_json, idempotency_key, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `)
    .run(
      `rex_${randomUUID()}`,
      input.run.id,
      input.run.generation,
      input.run.leaseGeneration,
      input.transition,
      JSON.stringify(actual),
      input.idempotencyKey ?? null,
      input.createdAt,
    );
}

function mapExecutionRecord(row: ExecutionRecordRow): RunExecutionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    runGeneration: row.run_generation,
    leaseGeneration: row.lease_generation,
    transition: row.transition,
    actual: parseExecutionActual(JSON.parse(row.actual_json) as unknown),
    createdAt: row.created_at,
  };
}
