import {
  admitRunnerAdapterCommandReservationRecord,
  admitRunnerAdapterCommandSettlementRecord,
  type RunnerAdapterCommandReservation,
  type RunnerAdapterCommandSettlement,
} from "./runner-adapter-command-contracts.js";
import { RunnerMcpHttpClient } from "./runner-mcp-http-client.js";
import type {
  WorkstationCommandLedgerV1,
  WorkstationCommandReservationInputV1,
} from "./workstation-command-adapter.js";

export class HttpWorkstationCommandLedgerV1 implements WorkstationCommandLedgerV1 {
  readonly #client: RunnerMcpHttpClient;
  readonly #settlementScope = new Map<string, { project: string; idempotencyKey: string }>();

  constructor(client: RunnerMcpHttpClient) {
    this.#client = client;
  }

  async reserveWorkstationCommand(
    input: WorkstationCommandReservationInputV1,
  ): Promise<RunnerAdapterCommandReservation> {
    const raw = await this.#client.call<RunnerAdapterCommandReservation>(
      "reserve_workstation_adapter_command",
      {
        ...input.reservation,
        itemClaimGeneration: input.itemClaimGeneration,
        authorityHolderId: input.authority.holderId,
        authorityExpiresAt: input.authority.expiresAt,
      },
    );
    const command = admitRunnerAdapterCommandReservationRecord(raw.command);
    const settlement = raw.settlement === null
      ? null
      : admitRunnerAdapterCommandSettlementRecord(raw.settlement);
    const admitted: RunnerAdapterCommandReservation = raw.outcome === "reserved"
      && raw.dispatchAuthorized === true
      && settlement === null
      ? { outcome: "reserved", dispatchAuthorized: true, command, settlement: null }
      : raw.outcome === "replayed" && raw.dispatchAuthorized === false
      ? { outcome: "replayed", dispatchAuthorized: false, command, settlement }
      : (() => { throw new Error("Runner MCP returned an invalid workstation reservation"); })();
    this.#settlementScope.set(command.commandId, {
      project: command.project,
      idempotencyKey: command.idempotencyKey,
    });
    return admitted;
  }

  async settleRunnerAdapterCommand(
    input: Parameters<WorkstationCommandLedgerV1["settleRunnerAdapterCommand"]>[0],
  ): Promise<RunnerAdapterCommandSettlement> {
    const scope = this.#settlementScope.get(input.commandId);
    if (!scope) throw new Error("Workstation settlement has no in-process reservation scope");
    const raw = await this.#client.call<RunnerAdapterCommandSettlement>(
      "settle_runner_adapter_command",
      {
        project: scope.project,
        reservationIdempotencyKey: scope.idempotencyKey,
        ...input,
      },
    );
    if (raw.outcome !== "settled" && raw.outcome !== "replayed") {
      throw new Error("Runner MCP returned an invalid workstation settlement");
    }
    return {
      outcome: raw.outcome,
      settlement: admitRunnerAdapterCommandSettlementRecord(raw.settlement),
    };
  }
}
