import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  admitRunnerAdapterCommandSettlementRecord,
  RunnerAdapterCommandConflictError,
  type RunnerAdapterCommandReservation,
  type RunnerAdapterCommandSettlementRecord,
} from "./runner-adapter-command-contracts.js";
import type { ActorInput } from "./schemas.js";
import { sha256Hex } from "./sha256.js";
import type {
  WorkstationCommandAuthorityV1,
  WorkstationCommandLedgerV1,
  WorkstationCommandReservationInputV1,
} from "./workstation-command-adapter.js";

export const LAZY_WORKSTATION_ADAPTER_V1 = 1 as const;
export const LAZY_WORKSTATION_ADAPTER_ID = "lazy-commander" as const;
export const LAZY_OWNER_PROFILE_CHECK_SCHEMA = "lazy-owner-observation-check/v1" as const;
export const LAZY_OWNER_PROFILE_RECEIPT_SCHEMA = "lazy-owner-observation-receipt/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const SAFE_PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,79}$/u;

export type LazyWorkstationAuthorityV1 = WorkstationCommandAuthorityV1;

export interface LazyOwnerProfileRequestV1 {
  profileId: string;
  profileVersion: string;
  parameters: Readonly<Record<string, string>>;
}

export interface LazyOwnerProfileCheckV1 {
  schema: typeof LAZY_OWNER_PROFILE_CHECK_SCHEMA;
  profileId: string;
  profileSha256: string;
  sourceSha256: string;
  commandSha256: string;
  observationOnly: true;
  rawContentEmitted: false;
}

export interface LazyOwnerProfileReceiptV1 {
  schema: typeof LAZY_OWNER_PROFILE_RECEIPT_SCHEMA;
  profileId: string;
  profileSha256: string;
  sourceSha256: string;
  commandSha256: string;
  resultSha256: string;
  resultBytes: number;
  exitCode: 0;
  rawContentEmitted: false;
}

export interface PrepareLazyWorkstationCommandInputV1 {
  version: typeof LAZY_WORKSTATION_ADAPTER_V1;
  project: string;
  itemId: string;
  itemClaimGeneration: number;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  authority: LazyWorkstationAuthorityV1;
  commandId: string;
  idempotencyKey: string;
  profile: LazyOwnerProfileRequestV1;
}

export interface PreparedLazyWorkstationCommandV1
  extends PrepareLazyWorkstationCommandInputV1 {
  checkedProfile: LazyOwnerProfileCheckV1;
}

export type LazyWorkstationReservationInputV1 = WorkstationCommandReservationInputV1;

export interface LazyWorkstationCommandLedgerV1
  extends Omit<WorkstationCommandLedgerV1, "reserveWorkstationCommand"> {
  reserveLazyWorkstationCommand(
    input: LazyWorkstationReservationInputV1,
  ): Promise<RunnerAdapterCommandReservation>;
}

export interface LazyOwnerProfileClientV1 {
  check(input: {
    profileId: string;
    commandId: string;
    parameters: Readonly<Record<string, string>>;
  }): Promise<unknown>;
  observe(input: PreparedLazyWorkstationCommandV1): Promise<unknown>;
}

export interface LazyWorkstationTerminalReceiptV1 {
  version: typeof LAZY_WORKSTATION_ADAPTER_V1;
  kind: "lazy_workstation_terminal_receipt";
  disposition: "executed" | "settled_replay" | "ambiguous_reserved";
  project: string;
  itemId: string;
  itemClaimGeneration: number;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  authorityHolderId: string;
  authorityExpiresAt: string;
  commandId: string;
  commandFingerprint: string;
  requestFingerprint: string;
  profileId: string;
  profileVersion: string;
  profileSha256: string;
  sourceSha256: string;
  ownerObservationCommandSha256: string;
  ownerObservationReceiptSha256: string | null;
  ownerObservationResultSha256: string | null;
  settlementSha256: string | null;
  settledAt: string | null;
  rawContentEmitted: false;
  containsPrivateContent: false;
  containsCredentials: false;
  authorizesWork: false;
  authorizesEffects: false;
  authorizesRedispatch: false;
}

export class LazyWorkstationAdapterV1 {
  readonly #ledger: LazyWorkstationCommandLedgerV1;
  readonly #client: LazyOwnerProfileClientV1;
  readonly #actor: ActorInput;

  constructor(input: {
    ledger: LazyWorkstationCommandLedgerV1;
    client: LazyOwnerProfileClientV1;
    actor: ActorInput;
  }) {
    this.#ledger = input.ledger;
    this.#client = input.client;
    this.#actor = normalizeActor(input.actor);
  }

  async prepare(
    rawInput: PrepareLazyWorkstationCommandInputV1,
  ): Promise<PreparedLazyWorkstationCommandV1> {
    const input = normalizePrepareInput(rawInput);
    if (input.authority.holderId !== this.#actor.id) {
      throw new RunnerAdapterCommandConflictError(
        "Lazy workstation command authority belongs to another actor",
      );
    }
    const checkedProfile = admitOwnerProfileCheck(await this.#client.check({
      profileId: input.profile.profileId,
      commandId: input.commandId,
      parameters: input.profile.parameters,
    }));
    if (
      checkedProfile.profileId !== input.profile.profileId
      || input.profile.profileVersion !== `sha256:${checkedProfile.profileSha256}`
    ) {
      throw new RunnerAdapterCommandConflictError(
        "Checked Lazy owner profile does not match the requested durable profile version",
      );
    }
    return deepFreeze({ ...input, checkedProfile });
  }

  async dispatch(
    rawPrepared: PreparedLazyWorkstationCommandV1,
  ): Promise<LazyWorkstationTerminalReceiptV1> {
    const prepared = normalizePrepared(rawPrepared);
    if (prepared.authority.holderId !== this.#actor.id) {
      throw new RunnerAdapterCommandConflictError(
        "Lazy workstation command authority belongs to another actor",
      );
    }
    const commandFingerprint = digest(commandIdentity(prepared));
    const requestFingerprint = digest(stableRequest(prepared));
    const reservation = await this.#ledger.reserveLazyWorkstationCommand({
      itemClaimGeneration: prepared.itemClaimGeneration,
      authority: prepared.authority,
      reservation: {
        project: prepared.project,
        itemId: prepared.itemId,
        runId: prepared.runId,
        runGeneration: prepared.runGeneration,
        leaseGeneration: prepared.leaseGeneration,
        actor: this.#actor,
        adapterId: LAZY_WORKSTATION_ADAPTER_ID,
        profileId: prepared.profile.profileId,
        profileVersion: prepared.profile.profileVersion,
        requestFingerprint,
        commandId: prepared.commandId,
        commandFingerprint,
        idempotencyKey: prepared.idempotencyKey,
      },
    });
    assertReservationIdentity(reservation, prepared, commandFingerprint, requestFingerprint);
    if (!reservation.dispatchAuthorized) {
      if (reservation.settlement === null) {
        return terminalReceipt(
          "ambiguous_reserved",
          prepared,
          commandFingerprint,
          requestFingerprint,
          null,
        );
      }
      return terminalReceipt(
        "settled_replay",
        prepared,
        commandFingerprint,
        requestFingerprint,
        admitRunnerAdapterCommandSettlementRecord(reservation.settlement),
      );
    }

    const observation = admitOwnerProfileReceipt(await this.#client.observe(prepared));
    assertObservationMatchesCheck(observation, prepared.checkedProfile);
    const observationReceiptSha256 = digest(observation);
    const observationResultSha256 = `sha256:${observation.resultSha256}`;
    const settled = await this.#ledger.settleRunnerAdapterCommand({
      commandId: prepared.commandId,
      commandFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: 1,
        observationsSha256: observationReceiptSha256,
        terminalObservationId: `lazy-result:${observation.resultSha256}`,
        terminalObservationType: "lazy_owner_profile_observation",
        latestCheckpointExternalId: `lazy-result:${observation.resultSha256.slice(0, 32)}`,
        latestCheckpointSha256: observationResultSha256,
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });
    const disposition = settled.outcome === "replayed" ? "settled_replay" : "executed";
    return terminalReceipt(
      disposition,
      prepared,
      commandFingerprint,
      requestFingerprint,
      settled.settlement,
    );
  }
}

function stableRequest(value: PreparedLazyWorkstationCommandV1) {
  return {
    version: LAZY_WORKSTATION_ADAPTER_V1,
    kind: "lazy_workstation_owner_observation",
    project: value.project,
    itemId: value.itemId,
    itemClaimGeneration: value.itemClaimGeneration,
    runId: value.runId,
    runGeneration: value.runGeneration,
    leaseGeneration: value.leaseGeneration,
    authority: value.authority,
    upstreamCommandId: value.commandId,
    profile: {
      id: value.profile.profileId,
      version: value.profile.profileVersion,
      parameters: value.profile.parameters,
      checkedProfileSha256: value.checkedProfile.profileSha256,
      checkedSourceSha256: value.checkedProfile.sourceSha256,
      checkedCommandSha256: value.checkedProfile.commandSha256,
    },
    observationOnly: true,
    authorizesWork: false,
    authorizesEffects: false,
  };
}

function commandIdentity(value: PreparedLazyWorkstationCommandV1) {
  return {
    ...stableRequest(value),
    idempotencyKey: value.idempotencyKey,
    actor: value.authority.holderId,
  };
}

function assertReservationIdentity(
  reservation: RunnerAdapterCommandReservation,
  prepared: PreparedLazyWorkstationCommandV1,
  commandFingerprint: string,
  requestFingerprint: string,
): void {
  const command = reservation.command;
  if (
    command.project !== prepared.project
    || command.itemId !== prepared.itemId
    || command.runId !== prepared.runId
    || command.runGeneration !== prepared.runGeneration
    || command.leaseGeneration !== prepared.leaseGeneration
    || command.actor.id !== prepared.authority.holderId
    || command.adapterId !== LAZY_WORKSTATION_ADAPTER_ID
    || command.profileId !== prepared.profile.profileId
    || command.profileVersion !== prepared.profile.profileVersion
    || command.requestFingerprint !== requestFingerprint
    || command.commandId !== prepared.commandId
    || command.commandFingerprint !== commandFingerprint
    || command.idempotencyKey !== prepared.idempotencyKey
  ) {
    throw new RunnerAdapterCommandConflictError(
      "Lazy workstation reservation changed exact command identity",
    );
  }
}

function assertObservationMatchesCheck(
  receipt: LazyOwnerProfileReceiptV1,
  check: LazyOwnerProfileCheckV1,
): void {
  if (
    receipt.profileId !== check.profileId
    || receipt.profileSha256 !== check.profileSha256
    || receipt.sourceSha256 !== check.sourceSha256
    || receipt.commandSha256 !== check.commandSha256
  ) {
    throw new RunnerAdapterCommandConflictError(
      "Lazy owner observation drifted from its checked invocation",
    );
  }
}

function terminalReceipt(
  disposition: LazyWorkstationTerminalReceiptV1["disposition"],
  prepared: PreparedLazyWorkstationCommandV1,
  commandFingerprint: string,
  requestFingerprint: string,
  rawSettlement: RunnerAdapterCommandSettlementRecord | null,
): LazyWorkstationTerminalReceiptV1 {
  const settlement = rawSettlement === null
    ? null
    : admitRunnerAdapterCommandSettlementRecord(rawSettlement);
  if (settlement !== null) {
    if (
      settlement.commandId !== prepared.commandId
      || settlement.commandFingerprint !== commandFingerprint
      || settlement.outcome.observationCount !== 1
      || settlement.outcome.terminalObservationType !== "lazy_owner_profile_observation"
      || settlement.outcome.latestCheckpointExternalId === null
      || settlement.outcome.latestCheckpointSha256 === null
    ) {
      throw new RunnerAdapterCommandConflictError(
        "Stored Lazy workstation settlement does not match the bounded terminal contract",
      );
    }
  }
  return deepFreeze({
    version: LAZY_WORKSTATION_ADAPTER_V1,
    kind: "lazy_workstation_terminal_receipt" as const,
    disposition,
    project: prepared.project,
    itemId: prepared.itemId,
    itemClaimGeneration: prepared.itemClaimGeneration,
    runId: prepared.runId,
    runGeneration: prepared.runGeneration,
    leaseGeneration: prepared.leaseGeneration,
    authorityHolderId: prepared.authority.holderId,
    authorityExpiresAt: prepared.authority.expiresAt,
    commandId: prepared.commandId,
    commandFingerprint,
    requestFingerprint,
    profileId: prepared.profile.profileId,
    profileVersion: prepared.profile.profileVersion,
    profileSha256: prepared.checkedProfile.profileSha256,
    sourceSha256: prepared.checkedProfile.sourceSha256,
    ownerObservationCommandSha256: prepared.checkedProfile.commandSha256,
    ownerObservationReceiptSha256: settlement?.outcome.observationsSha256 ?? null,
    ownerObservationResultSha256: settlement?.outcome.latestCheckpointSha256 ?? null,
    settlementSha256: settlement?.outcomeSha256 ?? null,
    settledAt: settlement?.settledAt ?? null,
    rawContentEmitted: false as const,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
    authorizesWork: false as const,
    authorizesEffects: false as const,
    authorizesRedispatch: false as const,
  });
}

function assertBoundProfileParameters(input: PrepareLazyWorkstationCommandInputV1): void {
  const expected: Record<string, string> = {
    project: input.project,
    "item-id": input.itemId,
    "claim-generation": String(input.itemClaimGeneration),
    "run-id": input.runId,
    "run-generation": String(input.runGeneration),
    "lease-generation": String(input.leaseGeneration),
    "authority-holder": input.authority.holderId,
    "authority-expires-at": input.authority.expiresAt,
    "command-id": input.commandId,
    "profile-id": input.profile.profileId,
    "profile-version": input.profile.profileVersion,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (input.profile.parameters[name] !== value) {
      throw new RunnerAdapterCommandConflictError(
        `Lazy owner profile parameter ${name} is not bound to the exact Stensibly command`,
      );
    }
  }
}

function normalizePrepareInput(
  input: PrepareLazyWorkstationCommandInputV1,
): PrepareLazyWorkstationCommandInputV1 {
  exactKeys(input, [
    "version", "project", "itemId", "itemClaimGeneration", "runId",
    "runGeneration", "leaseGeneration", "authority", "commandId",
    "idempotencyKey", "profile",
  ], "Lazy workstation prepare input");
  if (input.version !== LAZY_WORKSTATION_ADAPTER_V1) {
    throw new RangeError("Lazy workstation adapter version is invalid");
  }
  const authority = exactRecord(input.authority, "Lazy workstation authority", [
    "holderId", "expiresAt",
  ]);
  const profile = exactRecord(input.profile, "Lazy workstation profile", [
    "profileId", "profileVersion", "parameters",
  ]);
  const profileId = patternText(
    profile.profileId,
    "Lazy owner profile ID",
    SAFE_PROFILE_PATTERN,
    80,
  );
  const profileVersion = boundedText(
    profile.profileVersion,
    "Lazy owner profile version",
    160,
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(profileVersion)) {
    throw new RangeError("Lazy owner profile version must be an exact SHA-256");
  }
  const normalized = {
    version: LAZY_WORKSTATION_ADAPTER_V1,
    project: patternText(input.project, "Lazy workstation project", SAFE_PROJECT_PATTERN, 80),
    itemId: boundedText(input.itemId, "Lazy workstation item ID", 240),
    itemClaimGeneration: nonNegativeInteger(
      input.itemClaimGeneration,
      "Lazy workstation item claim generation",
    ),
    runId: boundedText(input.runId, "Lazy workstation run ID", 240),
    runGeneration: positiveInteger(input.runGeneration, "Lazy workstation run generation"),
    leaseGeneration: positiveInteger(input.leaseGeneration, "Lazy workstation lease generation"),
    authority: {
      holderId: boundedText(authority.holderId, "Lazy workstation authority holder", 240),
      expiresAt: canonicalTimestamp(authority.expiresAt, "Lazy workstation authority expiry"),
    },
    commandId: boundedText(input.commandId, "Lazy workstation command ID", 160),
    idempotencyKey: boundedText(input.idempotencyKey, "Lazy workstation idempotency key", 240),
    profile: {
      profileId,
      profileVersion,
      parameters: normalizeParameters(profile.parameters),
    },
  } satisfies PrepareLazyWorkstationCommandInputV1;
  assertBoundProfileParameters(normalized);
  return deepFreeze(normalized);
}

function normalizePrepared(
  input: PreparedLazyWorkstationCommandV1,
): PreparedLazyWorkstationCommandV1 {
  exactKeys(input, [
    "version", "project", "itemId", "itemClaimGeneration", "runId",
    "runGeneration", "leaseGeneration", "authority", "commandId",
    "idempotencyKey", "profile", "checkedProfile",
  ], "Prepared Lazy workstation command");
  const { checkedProfile: _checkedProfile, ...prepareInput } = input;
  const normalized = normalizePrepareInput(prepareInput);
  const checkedProfile = admitOwnerProfileCheck(input.checkedProfile);
  if (
    checkedProfile.profileId !== normalized.profile.profileId
    || normalized.profile.profileVersion !== `sha256:${checkedProfile.profileSha256}`
  ) {
    throw new RunnerAdapterCommandConflictError(
      "Prepared Lazy owner profile identity changed",
    );
  }
  return deepFreeze({ ...normalized, checkedProfile });
}

export function admitOwnerProfileCheck(value: unknown): LazyOwnerProfileCheckV1 {
  const input = exactRecord(value, "Lazy owner profile check", [
    "schema", "profileId", "profileSha256", "sourceSha256", "commandSha256",
    "observationOnly", "rawContentEmitted",
  ]);
  if (
    input.schema !== LAZY_OWNER_PROFILE_CHECK_SCHEMA
    || input.observationOnly !== true
    || input.rawContentEmitted !== false
  ) {
    throw new RangeError("Lazy owner profile check authority boundary is invalid");
  }
  return deepFreeze({
    schema: LAZY_OWNER_PROFILE_CHECK_SCHEMA,
    profileId: patternText(input.profileId, "Lazy checked profile ID", SAFE_PROFILE_PATTERN, 80),
    profileSha256: rawSha256(input.profileSha256, "Lazy checked profile fingerprint"),
    sourceSha256: rawSha256(input.sourceSha256, "Lazy checked source fingerprint"),
    commandSha256: rawSha256(input.commandSha256, "Lazy checked command fingerprint"),
    observationOnly: true as const,
    rawContentEmitted: false as const,
  });
}

export function admitOwnerProfileReceipt(value: unknown): LazyOwnerProfileReceiptV1 {
  const input = exactRecord(value, "Lazy owner profile receipt", [
    "schema", "profileId", "profileSha256", "sourceSha256", "commandSha256",
    "resultSha256", "resultBytes", "exitCode", "rawContentEmitted",
  ]);
  if (
    input.schema !== LAZY_OWNER_PROFILE_RECEIPT_SCHEMA
    || input.exitCode !== 0
    || input.rawContentEmitted !== false
  ) {
    throw new RangeError("Lazy owner profile terminal receipt is invalid");
  }
  return deepFreeze({
    schema: LAZY_OWNER_PROFILE_RECEIPT_SCHEMA,
    profileId: patternText(input.profileId, "Lazy receipt profile ID", SAFE_PROFILE_PATTERN, 80),
    profileSha256: rawSha256(input.profileSha256, "Lazy receipt profile fingerprint"),
    sourceSha256: rawSha256(input.sourceSha256, "Lazy receipt source fingerprint"),
    commandSha256: rawSha256(input.commandSha256, "Lazy receipt command fingerprint"),
    resultSha256: rawSha256(input.resultSha256, "Lazy receipt result fingerprint"),
    resultBytes: boundedInteger(input.resultBytes, 1, 1_000_000, "Lazy receipt result bytes"),
    exitCode: 0 as const,
    rawContentEmitted: false as const,
  });
}

function normalizeParameters(value: unknown): Readonly<Record<string, string>> {
  const input = exactRecord(value, "Lazy owner profile parameters", Object.keys(
    (value && typeof value === "object" && !Array.isArray(value))
      ? value as Record<string, unknown>
      : {},
  ));
  const entries = Object.entries(input);
  if (entries.length > 32) throw new RangeError("Lazy owner profile parameters are too numerous");
  const output: Record<string, string> = {};
  for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!SAFE_PROFILE_PATTERN.test(key)) {
      throw new RangeError("Lazy owner profile parameter name is invalid");
    }
    output[key] = boundedText(raw, `Lazy owner profile parameter ${key}`, 4_096);
  }
  return Object.freeze(output);
}

function normalizeActor(actor: ActorInput): ActorInput {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new TypeError("Lazy workstation actor must be an object");
  }
  if (actor.kind !== "agent" && actor.kind !== "service") {
    throw new TypeError("Lazy workstation actor must be an agent or service");
  }
  return Object.freeze({
    id: boundedText(actor.id, "Lazy workstation actor ID", 240),
    name: boundedText(actor.name, "Lazy workstation actor name", 160),
    kind: actor.kind,
  });
}

function digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJsonString(value))}`;
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  exactKeys(value, keys, label);
  return value as Record<string, unknown>;
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RangeError(`${label} has unexpected fields`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() !== value || !value || value.length > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function patternText(value: unknown, label: string, pattern: RegExp, maximum: number): string {
  const output = boundedText(value, label, maximum);
  if (!pattern.test(output)) throw new RangeError(`${label} is invalid`);
  return output;
}

function rawSha256(value: unknown, label: string): string {
  const output = boundedText(value, label, 64);
  if (!SHA256_PATTERN.test(output)) throw new RangeError(`${label} is invalid`);
  return output;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const output = boundedText(value, label, 40);
  const milliseconds = Date.parse(output);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== output) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function nonNegativeInteger(value: unknown, label: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < minimum
    || value > maximum
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
