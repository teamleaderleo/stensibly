import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  normalizeRunnerAdapterCommandReservation,
  RunnerAdapterCommandConflictError,
  type ReserveRunnerAdapterCommandInput,
} from "./runner-adapter-command-contracts.js";
import {
  parseRunnerExternalReferencePortableV1,
  type RunnerExternalReferencePortableV1,
} from "./runner-external-reference-portable.js";
import { actorSchema, type ActorInput } from "./schemas.js";
import { sha256Hex } from "./sha256.js";

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

export function runnerAdapterCommandCheckpointLineage(
  serialized: string | null,
  rawReservation: ReserveRunnerAdapterCommandInput,
): RunnerAdapterCommandCheckpointLineageV1 | null {
  if (serialized === null) return null;
  const reservation = normalizeRunnerAdapterCommandReservation(rawReservation);
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    throw new RunnerAdapterCommandConflictError(
      "Durable runner checkpoint cannot be admitted for command recovery",
    );
  }
  let reference: RunnerExternalReferencePortableV1;
  try {
    reference = parseRunnerExternalReferencePortableV1(decoded);
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
