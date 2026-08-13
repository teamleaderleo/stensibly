import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  normalizeRunnerAdapterCommandReservation,
  RunnerAdapterCommandConflictError,
  type ReserveRunnerAdapterCommandInput,
} from "./runner-adapter-command-contracts.js";
import {
  parseRunnerExternalReferenceV1,
  type RunnerExternalReferenceV1,
} from "./runner-adapter-v1.js";
import { actorSchema, type ActorInput } from "./schemas.js";
import { sha256Hex } from "./sha256.js";
import {
  ensureRunnerAdapterCommandSchema,
} from "./runner-adapter-command-sqlite.js";
import type { StensiblyStore } from "./store.js";

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MINIMUM_RECOVERY_LEASE_SECONDS = 30;
const MAXIMUM_RECOVERY_LEASE_SECONDS = 3_600;

export interface ClaimRunnerAdapterCommandRecoveryInput {
  commandId: string;
  commandFingerprint: string;
  actor: ActorInput;
  leaseSeconds: number;
  idempotencyKey: string;
}

export interface RunnerAdapterCommandCheckpointLineageV1 {
  version: 1;
  externalId: string;
  checkpointDigest: string;
  referenceSha256: string;
  runGeneration: number;
  createdAt: string;
}

export interface RunnerAdapterCommandRecoveryClaimRecord {
  version: 1;
  commandId: string;
  commandFingerprint: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  recoveryGeneration: number;
  actor: ActorInput;
  checkpoint: RunnerAdapterCommandCheckpointLineageV1 | null;
  claimedAt: string;
  expiresAt: string;
  authorizesRedispatch: false;
  authorizesResume: false;
}

export type RunnerAdapterCommandRecoveryClaim = {
  outcome: "claimed" | "replayed";
  claim: RunnerAdapterCommandRecoveryClaimRecord;
};

interface ReservationRow {
  request_json: string;
  settlement_json: string | null;
}

interface RunRow {
  generation: number;
  lease_generation: number;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  checkpoint: string | null;
}

interface RecoveryRow {
  request_json: string;
  claim_json: string;
  recovery_generation: number;
  expires_at: string;
}

export function ensureRunnerAdapterCommandRecoverySchema(store: StensiblyStore): void {
  ensureRunnerAdapterCommandSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS runner_adapter_command_recoveries (
      idempotency_key TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      recovery_generation INTEGER NOT NULL CHECK (recovery_generation >= 1),
      actor_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      claim_json TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE(command_id, recovery_generation),
      FOREIGN KEY(command_id) REFERENCES runner_adapter_commands(command_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runner_adapter_command_recoveries_command
      ON runner_adapter_command_recoveries(command_id, recovery_generation);
  `);
}

export function claimSqliteRunnerAdapterCommandRecovery(
  store: StensiblyStore,
  rawInput: ClaimRunnerAdapterCommandRecoveryInput,
  now = new Date(),
): RunnerAdapterCommandRecoveryClaim {
  ensureRunnerAdapterCommandRecoverySchema(store);
  const input = normalizeRunnerAdapterCommandRecoveryInput(rawInput);
  const requestJson = canonicalJsonString(input);
  const timestamp = canonicalNow(now);

  const transaction = store.db.transaction(() => {
    const idempotencyReplay = recoveryByIdempotencyKey(store, input.idempotencyKey);
    if (idempotencyReplay) {
      if (idempotencyReplay.request_json !== requestJson) {
        throw new RunnerAdapterCommandConflictError(
          "Runner adapter command recovery idempotency key was already used for another request",
        );
      }
      return Object.freeze({
        outcome: "replayed" as const,
        claim: admitRunnerAdapterCommandRecoveryClaimRecord(
          JSON.parse(idempotencyReplay.claim_json) as unknown,
        ),
      });
    }

    const reservationRow = store.db.query<ReservationRow, [string]>(`
      SELECT request_json, settlement_json
      FROM runner_adapter_commands
      WHERE command_id = ?1
    `).get(input.commandId);
    if (!reservationRow) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command recovery requires a durable command reservation",
      );
    }
    if (reservationRow.settlement_json !== null) {
      throw new RunnerAdapterCommandConflictError(
        "Settled runner adapter commands cannot enter recovery ownership",
      );
    }

    const reservation = normalizeRunnerAdapterCommandReservation(
      JSON.parse(reservationRow.request_json) as ReserveRunnerAdapterCommandInput,
    );
    if (reservation.commandFingerprint !== input.commandFingerprint) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command recovery fingerprint changed",
      );
    }

    const run = store.db.query<RunRow, [string]>(`
      SELECT generation, lease_generation, lease_owner_id, lease_expires_at, checkpoint
      FROM work_runs
      WHERE id = ?1
    `).get(reservation.runId);
    if (!run) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command recovery run no longer exists",
      );
    }

    const leaseExpiresAt = run.lease_expires_at === null
      ? null
      : Date.parse(run.lease_expires_at);
    const currentLeaseLive = leaseExpiresAt !== null && leaseExpiresAt > now.getTime();
    const originalAuthorityStillLive = currentLeaseLive
      && run.generation === reservation.runGeneration
      && run.lease_generation === reservation.leaseGeneration
      && run.lease_owner_id === reservation.actor.id;
    if (originalAuthorityStillLive) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command recovery cannot replace live original authority",
      );
    }
    if (currentLeaseLive && run.lease_owner_id !== input.actor.id) {
      throw new RunnerAdapterCommandConflictError(
        "A live successor run lease belongs to another recovery actor",
      );
    }

    const latestRecovery = latestRecoveryForCommand(store, input.commandId);
    if (latestRecovery && Date.parse(latestRecovery.expires_at) > now.getTime()) {
      throw new RunnerAdapterCommandConflictError(
        "Runner adapter command already has an active recovery owner",
      );
    }

    const checkpoint = checkpointLineage(run.checkpoint, reservation);
    const recoveryGeneration = (latestRecovery?.recovery_generation ?? 0) + 1;
    const expiresAt = new Date(
      now.getTime() + input.leaseSeconds * 1_000,
    ).toISOString();
    const claim = admitRunnerAdapterCommandRecoveryClaimRecord({
      version: 1,
      commandId: reservation.commandId,
      commandFingerprint: reservation.commandFingerprint,
      runId: reservation.runId,
      runGeneration: reservation.runGeneration,
      leaseGeneration: reservation.leaseGeneration,
      recoveryGeneration,
      actor: input.actor,
      checkpoint,
      claimedAt: timestamp,
      expiresAt,
      authorizesRedispatch: false,
      authorizesResume: false,
    });

    store.db.query(`
      INSERT INTO runner_adapter_command_recoveries (
        idempotency_key, command_id, recovery_generation, actor_id,
        request_json, claim_json, claimed_at, expires_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).run(
      input.idempotencyKey,
      input.commandId,
      recoveryGeneration,
      input.actor.id,
      requestJson,
      canonicalJsonString(claim),
      timestamp,
      expiresAt,
    );

    return Object.freeze({ outcome: "claimed" as const, claim });
  });

  return transaction.immediate();
}

export function normalizeRunnerAdapterCommandRecoveryInput(
  input: ClaimRunnerAdapterCommandRecoveryInput,
): ClaimRunnerAdapterCommandRecoveryInput {
  return Object.freeze({
    commandId: boundedText(input.commandId, "Runner adapter recovery command ID", 160),
    commandFingerprint: fingerprint(
      input.commandFingerprint,
      "Runner adapter recovery command fingerprint",
    ),
    actor: Object.freeze(actorSchema.parse(input.actor)),
    leaseSeconds: boundedInteger(
      input.leaseSeconds,
      MINIMUM_RECOVERY_LEASE_SECONDS,
      MAXIMUM_RECOVERY_LEASE_SECONDS,
      "Runner adapter recovery lease seconds",
    ),
    idempotencyKey: boundedText(
      input.idempotencyKey,
      "Runner adapter recovery idempotency key",
      240,
    ),
  });
}

export function admitRunnerAdapterCommandRecoveryClaimRecord(
  value: unknown,
): RunnerAdapterCommandRecoveryClaimRecord {
  const input = exactRecord(value, "Runner adapter command recovery claim", [
    "version",
    "commandId",
    "commandFingerprint",
    "runId",
    "runGeneration",
    "leaseGeneration",
    "recoveryGeneration",
    "actor",
    "checkpoint",
    "claimedAt",
    "expiresAt",
    "authorizesRedispatch",
    "authorizesResume",
  ]);
  if (input.version !== 1) {
    throw new RangeError("Runner adapter command recovery claim version is invalid");
  }
  if (input.authorizesRedispatch !== false || input.authorizesResume !== false) {
    throw new RangeError("Runner adapter command recovery claim cannot authorize execution");
  }
  const claimedAt = canonicalTimestamp(
    input.claimedAt,
    "Runner adapter command recovery claim time",
  );
  const expiresAt = canonicalTimestamp(
    input.expiresAt,
    "Runner adapter command recovery expiry",
  );
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
    throw new RangeError("Runner adapter command recovery expiry must follow claim time");
  }
  return Object.freeze({
    version: 1,
    commandId: boundedText(input.commandId, "Runner adapter recovery command ID", 160),
    commandFingerprint: fingerprint(
      input.commandFingerprint,
      "Runner adapter recovery command fingerprint",
    ),
    runId: boundedText(input.runId, "Runner adapter recovery run ID", 240),
    runGeneration: positiveInteger(
      input.runGeneration,
      "Runner adapter recovery run generation",
    ),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Runner adapter recovery lease generation",
    ),
    recoveryGeneration: positiveInteger(
      input.recoveryGeneration,
      "Runner adapter recovery generation",
    ),
    actor: Object.freeze(actorSchema.parse(input.actor)),
    checkpoint: input.checkpoint === null
      ? null
      : admitCheckpointLineage(input.checkpoint),
    claimedAt,
    expiresAt,
    authorizesRedispatch: false,
    authorizesResume: false,
  });
}

function checkpointLineage(
  serialized: string | null,
  reservation: ReserveRunnerAdapterCommandInput,
): RunnerAdapterCommandCheckpointLineageV1 | null {
  if (serialized === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    throw new RunnerAdapterCommandConflictError(
      "Durable runner checkpoint cannot be admitted for command recovery",
    );
  }
  let reference: RunnerExternalReferenceV1;
  try {
    reference = parseRunnerExternalReferenceV1(decoded);
  } catch {
    throw new RunnerAdapterCommandConflictError(
      "Durable runner checkpoint cannot be admitted for command recovery",
    );
  }
  if (
    reference.kind !== "checkpoint"
    || reference.adapterId !== reservation.adapterId
    || reference.generation !== reservation.runGeneration
    || reference.uri !== null
    || reference.externalId === null
    || reference.digest === null
  ) {
    throw new RunnerAdapterCommandConflictError(
      "Durable runner checkpoint does not match the stranded command lineage",
    );
  }
  return Object.freeze({
    version: 1,
    externalId: reference.externalId,
    checkpointDigest: reference.digest,
    referenceSha256: `sha256:${sha256Hex(canonicalJsonString(reference))}`,
    runGeneration: reservation.runGeneration,
    createdAt: reference.createdAt,
  });
}

function admitCheckpointLineage(value: unknown): RunnerAdapterCommandCheckpointLineageV1 {
  const input = exactRecord(value, "Runner adapter checkpoint lineage", [
    "version",
    "externalId",
    "checkpointDigest",
    "referenceSha256",
    "runGeneration",
    "createdAt",
  ]);
  if (input.version !== 1) {
    throw new RangeError("Runner adapter checkpoint lineage version is invalid");
  }
  return Object.freeze({
    version: 1,
    externalId: boundedText(input.externalId, "Runner adapter checkpoint external ID", 160),
    checkpointDigest: fingerprint(
      input.checkpointDigest,
      "Runner adapter checkpoint digest",
    ),
    referenceSha256: fingerprint(
      input.referenceSha256,
      "Runner adapter checkpoint reference fingerprint",
    ),
    runGeneration: positiveInteger(
      input.runGeneration,
      "Runner adapter checkpoint run generation",
    ),
    createdAt: canonicalTimestamp(input.createdAt, "Runner adapter checkpoint creation time"),
  });
}

function recoveryByIdempotencyKey(
  store: StensiblyStore,
  idempotencyKey: string,
): RecoveryRow | null {
  return store.db.query<RecoveryRow, [string]>(`
    SELECT request_json, claim_json, recovery_generation, expires_at
    FROM runner_adapter_command_recoveries
    WHERE idempotency_key = ?1
  `).get(idempotencyKey) ?? null;
}

function latestRecoveryForCommand(
  store: StensiblyStore,
  commandId: string,
): RecoveryRow | null {
  return store.db.query<RecoveryRow, [string]>(`
    SELECT request_json, claim_json, recovery_generation, expires_at
    FROM runner_adapter_command_recoveries
    WHERE command_id = ?1
    ORDER BY recovery_generation DESC
    LIMIT 1
  `).get(commandId) ?? null;
}

function exactRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RangeError(`${label} has unexpected fields`);
  }
  return record;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
}

function fingerprint(value: unknown, label: string): string {
  const normalized = boundedText(value, label, 71);
  if (!FINGERPRINT_PATTERN.test(normalized)) throw new RangeError(`${label} is invalid`);
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = boundedText(value, label, 40);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new RangeError(`${label} is invalid`);
  }
  return timestamp;
}

function canonicalNow(now: Date): string {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("Runner adapter recovery clock is invalid");
  }
  return new Date(milliseconds).toISOString();
}
