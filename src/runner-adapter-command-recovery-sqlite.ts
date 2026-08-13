import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  normalizeRunnerAdapterCommandReservation,
  RunnerAdapterCommandConflictError,
  type ReserveRunnerAdapterCommandInput,
} from "./runner-adapter-command-contracts.js";
import {
  admitRunnerAdapterCommandRecoveryClaimRecord,
  normalizeRunnerAdapterCommandRecoveryInput,
  runnerAdapterCommandCheckpointLineage,
  type ClaimRunnerAdapterCommandRecoveryInput,
  type RunnerAdapterCommandRecoveryClaim,
} from "./runner-adapter-command-recovery.js";
import { ensureRunnerAdapterCommandSchema } from "./runner-adapter-command-sqlite.js";
import type { StensiblyStore } from "./store.js";

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

    const checkpoint = runnerAdapterCommandCheckpointLineage(run.checkpoint, reservation);
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

function canonicalNow(now: Date): string {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("Runner adapter recovery clock is invalid");
  }
  return new Date(milliseconds).toISOString();
}
