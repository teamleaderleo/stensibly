import { actorSchema, type ActorInput } from "./schemas.js";

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

export type RunnerAdapterCommandReservation =
  | {
    outcome: "reserved";
    dispatchAuthorized: true;
    command: RunnerAdapterCommandReservationRecord;
  }
  | {
    outcome: "replayed";
    dispatchAuthorized: false;
    command: RunnerAdapterCommandReservationRecord;
  };

export interface RunnerAdapterCommandLedger {
  reserveRunnerAdapterCommand(
    input: ReserveRunnerAdapterCommandInput,
  ): Promise<RunnerAdapterCommandReservation>;
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
