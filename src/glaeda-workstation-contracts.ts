import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import { sha256Hex } from "./sha256.js";

export const GLAEDA_WORKSTATION_CONTRACT_V1 = 1 as const;
export const GLAEDA_WORKSTATION_CHECK_SCHEMA = "glaeda-workstation-check/v1" as const;
export const GLAEDA_WORKSTATION_RECEIPT_SCHEMA = "glaeda-workstation-receipt/v1" as const;

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\/v[1-9][0-9]{0,5}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type GlaedaWorkstationProfileClassV1 =
  | "repo_query"
  | "verify_focused"
  | "verify_required"
  | "history_bisect";

export type GlaedaWorkstationOsClassV1 = "linux" | "macos";
export type GlaedaWorkstationArchitectureV1 = "x86_64" | "arm64";
export type GlaedaExecutionIdentityClassV1 =
  | "read_only_repository"
  | "credentialless_project";
export type GlaedaWorkstationTerminalClassV1 =
  | "succeeded"
  | "failed"
  | "refused"
  | "timed_out"
  | "cleanup_incomplete";

export interface GlaedaWorkstationAuthorityV1 {
  holderId: string;
  expiresAt: string;
}

export interface GlaedaWorkstationNodeV1 {
  id: string;
  generation: number;
  capabilitySnapshotSha256: string;
  osClass: GlaedaWorkstationOsClassV1;
  architectureClass: GlaedaWorkstationArchitectureV1;
  glaedaRuntimeSha256: string;
}

export interface GlaedaWorkstationSourceV1 {
  repository: string;
  commitOid: string;
  treeOid: string;
  logicalChangeRef: string | null;
}

export interface GlaedaWorkstationProfileV1 {
  id: string;
  versionSha256: string;
  class: GlaedaWorkstationProfileClassV1;
  resourceClass: string;
  deadlineSeconds: number;
}

export interface GlaedaWorkstationCommandV1 {
  version: typeof GLAEDA_WORKSTATION_CONTRACT_V1;
  project: string;
  itemId: string;
  itemClaimGeneration: number;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  authority: GlaedaWorkstationAuthorityV1;
  commandId: string;
  idempotencyKey: string;
  node: GlaedaWorkstationNodeV1;
  source: GlaedaWorkstationSourceV1;
  profile: GlaedaWorkstationProfileV1;
  /** Exact digest of the profile-specific request consumed by the physical adapter. */
  profileRequestSha256: string;
}

export interface GlaedaWorkstationCheckV1 {
  schema: typeof GLAEDA_WORKSTATION_CHECK_SCHEMA;
  commandFingerprint: string;
  node: GlaedaWorkstationNodeV1;
  source: Omit<GlaedaWorkstationSourceV1, "logicalChangeRef">;
  profile: Pick<GlaedaWorkstationProfileV1, "id" | "versionSha256" | "class">;
  executionIdentityClass: GlaedaExecutionIdentityClassV1;
  supported: true;
  rawContentEmitted: false;
  authorizesWork: false;
  authorizesEffects: false;
}

export interface GlaedaWorkstationReceiptV1 {
  schema: typeof GLAEDA_WORKSTATION_RECEIPT_SCHEMA;
  commandFingerprint: string;
  node: GlaedaWorkstationNodeV1;
  source: Omit<GlaedaWorkstationSourceV1, "logicalChangeRef">;
  profile: Pick<GlaedaWorkstationProfileV1, "id" | "versionSha256" | "class">;
  executionIdentityClass: GlaedaExecutionIdentityClassV1;
  terminalClass: GlaedaWorkstationTerminalClassV1;
  resultSha256: string;
  resultBytes: number;
  startedAt: string;
  settledAt: string;
  rawContentEmitted: false;
  containsPrivateContent: false;
  containsCredentials: false;
  authorizesWork: false;
  authorizesEffects: false;
  authorizesRedispatch: false;
}

export function normalizeGlaedaWorkstationCommandV1(
  value: unknown,
): GlaedaWorkstationCommandV1 {
  const input = exactRecord(value, "Glaeda workstation command", [
    "version",
    "project",
    "itemId",
    "itemClaimGeneration",
    "runId",
    "runGeneration",
    "leaseGeneration",
    "authority",
    "commandId",
    "idempotencyKey",
    "node",
    "source",
    "profile",
    "profileRequestSha256",
  ]);
  if (input.version !== GLAEDA_WORKSTATION_CONTRACT_V1) {
    throw new RangeError("Glaeda workstation command version is invalid");
  }
  const authority = normalizeAuthority(input.authority);
  const node = normalizeNode(input.node);
  const source = normalizeSource(input.source);
  const profile = normalizeProfile(input.profile);
  return deepFreeze({
    version: GLAEDA_WORKSTATION_CONTRACT_V1,
    project: patternText(input.project, "Glaeda workstation project", PROJECT_PATTERN, 80),
    itemId: boundedText(input.itemId, "Glaeda workstation item ID", 240),
    itemClaimGeneration: nonNegativeInteger(
      input.itemClaimGeneration,
      "Glaeda workstation item claim generation",
    ),
    runId: boundedText(input.runId, "Glaeda workstation run ID", 240),
    runGeneration: positiveInteger(input.runGeneration, "Glaeda workstation run generation"),
    leaseGeneration: positiveInteger(input.leaseGeneration, "Glaeda workstation lease generation"),
    authority,
    commandId: boundedText(input.commandId, "Glaeda workstation command ID", 160),
    idempotencyKey: boundedText(input.idempotencyKey, "Glaeda workstation idempotency key", 240),
    node,
    source,
    profile,
    profileRequestSha256: sha256(
      input.profileRequestSha256,
      "Glaeda workstation profile request digest",
    ),
  });
}

export function fingerprintGlaedaWorkstationCommandV1(value: unknown): string {
  return digest(normalizeGlaedaWorkstationCommandV1(value));
}

export function admitGlaedaWorkstationCheckV1(value: unknown): GlaedaWorkstationCheckV1 {
  const input = exactRecord(value, "Glaeda workstation check", [
    "schema",
    "commandFingerprint",
    "node",
    "source",
    "profile",
    "executionIdentityClass",
    "supported",
    "rawContentEmitted",
    "authorizesWork",
    "authorizesEffects",
  ]);
  if (input.schema !== GLAEDA_WORKSTATION_CHECK_SCHEMA) {
    throw new RangeError("Glaeda workstation check schema is invalid");
  }
  if (
    input.supported !== true
    || input.rawContentEmitted !== false
    || input.authorizesWork !== false
    || input.authorizesEffects !== false
  ) {
    throw new RangeError("Glaeda workstation check authority boundary is invalid");
  }
  const profile = normalizeReceiptProfile(input.profile);
  const executionIdentityClass = executionIdentity(input.executionIdentityClass);
  assertProfileExecutionIdentity(profile.class, executionIdentityClass);
  return deepFreeze({
    schema: GLAEDA_WORKSTATION_CHECK_SCHEMA,
    commandFingerprint: sha256(input.commandFingerprint, "Glaeda workstation command fingerprint"),
    node: normalizeNode(input.node),
    source: normalizeReceiptSource(input.source),
    profile,
    executionIdentityClass,
    supported: true,
    rawContentEmitted: false,
    authorizesWork: false,
    authorizesEffects: false,
  });
}

export function admitGlaedaWorkstationReceiptV1(value: unknown): GlaedaWorkstationReceiptV1 {
  const input = exactRecord(value, "Glaeda workstation receipt", [
    "schema",
    "commandFingerprint",
    "node",
    "source",
    "profile",
    "executionIdentityClass",
    "terminalClass",
    "resultSha256",
    "resultBytes",
    "startedAt",
    "settledAt",
    "rawContentEmitted",
    "containsPrivateContent",
    "containsCredentials",
    "authorizesWork",
    "authorizesEffects",
    "authorizesRedispatch",
  ]);
  if (input.schema !== GLAEDA_WORKSTATION_RECEIPT_SCHEMA) {
    throw new RangeError("Glaeda workstation receipt schema is invalid");
  }
  if (
    input.rawContentEmitted !== false
    || input.containsPrivateContent !== false
    || input.containsCredentials !== false
    || input.authorizesWork !== false
    || input.authorizesEffects !== false
    || input.authorizesRedispatch !== false
  ) {
    throw new RangeError("Glaeda workstation receipt authority/content boundary is invalid");
  }
  const profile = normalizeReceiptProfile(input.profile);
  const executionIdentityClass = executionIdentity(input.executionIdentityClass);
  assertProfileExecutionIdentity(profile.class, executionIdentityClass);
  const startedAt = canonicalTimestamp(input.startedAt, "Glaeda workstation startedAt");
  const settledAt = canonicalTimestamp(input.settledAt, "Glaeda workstation settledAt");
  if (Date.parse(settledAt) < Date.parse(startedAt)) {
    throw new RangeError("Glaeda workstation receipt settled before it started");
  }
  return deepFreeze({
    schema: GLAEDA_WORKSTATION_RECEIPT_SCHEMA,
    commandFingerprint: sha256(input.commandFingerprint, "Glaeda workstation command fingerprint"),
    node: normalizeNode(input.node),
    source: normalizeReceiptSource(input.source),
    profile,
    executionIdentityClass,
    terminalClass: terminalClass(input.terminalClass),
    resultSha256: sha256(input.resultSha256, "Glaeda workstation result digest"),
    resultBytes: boundedInteger(input.resultBytes, 0, 1_000_000, "Glaeda workstation result bytes"),
    startedAt,
    settledAt,
    rawContentEmitted: false,
    containsPrivateContent: false,
    containsCredentials: false,
    authorizesWork: false,
    authorizesEffects: false,
    authorizesRedispatch: false,
  });
}

export function assertGlaedaWorkstationCheckMatchesCommandV1(
  rawCommand: unknown,
  rawCheck: unknown,
): void {
  const command = normalizeGlaedaWorkstationCommandV1(rawCommand);
  const check = admitGlaedaWorkstationCheckV1(rawCheck);
  const expectedFingerprint = digest(command);
  if (
    check.commandFingerprint !== expectedFingerprint
    || !sameNode(command.node, check.node)
    || !sameSource(command.source, check.source)
    || !sameProfile(command.profile, check.profile)
  ) {
    throw new RangeError("Glaeda workstation check does not match the exact command");
  }
}

export function assertGlaedaWorkstationReceiptMatchesCommandV1(
  rawCommand: unknown,
  rawCheck: unknown,
  rawReceipt: unknown,
): void {
  const command = normalizeGlaedaWorkstationCommandV1(rawCommand);
  const check = admitGlaedaWorkstationCheckV1(rawCheck);
  const receipt = admitGlaedaWorkstationReceiptV1(rawReceipt);
  assertGlaedaWorkstationCheckMatchesCommandV1(command, check);
  if (
    receipt.commandFingerprint !== check.commandFingerprint
    || !sameNode(receipt.node, check.node)
    || !sameSource(receipt.source, check.source)
    || !sameProfile(receipt.profile, check.profile)
    || receipt.executionIdentityClass !== check.executionIdentityClass
  ) {
    throw new RangeError("Glaeda workstation receipt does not match the exact checked command");
  }
}

function normalizeAuthority(value: unknown): GlaedaWorkstationAuthorityV1 {
  const input = exactRecord(value, "Glaeda workstation authority", ["holderId", "expiresAt"]);
  return deepFreeze({
    holderId: boundedText(input.holderId, "Glaeda workstation authority holder", 240),
    expiresAt: canonicalTimestamp(input.expiresAt, "Glaeda workstation authority expiry"),
  });
}

function normalizeNode(value: unknown): GlaedaWorkstationNodeV1 {
  const input = exactRecord(value, "Glaeda workstation node", [
    "id",
    "generation",
    "capabilitySnapshotSha256",
    "osClass",
    "architectureClass",
    "glaedaRuntimeSha256",
  ]);
  return deepFreeze({
    id: patternText(input.id, "Glaeda workstation node ID", SAFE_ID_PATTERN, 128),
    generation: positiveInteger(input.generation, "Glaeda workstation node generation"),
    capabilitySnapshotSha256: sha256(
      input.capabilitySnapshotSha256,
      "Glaeda workstation capability snapshot digest",
    ),
    osClass: osClass(input.osClass),
    architectureClass: architectureClass(input.architectureClass),
    glaedaRuntimeSha256: sha256(input.glaedaRuntimeSha256, "Glaeda runtime digest"),
  });
}

function normalizeSource(value: unknown): GlaedaWorkstationSourceV1 {
  const input = exactRecord(value, "Glaeda workstation source", [
    "repository",
    "commitOid",
    "treeOid",
    "logicalChangeRef",
  ]);
  const source = normalizeSourceCore(input);
  return deepFreeze({
    ...source,
    logicalChangeRef: input.logicalChangeRef === null
      ? null
      : boundedText(input.logicalChangeRef, "Glaeda logical change reference", 240),
  });
}

function normalizeReceiptSource(
  value: unknown,
): Omit<GlaedaWorkstationSourceV1, "logicalChangeRef"> {
  const input = exactRecord(value, "Glaeda workstation receipt source", [
    "repository",
    "commitOid",
    "treeOid",
  ]);
  return deepFreeze(normalizeSourceCore(input));
}

function normalizeSourceCore(input: Record<string, unknown>) {
  const commitOid = gitOid(input.commitOid, "Glaeda source commit OID");
  const treeOid = gitOid(input.treeOid, "Glaeda source tree OID");
  if (commitOid.length !== treeOid.length) {
    throw new RangeError("Glaeda source commit/tree object formats do not match");
  }
  return {
    repository: patternText(
      input.repository,
      "Glaeda source repository",
      REPOSITORY_PATTERN,
      200,
    ),
    commitOid,
    treeOid,
  };
}

function normalizeProfile(value: unknown): GlaedaWorkstationProfileV1 {
  const input = exactRecord(value, "Glaeda workstation profile", [
    "id",
    "versionSha256",
    "class",
    "resourceClass",
    "deadlineSeconds",
  ]);
  return deepFreeze({
    id: patternText(input.id, "Glaeda workstation profile ID", PROFILE_ID_PATTERN, 72),
    versionSha256: sha256(input.versionSha256, "Glaeda workstation profile version"),
    class: profileClass(input.class),
    resourceClass: patternText(
      input.resourceClass,
      "Glaeda workstation resource class",
      SAFE_ID_PATTERN,
      128,
    ),
    deadlineSeconds: boundedInteger(
      input.deadlineSeconds,
      1,
      604_800,
      "Glaeda workstation deadline seconds",
    ),
  });
}

function normalizeReceiptProfile(
  value: unknown,
): Pick<GlaedaWorkstationProfileV1, "id" | "versionSha256" | "class"> {
  const input = exactRecord(value, "Glaeda workstation receipt profile", [
    "id",
    "versionSha256",
    "class",
  ]);
  return deepFreeze({
    id: patternText(input.id, "Glaeda workstation profile ID", PROFILE_ID_PATTERN, 72),
    versionSha256: sha256(input.versionSha256, "Glaeda workstation profile version"),
    class: profileClass(input.class),
  });
}

function profileClass(value: unknown): GlaedaWorkstationProfileClassV1 {
  if (
    value !== "repo_query"
    && value !== "verify_focused"
    && value !== "verify_required"
    && value !== "history_bisect"
  ) {
    throw new RangeError("Glaeda workstation profile class is invalid");
  }
  return value;
}

function osClass(value: unknown): GlaedaWorkstationOsClassV1 {
  if (value !== "linux" && value !== "macos") {
    throw new RangeError("Glaeda workstation OS class is invalid");
  }
  return value;
}

function architectureClass(value: unknown): GlaedaWorkstationArchitectureV1 {
  if (value !== "x86_64" && value !== "arm64") {
    throw new RangeError("Glaeda workstation architecture class is invalid");
  }
  return value;
}

function executionIdentity(value: unknown): GlaedaExecutionIdentityClassV1 {
  if (value !== "read_only_repository" && value !== "credentialless_project") {
    throw new RangeError("Glaeda workstation execution identity class is invalid");
  }
  return value;
}

function assertProfileExecutionIdentity(
  profile: GlaedaWorkstationProfileClassV1,
  identity: GlaedaExecutionIdentityClassV1,
): void {
  const expected = profile === "repo_query" ? "read_only_repository" : "credentialless_project";
  if (identity !== expected) {
    throw new RangeError("Glaeda workstation profile uses the wrong execution identity class");
  }
}

function terminalClass(value: unknown): GlaedaWorkstationTerminalClassV1 {
  if (
    value !== "succeeded"
    && value !== "failed"
    && value !== "refused"
    && value !== "timed_out"
    && value !== "cleanup_incomplete"
  ) {
    throw new RangeError("Glaeda workstation terminal class is invalid");
  }
  return value;
}

function sameNode(left: GlaedaWorkstationNodeV1, right: GlaedaWorkstationNodeV1): boolean {
  return canonicalJsonString(left) === canonicalJsonString(right);
}

function sameSource(
  left: Pick<GlaedaWorkstationSourceV1, "repository" | "commitOid" | "treeOid">,
  right: Pick<GlaedaWorkstationSourceV1, "repository" | "commitOid" | "treeOid">,
): boolean {
  return left.repository === right.repository
    && left.commitOid === right.commitOid
    && left.treeOid === right.treeOid;
}

function sameProfile(
  left: Pick<GlaedaWorkstationProfileV1, "id" | "versionSha256" | "class">,
  right: Pick<GlaedaWorkstationProfileV1, "id" | "versionSha256" | "class">,
): boolean {
  return left.id === right.id
    && left.versionSha256 === right.versionSha256
    && left.class === right.class;
}

function digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJsonString(value))}`;
}

function sha256(value: unknown, label: string): string {
  return patternText(value, label, SHA256_PATTERN, 71);
}

function gitOid(value: unknown, label: string): string {
  return patternText(value, label, GIT_OID_PATTERN, 64);
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

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.length > maximum
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function patternText(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum: number,
): string {
  const output = boundedText(value, label, maximum);
  if (!pattern.test(output)) throw new RangeError(`${label} is invalid`);
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

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
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
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
