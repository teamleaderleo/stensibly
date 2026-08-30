import {
  getSqliteRunnerAdapterCommand,
  reserveSqliteRunnerAdapterCommand,
  settleSqliteRunnerAdapterCommand,
} from "./runner-adapter-command-sqlite.js";
import { RunnerAdapterCommandConflictError } from "./runner-adapter-command-contracts.js";
import {
  type LazyWorkstationCommandLedgerV1,
  type LazyWorkstationReservationInputV1,
} from "./lazy-workstation-adapter.js";
import type { StensiblyStore } from "./store.js";

interface ExactAuthorityRow {
  item_id: string;
  project_id: string;
  item_status: string;
  claim_generation: number;
  claimed_by: string | null;
  claim_expires_at: string | null;
  run_status: string;
  generation: number;
  lease_generation: number;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
}

/**
 * Adds the item claim generation missing from the generic runner command
 * reservation without creating another scheduler or replay ledger.
 */
export class SqliteLazyWorkstationCommandLedgerV1
  implements LazyWorkstationCommandLedgerV1 {
  readonly #store: StensiblyStore;
  readonly #now: () => Date;

  constructor(store: StensiblyStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  async reserveLazyWorkstationCommand(input: LazyWorkstationReservationInputV1) {
    const now = validDate(this.#now());
    const transaction = this.#store.db.transaction(() => {
      const replay = getSqliteRunnerAdapterCommand(this.#store, {
        idempotencyKey: input.reservation.idempotencyKey,
      });
      if (replay !== null) {
        // The generic ledger owns exact stable-request comparison and returns
        // the original command/settlement. A replay never reacquires authority.
        return reserveSqliteRunnerAdapterCommand(this.#store, input.reservation, now);
      }

      const current = this.#store.db.query<ExactAuthorityRow, [string]>(`
        SELECT
          work_runs.item_id,
          items.project_id,
          items.status AS item_status,
          items.claim_generation,
          items.claimed_by,
          items.claim_expires_at,
          work_runs.status AS run_status,
          work_runs.generation,
          work_runs.lease_generation,
          work_runs.lease_owner_id,
          work_runs.lease_expires_at
        FROM work_runs
        INNER JOIN items ON items.id = work_runs.item_id
        WHERE work_runs.id = ?1
      `).get(input.reservation.runId);
      requireExactAuthority(current, input, now);
      return reserveSqliteRunnerAdapterCommand(this.#store, input.reservation, now);
    });
    return transaction.immediate();
  }

  async settleRunnerAdapterCommand(input: Parameters<
    LazyWorkstationCommandLedgerV1["settleRunnerAdapterCommand"]
  >[0]) {
    return settleSqliteRunnerAdapterCommand(this.#store, input, validDate(this.#now()));
  }
}

function requireExactAuthority(
  current: ExactAuthorityRow | null,
  input: LazyWorkstationReservationInputV1,
  now: Date,
): void {
  const requested = input.reservation;
  if (!current) {
    throw new RunnerAdapterCommandConflictError("Lazy workstation run does not exist");
  }
  if (current.project_id !== requested.project || current.item_id !== requested.itemId) {
    throw new RunnerAdapterCommandConflictError(
      "Lazy workstation project or item changed before reservation",
    );
  }
  if (
    current.item_status !== "active"
    || current.claim_generation !== input.itemClaimGeneration
    || current.claimed_by !== input.authority.holderId
    || current.claim_expires_at !== input.authority.expiresAt
  ) {
    throw new RunnerAdapterCommandConflictError(
      "Lazy workstation item claim generation or authority changed before reservation",
    );
  }
  if (
    !["starting", "running", "waiting"].includes(current.run_status)
    || current.generation !== requested.runGeneration
    || current.lease_generation !== requested.leaseGeneration
    || current.lease_owner_id !== input.authority.holderId
    || current.lease_expires_at !== input.authority.expiresAt
  ) {
    throw new RunnerAdapterCommandConflictError(
      "Lazy workstation run generation or authority changed before reservation",
    );
  }
  if (Date.parse(input.authority.expiresAt) <= now.getTime()) {
    throw new RunnerAdapterCommandConflictError("Lazy workstation authority has expired");
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("Lazy workstation clock is invalid");
  }
  return new Date(value.getTime());
}
