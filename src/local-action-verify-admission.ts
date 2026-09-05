import {
  GLAEDA_VERIFY_FOCUSED_PROFILE_V1,
  GLAEDA_VERIFY_REQUIRED_PROFILE_V1,
  fingerprintGlaedaVerificationRequestV1,
  type GlaedaVerificationProfileContractV1,
  type GlaedaVerificationRequestV1,
} from "./glaeda-verify-focused-workstation-client.js";
import {
  compileLocalActionIntentV1,
  type LocalActionIntentV1,
} from "./local-action-intent.js";
import {
  normalizeGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCommandV1,
  type GlaedaWorkstationNodeV1,
} from "./glaeda-workstation-contracts.js";
import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import { sha256Hex } from "./sha256.js";

export const LOCAL_ACTION_VERIFY_ADMISSION_V1 = 1 as const;

export interface LocalActionVerifyAdmissionSourceV1 {
  repository: string;
  commitOid: string;
  treeOid: string;
  workspaceGeneration: string | null;
}

export interface LocalActionVerifyAdmissionCurrentV1 {
  project: string;
  itemId: string;
  itemClaimGeneration: number;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  authority: { holderId: string; expiresAt: string };
  node: GlaedaWorkstationNodeV1;
  source: LocalActionVerifyAdmissionSourceV1;
  profileGeneration: string;
}

export interface CompileLocalActionVerifyCommandInputV1 {
  intent: unknown;
  current: unknown;
  now?: Date;
}

/**
 * Compile one current `verify` local-action intent into one Glaeda workstation
 * command for the existing reservation/execution/receipt/settlement path.
 *
 * This is the `verify` slice of Stensibly #1834: it removes the manual
 * translation from an admitted intent (profileId, source commit/tree, budgets)
 * into a `GlaedaWorkstationCommandV1` whose profile-request digest the physical
 * verify client already enforces. It creates no queue, ledger, scheduler, or
 * shell API; dispatch, reservation, replay, and settlement stay with
 * `GlaedaWorkstationAdapterV1`.
 *
 * Freshness model: the caller supplies dispatch-time current facts. A stale
 * claim/run/lease/source generation compiles to a command whose identity no
 * longer matches the durable reservation, so the adapter refuses or replays
 * instead of executing twice. Exact replay (same intent + same current facts)
 * compiles to the identical command identity.
 */
export function compileLocalActionVerifyCommandV1(
  raw: CompileLocalActionVerifyCommandInputV1,
): GlaedaWorkstationCommandV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RangeError("Local verify admission requires an object");
  }
  const intent = compileLocalActionIntentV1(raw.intent);
  const current = normalizeCurrent(raw.current);
  const now = raw.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("Local verify admission clock is invalid");
  }

  if (intent.actionClass !== "verify") {
    throw new RangeError(
      "Local verify admission accepts only verify intents; command, repo_query and develop use their own adapters",
    );
  }
  const profile = selectProfile(intent);
  admitPolicy(intent, profile);
  admitFreshness(intent, current, now.getTime());
  admitIdentity(intent, current);

  const request: GlaedaVerificationRequestV1 = {
    version: 1,
    repository: intent.source.repository,
    commitOid: current.source.commitOid,
    treeOid: current.source.treeOid,
    profileVersionSha256: current.profileGeneration,
    resourceClass: profile.resourceClass,
    deadlineSeconds: profile.deadlineSeconds,
    executionIdentityClass: "credentialless_project",
  };
  const requestSha256 = fingerprintGlaedaVerificationRequestV1(request, profile);
  const identity = sha256Hex(
    canonicalJsonString({
      kind: "local-action-verify-command/v1",
      intentFingerprint: intent.fingerprint,
      runId: current.runId,
      runGeneration: current.runGeneration,
      leaseGeneration: current.leaseGeneration,
      node: current.node,
      profileId: profile.id,
      profileGeneration: current.profileGeneration,
      requestSha256,
    }),
  ).slice(0, 48);

  return normalizeGlaedaWorkstationCommandV1({
    version: 1,
    project: current.project,
    itemId: current.itemId,
    itemClaimGeneration: current.itemClaimGeneration,
    runId: current.runId,
    runGeneration: current.runGeneration,
    leaseGeneration: current.leaseGeneration,
    authority: {
      holderId: current.authority.holderId,
      expiresAt: current.authority.expiresAt,
    },
    commandId: `verify-${identity}`,
    idempotencyKey: `local-action-verify:${identity}`,
    node: current.node,
    source: {
      // Canonical lowercase intent repository so the physical request digest
      // and the command source stay byte-identical for client admission.
      repository: intent.source.repository,
      commitOid: current.source.commitOid,
      treeOid: current.source.treeOid,
      logicalChangeRef: null,
    },
    profile: {
      id: profile.id,
      versionSha256: current.profileGeneration,
      class: profile.class,
      resourceClass: profile.resourceClass,
      deadlineSeconds: profile.deadlineSeconds,
    },
    profileRequestSha256: requestSha256,
  });
}

function selectProfile(intent: LocalActionIntentV1): GlaedaVerificationProfileContractV1 {
  if (intent.profileId === GLAEDA_VERIFY_FOCUSED_PROFILE_V1.id) {
    return GLAEDA_VERIFY_FOCUSED_PROFILE_V1;
  }
  if (intent.profileId === GLAEDA_VERIFY_REQUIRED_PROFILE_V1.id) {
    return GLAEDA_VERIFY_REQUIRED_PROFILE_V1;
  }
  throw new RangeError(
    "Local verify admission refused: unsupported-policy profile; use a reviewed verify-focused/v1 or verify-required/v1 profile",
  );
}

function admitPolicy(
  intent: LocalActionIntentV1,
  profile: GlaedaVerificationProfileContractV1,
): void {
  if (intent.interferenceClass === "quiet_required") {
    throw new RangeError(
      "Local verify admission refused: unsupported-policy interference; quiet_required needs a wired quiet-lease admission",
    );
  }
  if (intent.latencyClass === "measurement") {
    throw new RangeError(
      "Local verify admission refused: unsupported-policy latency; measurement needs a reviewed measurement profile",
    );
  }
  if (intent.resourceProfile !== profile.resourceClass) {
    throw new RangeError(
      "Local verify admission refused: unsupported-policy resource; the named verification profile fixes its own resource class",
    );
  }
  if (intent.source.overlay !== null) {
    throw new RangeError(
      "Local verify admission refused: verify cannot carry an overlay artifact; overlays compose with command/develop workspaces",
    );
  }
  if (intent.deadlineSeconds < profile.deadlineSeconds) {
    throw new RangeError(
      "Local verify admission refused: intent deadline cannot be narrower than the named profile worst-case deadline",
    );
  }
}

function admitFreshness(
  intent: LocalActionIntentV1,
  current: LocalActionVerifyAdmissionCurrentV1,
  nowMilliseconds: number,
): void {
  if (Date.parse(intent.expiresAt) <= nowMilliseconds) {
    throw new RangeError("Local verify admission refused: intent is expired");
  }
  if (Date.parse(current.authority.expiresAt) <= nowMilliseconds) {
    throw new RangeError("Local verify admission refused: authority lease is expired");
  }
  if (intent.itemId !== current.itemId) {
    throw new RangeError("Local verify admission refused: intent item changed");
  }
  if (intent.expectedClaimGeneration !== current.itemClaimGeneration) {
    throw new RangeError("Local verify admission refused: stale item claim generation");
  }
  if (intent.project !== current.project) {
    throw new RangeError("Local verify admission refused: intent project changed");
  }
}

function admitIdentity(
  intent: LocalActionIntentV1,
  current: LocalActionVerifyAdmissionCurrentV1,
): void {
  if (intent.source.repository !== current.source.repository.toLowerCase()) {
    throw new RangeError("Local verify admission refused: source repository changed");
  }
  if (
    intent.source.baseCommit !== current.source.commitOid
    || intent.source.baseTree !== current.source.treeOid
  ) {
    throw new RangeError("Local verify admission refused: source commit/tree changed");
  }
  const intentWorkspace = intent.source.workspaceGeneration ?? null;
  if (intentWorkspace !== current.source.workspaceGeneration) {
    throw new RangeError("Local verify admission refused: task workspace generation changed");
  }
}

function normalizeCurrent(value: unknown): LocalActionVerifyAdmissionCurrentV1 {
  const input = exactRecord(value, "Local verify admission current facts", [
    "project",
    "itemId",
    "itemClaimGeneration",
    "runId",
    "runGeneration",
    "leaseGeneration",
    "authority",
    "node",
    "source",
    "profileGeneration",
  ]);
  const authority = exactRecord(input.authority, "Local verify admission authority", [
    "holderId",
    "expiresAt",
  ]);
  if (typeof authority.holderId !== "string" || authority.holderId.trim().length === 0) {
    throw new RangeError("Local verify admission authority holder is invalid");
  }
  if (
    typeof authority.expiresAt !== "string"
    || !Number.isFinite(Date.parse(authority.expiresAt))
  ) {
    throw new RangeError("Local verify admission authority expiry is invalid");
  }
  const source = exactRecord(input.source, "Local verify admission source", [
    "repository",
    "commitOid",
    "treeOid",
    "workspaceGeneration",
  ]);
  if (typeof source.repository !== "string" || source.repository.trim().length === 0) {
    throw new RangeError("Local verify admission source repository is invalid");
  }
  if (
    typeof source.workspaceGeneration !== "string"
    && source.workspaceGeneration !== null
  ) {
    throw new RangeError("Local verify admission workspace generation is invalid");
  }
  const node = input.node;
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new RangeError("Local verify admission node is invalid");
  }
  return deepFreeze({
    project: text(input.project, "Local verify admission project"),
    itemId: text(input.itemId, "Local verify admission item ID"),
    itemClaimGeneration: nonNegativeInteger(
      input.itemClaimGeneration,
      "Local verify admission item claim generation",
    ),
    runId: text(input.runId, "Local verify admission run ID"),
    runGeneration: positiveInteger(
      input.runGeneration,
      "Local verify admission run generation",
    ),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Local verify admission lease generation",
    ),
    authority: {
      holderId: (authority.holderId as string).trim(),
      expiresAt: authority.expiresAt as string,
    },
    node: node as GlaedaWorkstationNodeV1,
    source: {
      repository: (source.repository as string).trim(),
      commitOid: text(source.commitOid, "Local verify admission commit OID"),
      treeOid: text(source.treeOid, "Local verify admission tree OID"),
      workspaceGeneration: source.workspaceGeneration as string | null,
    },
    profileGeneration: text(input.profileGeneration, "Local verify admission profile generation"),
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

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(`${label} is invalid`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)) {
    throw new RangeError(`${label} is invalid`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return Number(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
