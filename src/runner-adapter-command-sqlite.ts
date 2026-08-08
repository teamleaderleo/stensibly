import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  normalizeRunnerAdapterCommandReservation,
  runnerAdapterCommandStableRequest,
  RunnerAdapterCommandConflictError,
  type ReserveRunnerAdapterCommandInput,
  type RunnerAdapterCommandReservation,
  type RunnerAdapterCommandReservationRecord,
} from "./runner-adapter-command-contracts.js";
import { ensureRunSchema } from "./runs.js";
import type { StensiblyStore } from "./store.js";

interface ReservationRow {
  request_json: string;
  stable_request_json: string;
  reserved_at: string;
}

interface AuthorityRow {
  item_id: string;
  project_id: string;
  generation: number;
  lease_generation: number;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
}

const initializedStores = new WeakSet<StensiblyStore>();

export function ensureRunnerAdapterCommandSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  ensureRunSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS runner_adapter_commands (
      idempotency_key TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id),
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES work_runs(id) ON DELETE CASCADE,
      run_generation INTEGER NOT NULL CHECK (run_generation >= 1),
      lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      adapter_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      command_fingerprint TEXT NOT NULL,
      request_json TEXT NOT NULL,
      stable_request_json TEXT NOT NULL,
      reserved_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runner_adapter_commands_run
      ON runner_adapter_commands(run_id, reserved_at);
  `);
  initializedStores.add(store);
}

export function reserveSqliteRunnerAdapterCommand(
  store: StensiblyStore,
  rawInput: ReserveRunnerAdapterCommandInput,
  now = new Date(),
): RunnerAdapterCommandReservation {
  ensureRunnerAdapterCommandSchema(store);
  const input = normalizeRunnerAdapterCommandReservation(rawInput);
  const requestJson = canonicalJsonString(input);
  const stableRequestJson = canonicalJsonString(runnerAdapterCommandStableRequest(input));
  const reservedAt = now.toISOString();
  const transaction = store.db.transaction(() => {
    const idempotencyReplay = reservationByIdempotencyKey(store, input.idempotencyKey);
    if (idempotencyReplay) return replay(idempotencyReplay, stableRequestJson);

    const commandReplay = reservationByCommandId(store, input.commandId);
    if (commandReplay) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command ID was already reserved with a different idempotency key",
      );
    }

    const authority = store.db.query<AuthorityRow, [string]>(`
      SELECT
        work_runs.item_id,
        items.project_id,
        work_runs.generation,
        work_runs.lease_generation,
        work_runs.lease_owner_id,
        work_runs.lease_expires_at
      FROM work_runs
      INNER JOIN items ON items.id = work_runs.item_id
      WHERE work_runs.id = ?1
    `).get(input.runId);
    if (!authority) {
      throw new RunnerAdapterCommandConflictError(`Run ${input.runId} does not exist`);
    }
    requireAuthority(authority, input, now);

    store.db.query(`
      INSERT INTO runner_adapter_commands (
        idempotency_key, command_id, project_id, item_id, run_id,
        run_generation, lease_generation, actor_id, adapter_id, profile_id,
        request_fingerprint, command_fingerprint, request_json,
        stable_request_json, reserved_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
      )
    `).run(
      input.idempotencyKey,
      input.commandId,
      input.project,
      input.itemId,
      input.runId,
      input.runGeneration,
      input.leaseGeneration,
      input.actor.id,
      input.adapterId,
      input.profileId,
      input.requestFingerprint,
      input.commandFingerprint,
      requestJson,
      stableRequestJson,
      reservedAt,
    );
    return reservation("reserved", true, input, reservedAt);
  });
  return transaction.immediate();
}

function reservationByIdempotencyKey(
  store: StensiblyStore,
  idempotencyKey: string,
): ReservationRow | null {
  return store.db.query<ReservationRow, [string]>(`
    SELECT request_json, stable_request_json, reserved_at
    FROM runner_adapter_commands
    WHERE idempotency_key = ?1
  `).get(idempotencyKey) ?? null;
}

function reservationByCommandId(
  store: StensiblyStore,
  commandId: string,
): ReservationRow | null {
  return store.db.query<ReservationRow, [string]>(`
    SELECT request_json, stable_request_json, reserved_at
    FROM runner_adapter_commands
    WHERE command_id = ?1
  `).get(commandId) ?? null;
}

function replay(row: ReservationRow, stableRequestJson: string): RunnerAdapterCommandReservation {
  if (row.stable_request_json !== stableRequestJson) {
    throw new RunnerAdapterCommandConflictError(
      "Runner adapter command idempotency key was already used for a different command",
    );
  }
  const input = JSON.parse(row.request_json) as ReserveRunnerAdapterCommandInput;
  return reservation("replayed", false, input, row.reserved_at);
}

function requireAuthority(
  current: AuthorityRow,
  input: ReserveRunnerAdapterCommandInput,
  now: Date,
): void {
  if (current.project_id !== input.project || current.item_id !== input.itemId) {
    throw new RunnerAdapterCommandConflictError(
      "Runner adapter command project or item does not match the run",
    );
  }
  if (current.generation !== input.runGeneration) {
    throw new RunnerAdapterCommandConflictError(
      `Run generation changed from ${input.runGeneration} to ${current.generation}`,
    );
  }
  if (current.lease_generation !== input.leaseGeneration) {
    throw new RunnerAdapterCommandConflictError(
      `Run lease generation changed from ${input.leaseGeneration} to ${current.lease_generation}`,
    );
  }
  if (current.lease_owner_id !== input.actor.id) {
    throw new RunnerAdapterCommandConflictError(
      "Only the current run lease owner can reserve adapter dispatch",
    );
  }
  if (!current.lease_expires_at || Date.parse(current.lease_expires_at) <= now.getTime()) {
    throw new RunnerAdapterCommandConflictError("Run lease has expired");
  }
}

function reservation<TOutcome extends "reserved" | "replayed", TAuthorized extends boolean>(
  outcome: TOutcome,
  dispatchAuthorized: TAuthorized,
  input: ReserveRunnerAdapterCommandInput,
  reservedAt: string,
): RunnerAdapterCommandReservation {
  const command: RunnerAdapterCommandReservationRecord = Object.freeze({
    ...input,
    actor: Object.freeze({ ...input.actor }),
    reservedAt,
  });
  return Object.freeze({ outcome, dispatchAuthorized, command }) as RunnerAdapterCommandReservation;
}
