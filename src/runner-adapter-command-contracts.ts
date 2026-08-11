import { actorSchema, type ActorInput } from "./schemas.js";
import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import { sha256Hex } from "./sha256.js";

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface ReserveRunnerAdapterCommandInput {
  project: string;
  itemId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  actor: ActorInput;
  adapterId: string;
  profileId: string;
  /** Stable digest of operation inputs, fences, actor, adapter/profile config, and correlation. */
  requestFingerprint: string;
  /** Immutable identity of the full generated command stored only for the winning reservation. */
  commandId: string;
  /** Immutable digest of the full generated command stored only for the winning reservation. */
  commandFingerprint: string;
  idempotencyKey: string;
}

export interface RunnerAdapterCommandReservationRecord
  extends ReserveRunnerAdapterCommandInput {
  reservedAt: string;
}

export interface RunnerAdapterCommandOutcomeV1 {
  version: 1;
  kind: "bounded_episode_completed";
  observationCount: number;
  observationsSha256: string;
  terminalObservationId: string;
  terminalObservationType: string;
  latestCheckpointExternalId: string | null;
  latestCheckpointSha256: string | null;
  containsPrivateContent: false;
  containsCredentials: false;
}

export interface SettleRunnerAdapterCommandInput {
  commandId: string;
  commandFingerprint: string;
  outcome: RunnerAdapterCommandOutcomeV1;
}

export interface RunnerAdapterCommandSettlementRecord
  extends SettleRunnerAdapterCommandInput {
  outcomeSha256: string;
  settledAt: string;
}

export type RunnerAdapterCommandSettlement = {
  outcome: "settled" | "replayed";
  settlement: RunnerAdapterCommandSettlementRecord;
};

export type RunnerAdapterCommandReservation =
  | {
    outcome: "reserved";
    dispatchAuthorized: true;
    command: RunnerAdapterCommandReservationRecord;
    settlement: null;
  }
  | {
    outcome: "replayed";
    dispatchAuthorized: false;
    command: RunnerAdapterCommandReservationRecord;
    settlement: RunnerAdapterCommandSettlementRecord | null;
  };

export interface RunnerAdapterCommandLedger {
  reserveRunnerAdapterCommand(
    input: ReserveRunnerAdapterCommandInput,
  ): Promise<RunnerAdapterCommandReservation>;
  settleRunnerAdapterCommand(
    input: SettleRunnerAdapterCommandInput,
  ): Promise<RunnerAdapterCommandSettlement>;
}

export class RunnerAdapterCommandConflictError extends Error {
  readonly code = "runner_adapter_command_conflict";

  constructor(message = "Runner adapter command reservation conflicts with durable state") {
    super(message);
    this.name = "RunnerAdapterCommandConflictError";
  }
}

export function runnerAdapterCommandLedger(
  value: unknown,
): RunnerAdapterCommandLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RunnerAdapterCommandLedger>;
  return typeof candidate.reserveRunnerAdapterCommand === "function"
      && typeof candidate.settleRunnerAdapterCommand === "function"
    ? candidate as RunnerAdapterCommandLedger
    : null;
}

export function normalizeRunnerAdapterCommandReservation(
  input: ReserveRunnerAdapterCommandInput,
): ReserveRunnerAdapterCommandInput {
  return Object.freeze({
    project: patternText(input.project, "Runner adapter command project", PROJECT_PATTERN, 80),
    itemId: boundedText(input.itemId, "Runner adapter command item ID", 240),
    runId: boundedText(input.runId, "Runner adapter command run ID", 240),
    runGeneration: positiveInteger(input.runGeneration, "Runner adapter command run generation"),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Runner adapter command lease generation",
    ),
    actor: Object.freeze(actorSchema.parse(input.actor)),
    adapterId: boundedText(input.adapterId, "Runner adapter command adapter ID", 80),
    profileId: boundedText(input.profileId, "Runner adapter command profile ID", 79),
    requestFingerprint: patternText(
      input.requestFingerprint,
      "Runner adapter command reservation request fingerprint",
      FINGERPRINT_PATTERN,
      71,
    ),
    commandId: boundedText(input.commandId, "Runner adapter command ID", 160),
    commandFingerprint: patternText(
      input.commandFingerprint,
      "Runner adapter command fingerprint",
      FINGERPRINT_PATTERN,
      71,
    ),
    idempotencyKey: boundedText(
      input.idempotencyKey,
      "Runner adapter command idempotency key",
      240,
    ),
  });
}

export function runnerAdapterCommandStableRequest(
  input: ReserveRunnerAdapterCommandInput,
) {
  const { commandId: _commandId, commandFingerprint: _commandFingerprint, ...stable } = input;
  return stable;
}

export function normalizeRunnerAdapterCommandSettlement(
  input: SettleRunnerAdapterCommandInput,
): SettleRunnerAdapterCommandInput {
  exactKeys(input, ["commandId", "commandFingerprint", "outcome"], "Runner adapter command settlement");
  const outcome = input.outcome;
  if (!outcome || typeof outcome !== "object") {
    throw new TypeError("Runner adapter command outcome must be an object");
  }
  exactKeys(outcome, [
    "version", "kind", "observationCount", "observationsSha256",
    "terminalObservationId", "terminalObservationType",
    "latestCheckpointExternalId", "latestCheckpointSha256",
    "containsPrivateContent", "containsCredentials",
  ], "Runner adapter command outcome");
  if (
    outcome.version !== 1
    || outcome.kind !== "bounded_episode_completed"
    || outcome.containsPrivateContent !== false
    || outcome.containsCredentials !== false
  ) {
    throw new RangeError("Runner adapter command outcome contract is invalid");
  }
  const latestCheckpointExternalId = nullableText(
    outcome.latestCheckpointExternalId,
    "Runner adapter checkpoint external ID",
    512,
  );
  const latestCheckpointSha256 = nullableFingerprint(
    outcome.latestCheckpointSha256,
    "Runner adapter checkpoint fingerprint",
  );
  if ((latestCheckpointExternalId === null) !== (latestCheckpointSha256 === null)) {
    throw new RangeError("Runner adapter checkpoint outcome identity is incomplete");
  }
  return Object.freeze({
    commandId: boundedText(input.commandId, "Runner adapter command ID", 160),
    commandFingerprint: patternText(
      input.commandFingerprint,
      "Runner adapter command fingerprint",
      FINGERPRINT_PATTERN,
      71,
    ),
    outcome: Object.freeze({
      version: 1,
      kind: "bounded_episode_completed",
      observationCount: boundedPositiveInteger(
        outcome.observationCount,
        "Runner adapter observation count",
        32,
      ),
      observationsSha256: patternText(
        outcome.observationsSha256,
        "Runner adapter observations fingerprint",
        FINGERPRINT_PATTERN,
        71,
      ),
      terminalObservationId: boundedText(
        outcome.terminalObservationId,
        "Runner adapter terminal observation ID",
        160,
      ),
      terminalObservationType: boundedText(
        outcome.terminalObservationType,
        "Runner adapter terminal observation type",
        80,
      ),
      latestCheckpointExternalId,
      latestCheckpointSha256,
      containsPrivateContent: false,
      containsCredentials: false,
    }),
  });
}

export function runnerAdapterCommandOutcomeSha256(
  outcome: RunnerAdapterCommandOutcomeV1,
): string {
  return `sha256:${sha256Hex(canonicalJsonString(outcome))}`;
}

export function admitRunnerAdapterCommandSettlementRecord(
  value: RunnerAdapterCommandSettlementRecord,
): RunnerAdapterCommandSettlementRecord {
  exactKeys(value, [
    "commandId", "commandFingerprint", "outcome", "outcomeSha256", "settledAt",
  ], "Runner adapter command settlement record");
  const normalized = normalizeRunnerAdapterCommandSettlement({
    commandId: value.commandId,
    commandFingerprint: value.commandFingerprint,
    outcome: value.outcome,
  });
  const outcomeSha256 = patternText(
    value.outcomeSha256,
    "Runner adapter command outcome fingerprint",
    FINGERPRINT_PATTERN,
    71,
  );
  if (outcomeSha256 !== runnerAdapterCommandOutcomeSha256(normalized.outcome)) {
    throw new RangeError("Runner adapter command outcome fingerprint changed");
  }
  const settledAt = canonicalTimestamp(value.settledAt, "Runner adapter command settlement time");
  return Object.freeze({ ...normalized, outcomeSha256, settledAt });
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
}

function patternText(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum: number,
): string {
  const normalized = boundedText(value, label, maximum);
  if (!pattern.test(normalized)) throw new RangeError(`${label} is invalid`);
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  const integer = positiveInteger(value, label);
  if (integer > maximum) throw new RangeError(`${label} must not exceed ${maximum}`);
  return integer;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : boundedText(value, label, maximum);
}

function nullableFingerprint(value: unknown, label: string): string | null {
  return value === null
    ? null
    : patternText(value, label, FINGERPRINT_PATTERN, 71);
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new RangeError(`${label} has unexpected fields`);
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = boundedText(value, label, 40);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new RangeError(`${label} is invalid`);
  }
  return timestamp;
}
