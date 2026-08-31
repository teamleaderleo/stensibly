import type {
  ReserveRunnerAdapterCommandInput,
  RunnerAdapterCommandOutcomeV1,
  RunnerAdapterCommandReservation,
  RunnerAdapterCommandSettlementRecord,
} from "./runner-adapter-command-contracts.js";

/**
 * Exact live authority shared by workstation adapters. The runner command
 * ledger remains the sole command/replay owner; this envelope only adds the
 * item-claim fence that the generic runner reservation does not carry.
 */
export interface WorkstationCommandAuthorityV1 {
  holderId: string;
  expiresAt: string;
}

export interface WorkstationCommandReservationInputV1 {
  itemClaimGeneration: number;
  authority: WorkstationCommandAuthorityV1;
  reservation: ReserveRunnerAdapterCommandInput;
}

export interface WorkstationCommandLedgerV1 {
  reserveWorkstationCommand(
    input: WorkstationCommandReservationInputV1,
  ): Promise<RunnerAdapterCommandReservation>;
  settleRunnerAdapterCommand(input: {
    commandId: string;
    commandFingerprint: string;
    outcome: RunnerAdapterCommandOutcomeV1;
  }): Promise<{
    outcome: "settled" | "replayed";
    settlement: RunnerAdapterCommandSettlementRecord;
  }>;
}
