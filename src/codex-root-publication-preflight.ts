import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const CODEX_ROOT_PUBLICATION_PREFLIGHT_V1 = 1 as const;

export type CodexRootReceiptClaimV1 =
  | "local_progress"
  | "local_blocker"
  | "delivery_ready"
  | "rereview_ready";

export type CodexRootRequiredCheckOutcomeV1 =
  | "passed"
  | "failed"
  | "unavailable"
  | "not_executed";

export interface CodexRootPublicationPreflightInputV1 {
  readonly version: typeof CODEX_ROOT_PUBLICATION_PREFLIGHT_V1;
  readonly claim: CodexRootReceiptClaimV1;
  readonly repository: string;
  readonly deltaClaimed: boolean;
  readonly headBefore: string | null;
  readonly deliveryHead: string | null;
  readonly observedChangedPaths: readonly string[];
  readonly representedChangedPaths: readonly string[];
  readonly ownerLease: {
    readonly leaseId: string;
    readonly generation: number;
    readonly repository: string;
    readonly intendedRemoteRef: string;
  };
  readonly currentOwnerLease: {
    readonly leaseId: string;
    readonly generation: number;
  };
  readonly remoteReadback: {
    readonly ref: string;
    readonly head: string | null;
    readonly deliveryHeadReachability: "reachable" | "not_reachable" | "unknown";
  };
  readonly requiredChecks: readonly {
    readonly name: string;
    readonly outcome: CodexRootRequiredCheckOutcomeV1;
  }[];
}

export type CodexRootPublicationDenialV1 =
  | "local_receipt_only"
  | "claimed_delta_without_new_head"
  | "worktree_delta_unrepresented"
  | "owner_lease_stale"
  | "remote_ref_mismatch"
  | "delivery_head_not_reachable"
  | "required_check_not_passed";

export interface CodexRootPublicationPreflightV1 {
  readonly version: typeof CODEX_ROOT_PUBLICATION_PREFLIGHT_V1;
  readonly claim: CodexRootReceiptClaimV1;
  readonly publicationEligible: boolean;
  readonly authorizesPublication: false;
  readonly denials: readonly CodexRootPublicationDenialV1[];
  readonly fingerprint: string;
}

/**
 * A deterministic evidence fence, not a publication grant or effect command.
 * The publication owner must supply current lease and remote-readback facts.
 */
export function adjudicateCodexRootPublicationPreflight(
  input: CodexRootPublicationPreflightInputV1,
): CodexRootPublicationPreflightV1 {
  const parsed = parseInput(input);
  const denials: CodexRootPublicationDenialV1[] = [];
  const publicationClaim = parsed.claim === "delivery_ready" || parsed.claim === "rereview_ready";
  if (!publicationClaim) denials.push("local_receipt_only");
  if (
    parsed.deltaClaimed
    && (parsed.headBefore === null
      || parsed.deliveryHead === null
      || parsed.headBefore === parsed.deliveryHead)
  ) denials.push("claimed_delta_without_new_head");
  if (
    parsed.observedChangedPaths.some((path) => !parsed.representedChangedPaths.includes(path))
    || (parsed.deltaClaimed && parsed.representedChangedPaths.length === 0)
  ) denials.push("worktree_delta_unrepresented");
  if (
    parsed.ownerLease.leaseId !== parsed.currentOwnerLease.leaseId
    || parsed.ownerLease.generation !== parsed.currentOwnerLease.generation
    || parsed.ownerLease.repository !== parsed.repository
  ) denials.push("owner_lease_stale");
  if (parsed.ownerLease.intendedRemoteRef !== parsed.remoteReadback.ref) {
    denials.push("remote_ref_mismatch");
  }
  if (
    parsed.deliveryHead === null
    || parsed.remoteReadback.head === null
    || parsed.remoteReadback.deliveryHeadReachability !== "reachable"
  ) denials.push("delivery_head_not_reachable");
  if (parsed.requiredChecks.some((check) => check.outcome !== "passed")) {
    denials.push("required_check_not_passed");
  }
  const uniqueDenials = [...new Set(denials)];
  return deepFreeze({
    version: CODEX_ROOT_PUBLICATION_PREFLIGHT_V1,
    claim: parsed.claim,
    publicationEligible: publicationClaim && uniqueDenials.length === 0,
    authorizesPublication: false,
    denials: uniqueDenials,
    fingerprint: fingerprintCanonicalRequest(parsed),
  });
}

function parseInput(input: CodexRootPublicationPreflightInputV1): CodexRootPublicationPreflightInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Codex root publication preflight input must be an object");
  }
  if (input.version !== CODEX_ROOT_PUBLICATION_PREFLIGHT_V1) throw new RangeError("Codex root publication preflight version is invalid");
  const claims: readonly CodexRootReceiptClaimV1[] = ["local_progress", "local_blocker", "delivery_ready", "rereview_ready"];
  if (!claims.includes(input.claim)) throw new RangeError("Codex root receipt claim is invalid");
  const repository = identifier(input.repository, "Repository", 240);
  if (typeof input.deltaClaimed !== "boolean") throw new TypeError("Delta claim must be boolean");
  const headBefore = nullableSha(input.headBefore, "Head before");
  const deliveryHead = nullableSha(input.deliveryHead, "Delivery head");
  const observedChangedPaths = paths(input.observedChangedPaths, "Observed changed paths");
  const representedChangedPaths = paths(input.representedChangedPaths, "Represented changed paths");
  const ownerLease = {
    leaseId: identifier(input.ownerLease?.leaseId, "Owner lease ID", 240),
    generation: positiveInteger(input.ownerLease?.generation, "Owner lease generation"),
    repository: identifier(input.ownerLease?.repository, "Owner lease repository", 240),
    intendedRemoteRef: gitRef(input.ownerLease?.intendedRemoteRef, "Intended remote ref"),
  };
  const currentOwnerLease = {
    leaseId: identifier(input.currentOwnerLease?.leaseId, "Current owner lease ID", 240),
    generation: positiveInteger(input.currentOwnerLease?.generation, "Current owner lease generation"),
  };
  const remoteReadback = {
    ref: gitRef(input.remoteReadback?.ref, "Remote readback ref"),
    head: nullableSha(input.remoteReadback?.head, "Remote readback head"),
    deliveryHeadReachability: reachability(input.remoteReadback?.deliveryHeadReachability),
  };
  if (!Array.isArray(input.requiredChecks) || input.requiredChecks.length > 100) {
    throw new RangeError("Required checks must be a bounded array");
  }
  const requiredChecks = input.requiredChecks.map((check) => ({
    name: text(check?.name, "Required check name", 160),
    outcome: checkOutcome(check?.outcome),
  }));
  if (new Set(requiredChecks.map((check) => check.name)).size !== requiredChecks.length) {
    throw new RangeError("Required check names must be unique");
  }
  return deepFreeze({
    version: CODEX_ROOT_PUBLICATION_PREFLIGHT_V1,
    claim: input.claim,
    repository,
    deltaClaimed: input.deltaClaimed,
    headBefore,
    deliveryHead,
    observedChangedPaths,
    representedChangedPaths,
    ownerLease,
    currentOwnerLease,
    remoteReadback,
    requiredChecks,
  });
}

function paths(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new RangeError(`${label} must be a bounded array`);
  const parsed = value.map((entry) => text(entry, `${label} entry`, 1_024));
  if (new Set(parsed).size !== parsed.length) throw new RangeError(`${label} must be unique`);
  return [...parsed].sort();
}

function nullableSha(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) throw new RangeError(`${label} must be a Git SHA-1 or null`);
  return value;
}

function gitRef(value: unknown, label: string): string {
  const output = identifier(value, label, 1_024);
  if (!output.startsWith("refs/") || output.includes("..") || output.includes("@{") || output.endsWith("/") || output.endsWith(".")) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function identifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be text`);
  const output = value.trim();
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/u.test(output)) throw new RangeError(`${label} is invalid`);
  return output;
}

function text(value: unknown, label: string, maximum: number): string {
  return identifier(value, label, maximum);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be positive`);
  return value as number;
}

function reachability(value: unknown): CodexRootPublicationPreflightInputV1["remoteReadback"]["deliveryHeadReachability"] {
  if (value !== "reachable" && value !== "not_reachable" && value !== "unknown") {
    throw new RangeError("Delivery head reachability is invalid");
  }
  return value;
}

function checkOutcome(value: unknown): CodexRootRequiredCheckOutcomeV1 {
  if (value !== "passed" && value !== "failed" && value !== "unavailable" && value !== "not_executed") {
    throw new RangeError("Required check outcome is invalid");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
