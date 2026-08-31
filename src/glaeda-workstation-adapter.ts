import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  admitGlaedaWorkstationCheckV1,
  admitGlaedaWorkstationReceiptV1,
  assertGlaedaWorkstationCheckMatchesCommandV1,
  assertGlaedaWorkstationReceiptMatchesCommandV1,
  fingerprintGlaedaWorkstationCommandV1,
  normalizeGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCheckV1,
  type GlaedaWorkstationCommandV1,
  type GlaedaWorkstationReceiptV1,
} from "./glaeda-workstation-contracts.js";
import {
  admitRunnerAdapterCommandSettlementRecord,
  RunnerAdapterCommandConflictError,
  type RunnerAdapterCommandReservation,
  type RunnerAdapterCommandSettlementRecord,
} from "./runner-adapter-command-contracts.js";
import { actorSchema, type ActorInput } from "./schemas.js";
import { sha256Hex } from "./sha256.js";
import type { WorkstationCommandLedgerV1 } from "./workstation-command-adapter.js";

export const GLAEDA_WORKSTATION_ADAPTER_V1 = 1 as const;
export const GLAEDA_WORKSTATION_ADAPTER_ID = "glaeda-workstation" as const;

export interface PreparedGlaedaWorkstationCommandV1 {
  command: GlaedaWorkstationCommandV1;
  check: GlaedaWorkstationCheckV1;
}

export interface GlaedaWorkstationClientV1 {
  check(command: GlaedaWorkstationCommandV1): Promise<unknown>;
  execute(input: PreparedGlaedaWorkstationCommandV1): Promise<unknown>;
}

export interface GlaedaWorkstationAdapterResultV1 {
  version: typeof GLAEDA_WORKSTATION_ADAPTER_V1;
  kind: "glaeda_workstation_adapter_result";
  disposition: "executed" | "settled_replay" | "ambiguous_reserved";
  command: GlaedaWorkstationCommandV1;
  check: GlaedaWorkstationCheckV1;
  receipt: GlaedaWorkstationReceiptV1 | null;
  requestFingerprint: string;
  commandFingerprint: string;
  receiptFingerprint: string | null;
  settlement: RunnerAdapterCommandSettlementRecord | null;
  containsPrivateContent: false;
  containsCredentials: false;
  authorizesWork: false;
  authorizesEffects: false;
  authorizesRedispatch: false;
}

export class GlaedaWorkstationAdapterV1 {
  readonly #ledger: WorkstationCommandLedgerV1;
  readonly #client: GlaedaWorkstationClientV1;
  readonly #actor: ActorInput;

  constructor(input: {
    ledger: WorkstationCommandLedgerV1;
    client: GlaedaWorkstationClientV1;
    actor: ActorInput;
  }) {
    this.#ledger = input.ledger;
    this.#client = input.client;
    this.#actor = Object.freeze(actorSchema.parse(input.actor));
  }

  async prepare(rawCommand: unknown): Promise<PreparedGlaedaWorkstationCommandV1> {
    const command = normalizeGlaedaWorkstationCommandV1(rawCommand);
    this.#assertAuthority(command);
    const check = admitGlaedaWorkstationCheckV1(await this.#client.check(command));
    assertGlaedaWorkstationCheckMatchesCommandV1(command, check);
    return deepFreeze({ command, check });
  }

  async dispatch(rawPrepared: unknown): Promise<GlaedaWorkstationAdapterResultV1> {
    const prepared = normalizePrepared(rawPrepared);
    this.#assertAuthority(prepared.command);
    const commandFingerprint = fingerprintGlaedaWorkstationCommandV1(prepared.command);
    const requestFingerprint = digest({
      version: GLAEDA_WORKSTATION_ADAPTER_V1,
      kind: "glaeda_workstation_execution",
      actor: this.#actor,
      command: prepared.command,
      check: prepared.check,
    });
    const reservation = await this.#ledger.reserveWorkstationCommand({
      itemClaimGeneration: prepared.command.itemClaimGeneration,
      authority: prepared.command.authority,
      reservation: {
        project: prepared.command.project,
        itemId: prepared.command.itemId,
        runId: prepared.command.runId,
        runGeneration: prepared.command.runGeneration,
        leaseGeneration: prepared.command.leaseGeneration,
        actor: this.#actor,
        adapterId: GLAEDA_WORKSTATION_ADAPTER_ID,
        profileId: prepared.command.profile.id,
        profileVersion: prepared.command.profile.versionSha256,
        requestFingerprint,
        commandId: prepared.command.commandId,
        commandFingerprint,
        idempotencyKey: prepared.command.idempotencyKey,
      },
    });
    assertReservationIdentity(
      reservation,
      prepared.command,
      this.#actor,
      commandFingerprint,
      requestFingerprint,
    );
    if (!reservation.dispatchAuthorized) {
      const settlement = reservation.settlement === null
        ? null
        : admitRunnerAdapterCommandSettlementRecord(reservation.settlement);
      return result(
        settlement === null ? "ambiguous_reserved" : "settled_replay",
        prepared,
        requestFingerprint,
        commandFingerprint,
        null,
        null,
        settlement,
      );
    }

    const receipt = admitGlaedaWorkstationReceiptV1(await this.#client.execute(prepared));
    assertGlaedaWorkstationReceiptMatchesCommandV1(
      prepared.command,
      prepared.check,
      receipt,
    );
    const receiptFingerprint = digest(receipt);
    const settled = await this.#ledger.settleRunnerAdapterCommand({
      commandId: prepared.command.commandId,
      commandFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: 1,
        observationsSha256: receiptFingerprint,
        terminalObservationId: `glaeda-result:${receipt.resultSha256.slice(7)}`,
        terminalObservationType: `glaeda_workstation_${receipt.terminalClass}`,
        latestCheckpointExternalId: `glaeda-result:${receipt.resultSha256}`,
        latestCheckpointSha256: receipt.resultSha256,
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });
    return result(
      settled.outcome === "replayed" ? "settled_replay" : "executed",
      prepared,
      requestFingerprint,
      commandFingerprint,
      receipt,
      receiptFingerprint,
      settled.settlement,
    );
  }

  #assertAuthority(command: GlaedaWorkstationCommandV1): void {
    if (command.authority.holderId !== this.#actor.id) {
      throw new RunnerAdapterCommandConflictError(
        "Glaeda workstation command authority belongs to another actor",
      );
    }
  }
}

function normalizePrepared(value: unknown): PreparedGlaedaWorkstationCommandV1 {
  const input = exactRecord(value, "Prepared Glaeda workstation command", ["command", "check"]);
  const command = normalizeGlaedaWorkstationCommandV1(input.command);
  const check = admitGlaedaWorkstationCheckV1(input.check);
  assertGlaedaWorkstationCheckMatchesCommandV1(command, check);
  return deepFreeze({ command, check });
}

function assertReservationIdentity(
  reservation: RunnerAdapterCommandReservation,
  command: GlaedaWorkstationCommandV1,
  actor: ActorInput,
  commandFingerprint: string,
  requestFingerprint: string,
): void {
  const stored = reservation.command;
  if (
    stored.project !== command.project
    || stored.itemId !== command.itemId
    || stored.runId !== command.runId
    || stored.runGeneration !== command.runGeneration
    || stored.leaseGeneration !== command.leaseGeneration
    || canonicalJsonString(stored.actor) !== canonicalJsonString(actor)
    || stored.adapterId !== GLAEDA_WORKSTATION_ADAPTER_ID
    || stored.profileId !== command.profile.id
    || stored.profileVersion !== command.profile.versionSha256
    || stored.requestFingerprint !== requestFingerprint
    || stored.commandId !== command.commandId
    || stored.commandFingerprint !== commandFingerprint
    || stored.idempotencyKey !== command.idempotencyKey
  ) {
    throw new RunnerAdapterCommandConflictError(
      "Glaeda workstation reservation changed exact command identity",
    );
  }
}

function result(
  disposition: GlaedaWorkstationAdapterResultV1["disposition"],
  prepared: PreparedGlaedaWorkstationCommandV1,
  requestFingerprint: string,
  commandFingerprint: string,
  receipt: GlaedaWorkstationReceiptV1 | null,
  receiptFingerprint: string | null,
  settlement: RunnerAdapterCommandSettlementRecord | null,
): GlaedaWorkstationAdapterResultV1 {
  return deepFreeze({
    version: GLAEDA_WORKSTATION_ADAPTER_V1,
    kind: "glaeda_workstation_adapter_result",
    disposition,
    command: prepared.command,
    check: prepared.check,
    receipt,
    requestFingerprint,
    commandFingerprint,
    receiptFingerprint,
    settlement,
    containsPrivateContent: false,
    containsCredentials: false,
    authorizesWork: false,
    authorizesEffects: false,
    authorizesRedispatch: false,
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length
    || actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new RangeError(`${label} has unexpected fields`);
  }
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${label} contains an accessor field`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJsonString(value))}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
