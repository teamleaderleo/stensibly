import {
  admitRunnerAdapterCommandReservationRecord,
  admitRunnerAdapterCommandSettlementRecord,
  type RunnerAdapterCommandLookup,
  type RunnerAdapterCommandReservationRecord,
  type RunnerAdapterCommandSettlementRecord,
} from "./runner-adapter-command-contracts.js";

/**
 * Re-admit one durable command read as a coherent reservation/settlement pair.
 * Storage backends may persist the two records separately, but callers should
 * never observe a settlement for another command identity.
 */
export function admitRunnerAdapterCommandLookup(input: {
  command: unknown;
  settlement: unknown;
}): RunnerAdapterCommandLookup {
  const command = admitRunnerAdapterCommandReservationRecord(
    input.command as RunnerAdapterCommandReservationRecord,
  );
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
