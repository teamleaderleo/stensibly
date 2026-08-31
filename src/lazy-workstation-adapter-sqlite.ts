import {
  type LazyWorkstationCommandLedgerV1,
  type LazyWorkstationReservationInputV1,
} from "./lazy-workstation-adapter.js";
import type { StensiblyStore } from "./store.js";
import { SqliteWorkstationCommandLedgerV1 } from "./workstation-command-adapter-sqlite.js";

/**
 * Adds the item claim generation missing from the generic runner command
 * reservation without creating another scheduler or replay ledger.
 */
export class SqliteLazyWorkstationCommandLedgerV1
  implements LazyWorkstationCommandLedgerV1 {
  readonly #ledger: SqliteWorkstationCommandLedgerV1;

  constructor(store: StensiblyStore, now: () => Date = () => new Date()) {
    this.#ledger = new SqliteWorkstationCommandLedgerV1(store, now);
  }

  async reserveLazyWorkstationCommand(input: LazyWorkstationReservationInputV1) {
    return this.#ledger.reserveWorkstationCommand(input);
  }

  async settleRunnerAdapterCommand(input: Parameters<
    LazyWorkstationCommandLedgerV1["settleRunnerAdapterCommand"]
  >[0]) {
    return this.#ledger.settleRunnerAdapterCommand(input);
  }
}
