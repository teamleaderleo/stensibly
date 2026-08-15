import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  admitRunnerAdapterCommandSettlementRecord,
  normalizeRunnerAdapterCommandReservation,
  normalizeRunnerAdapterCommandSettlement,
  runnerAdapterCommandOutcomeSha256,
  runnerAdapterCommandStableRequest,
  RunnerAdapterCommandConflictError,
  type ReserveRunnerAdapterCommandInput,
  type RunnerAdapterCommandReservation,
  type RunnerAdapterCommandReservationRecord,
  type RunnerAdapterCommandSettlement,
  type RunnerAdapterCommandSettlementRecord,
  type SettleRunnerAdapterCommandInput,
} from "./runner-adapter-command-contracts.js";
import { ensureRunSchema } from "./runs.js";
import type { StensiblyStore } from "./store.js";

interface ReservationRow {
  request_json: string;
  stable_request_json: string;
  reserved_at: string;
  settlement_json: string | null;
  settled_at: string | null;
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
      reserved_at TEXT NOT NULL,
      settlement_json TEXT,
      settled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runner_adapter_commands_run
      ON runner_adapter_commands(run_id, reserved_at);
  `);
  ensureSettlementColumns(store);
  initializedStores.add(store);
}

function ensureSettlementColumns(store: StensiblyStore): void {
  const columns = store.db
    .query<{ name: string }, []>("PRAGMA table_info(runner_adapter_commands)")
    .all();
  if (!columns.some((column) => column.name === "settlement_json")) {
    store.db.exec("ALTER TABLE runner_adapter_commands ADD COLUMN settlement_json TEXT");
  }
  if (!columns.some((column) => column.name === "settled_at")) {
    store.db.exec("ALTER TABLE runner_adapter_commands ADD COLUMN settled_at TEXT");
  }
}

export function getSqliteRunnerAdapterCommandByIdempotencyKey(
  store: StensiblyStore,
  rawIdempotencyKey: string,
): RunnerAdapterCommandReservation | null {
  ensureRunnerAdapterCommandSchema(store);
  const idempotencyKey = lookupIdempotencyKey(rawIdempotencyKey);
  const row = reservationByIdempotencyKey(store, idempotencyKey);
  return row === null ? null : replay(row, row.stable_request_json);
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
    return reservation("reserved", true, input, reservedAt, null);
  });
  return transaction.immediate();
}

export function settleSqliteRunnerAdapterCommand(
  store: StensiblyStore,
  rawInput: SettleRunnerAdapterCommandInput,
  now = new Date(),
): RunnerAdapterCommandSettlement {
  ensureRunnerAdapterCommandSchema(store);
  const input = normalizeRunnerAdapterCommandSettlement(rawInput);
  const outcomeSha256 = runnerAdapterCommandOutcomeSha256(input.outcome);
  const settledAt = now.toISOString();
  const transaction = store.db.transaction(() => {
    const row = reservationByCommandId(store, input.commandId);
    if (!row) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command cannot settle without a durable reservation",
      );
    }
    const request = JSON.parse(row.request_json) as ReserveRunnerAdapterCommandInput;
    if (request.commandFingerprint !== input.commandFingerprint) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command settlement fingerprint changed",
      );
    }
    const requested = settlementRecord(input, outcomeSha256, settledAt);
    if (row.settlement_json !== null) {
      const existing = parseSettlement(row);
      if (canonicalJsonString(existing) !== canonicalJsonString({
        ...requested,
        settledAt: existing.settledAt,
      })) {
        throw new RunnerAdapterCommandConflictError(
          "Runner adapter command was already settled with another outcome",
        );
      }
      return Object.freeze({ outcome: "replayed", settlement: existing });
    }
    store.db.query(`
      UPDATE runner_adapter_commands
      SET settlement_json = ?1, settled_at = ?2
      WHERE command_id = ?3 AND settlement_json IS NULL
    `).run(canonicalJsonString(requested), settledAt, input.commandId);
    return Object.freeze({ outcome: "settled", settlement: requested });
  });
  return transaction.immediate();
}

function reservationByIdempotencyKey(
  store: StensiblyStore,
  idempotencyKey: string,
): ReservationRow | null {
  return store.db.query<ReservationRow, [string]>(`
    SELECT request_json, stable_request_json, reserved_at, settlement_json, settled_at
    FROM runner_adapter_commands
    WHERE idempotency_key = ?1
  `).get(idempotencyKey) ?? null;
}

function reservationByCommandId(
  store: StensiblyStore,
  commandId: string,
): ReservationRow | null {
  return store.db.query<ReservationRow, [string]>(`
    SELECT request_json, stable_request_json, reserved_at, settlement_json, settled_at
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
  return reservation(
    "replayed",
    false,
    input,
    row.reserved_at,
    row.settlement_json === null ? null : parseSettlement(row),
  );
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
  settlement: RunnerAdapterCommandSettlementRecord | null,
): RunnerAdapterCommandReservation {
  const command: RunnerAdapterCommandReservationRecord = Object.freeze({
    ...input,
    actor: Object.freeze({ ...input.actor }),
    reservedAt,
  });
  return Object.freeze({
    outcome,
    dispatchAuthorized,
    command,
    settlement,
  }) as RunnerAdapterCommandReservation;
}

function settlementRecord(
  input: SettleRunnerAdapterCommandInput,
  outcomeSha256: string,
  settledAt: string,
): RunnerAdapterCommandSettlementRecord {
  return Object.freeze({
    commandId: input.commandId,
    commandFingerprint: input.commandFingerprint,
    outcome: Object.freeze({ ...input.outcome }),
    outcomeSha256,
    settledAt,
  });
}

function parseSettlement(row: ReservationRow): RunnerAdapterCommandSettlementRecord {
  if (row.settlement_json === null || row.settled_at === null) {
    throw new RunnerAdapterCommandConflictError(
      "Runner adapter command settlement storage is incomplete",
    );
  }
  const value = admitRunnerAdapterCommandSettlementRecord(
    JSON.parse(row.settlement_json) as RunnerAdapterCommandSettlementRecord,
  );
  if (value.settledAt !== row.settled_at) {
    throw new RunnerAdapterCommandConflictError(
      "Runner adapter command settlement storage is invalid",
    );
  }
  return value;
}

function lookupIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Runner adapter command lookup idempotency key must be a string");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new RangeError(
      "Runner adapter command lookup idempotency key must be between 1 and 240 characters",
    );
  }
  return normalized;
}
