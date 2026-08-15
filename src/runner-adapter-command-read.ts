import {
  admitRunnerAdapterCommandSettlementRecord,
  normalizeRunnerAdapterCommandReservation,
  type ReserveRunnerAdapterCommandInput,
  type RunnerAdapterCommandReservationRecord,
  type RunnerAdapterCommandSettlementRecord,
} from "./runner-adapter-command-contracts.js";

export interface GetRunnerAdapterCommandInput {
  idempotencyKey: string;
}

export interface RunnerAdapterCommandReadResult {
  command: RunnerAdapterCommandReservationRecord;
  settlement: RunnerAdapterCommandSettlementRecord | null;
}

export interface RunnerAdapterCommandReadLedger {
  getRunnerAdapterCommand(
    input: GetRunnerAdapterCommandInput,
  ): Promise<RunnerAdapterCommandReadResult | null>;
}

export function normalizeRunnerAdapterCommandReadInput(
  input: GetRunnerAdapterCommandInput,
): GetRunnerAdapterCommandInput {
  return Object.freeze({
    idempotencyKey: boundedText(
      input.idempotencyKey,
      "Runner adapter command idempotency key",
      240,
    ),
  });
}

export function admitRunnerAdapterCommandReadResult(input: {
  request: unknown;
  reservedAt: unknown;
  settlement: unknown;
}): RunnerAdapterCommandReadResult {
  const request = normalizeRunnerAdapterCommandReservation(
    input.request as ReserveRunnerAdapterCommandInput,
  );
  const command: RunnerAdapterCommandReservationRecord = Object.freeze({
    ...request,
    actor: Object.freeze({ ...request.actor }),
    reservedAt: canonicalTimestamp(
      input.reservedAt,
      "Runner adapter command reservation time",
    ),
  });
  const settlement = input.settlement === null
    ? null
    : admitRunnerAdapterCommandSettlementRecord(
      input.settlement as RunnerAdapterCommandSettlementRecord,
    );
  if (
    settlement !== null
    && (
      settlement.commandId !== command.commandId
      || settlement.commandFingerprint !== command.commandFingerprint
    )
  ) {
    throw new RangeError("Runner adapter command settlement changed command identity");
  }
  return Object.freeze({ command, settlement });
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = boundedText(value, label, 40);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new RangeError(`${label} is invalid`);
  }
  return timestamp;
}
