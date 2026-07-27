import { createHash } from "node:crypto";
import { callsignCollisionKey } from "./callsign-suggestions.ts";

export const priorCallsignStates = [
  "active",
  "dormant",
  "released",
  "retired",
] as const;

export const callsignAcquisitionModes = ["reuse", "inherit"] as const;

export type PriorCallsignState = typeof priorCallsignStates[number];
export type CallsignAcquisitionMode = typeof callsignAcquisitionModes[number];
export type CallsignLifecycleDecision =
  | "blocked_active"
  | "blocked_cooling_off"
  | "blocked_retired"
  | "reusable"
  | "inherited";

const limits = {
  callsign: 80,
  runId: 160,
  relationId: 240,
  policyVersion: 120,
  maximumCoolingOffSeconds: 5 * 365 * 24 * 60 * 60,
} as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const policyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface CallsignLifecyclePolicyInput {
  version: string;
  coolingOffSeconds: number;
  explicitReleaseBypassesCoolingOff?: boolean;
}

export interface PriorCallsignHolderInput {
  callsign: string;
  runId: string;
  state: PriorCallsignState;
  lastActiveAt: string;
  releasedAt?: string;
  retiredAt?: string;
}

export interface CallsignInheritanceInput {
  fromRunId: string;
  transferReference: string;
}

export interface CallsignLifecycleRequestInput {
  requestedCallsign: string;
  newRunId: string;
  evaluatedAt: string;
  mode: CallsignAcquisitionMode;
  priorHolder: PriorCallsignHolderInput;
  policy: CallsignLifecyclePolicyInput;
  inheritance?: CallsignInheritanceInput;
}

export interface CallsignLifecycleResult {
  version: 1;
  requestedCallsign: string;
  collisionKey: string;
  newRunId: string;
  evaluatedAt: string;
  mode: CallsignAcquisitionMode;
  priorHolder: {
    callsign: string;
    collisionKey: string;
    runId: string;
    state: PriorCallsignState;
    lastActiveAt: string;
    releasedAt: string | null;
    retiredAt: string | null;
  };
  policy: {
    version: string;
    coolingOffSeconds: number;
    explicitReleaseBypassesCoolingOff: boolean;
  };
  inheritance: {
    fromRunId: string;
    transferReference: string;
  } | null;
  decision: CallsignLifecycleDecision;
  eligible: boolean;
  coolingOffUntil: string | null;
  previouslyUsed: true;
  lineageKind: "reuse" | "inherit" | null;
  priorAttributionPreserved: true;
  activatesCallsign: false;
  requiresDurableAcceptance: true;
  identityContinuity: false;
  authorityTransferred: false;
  responsibilityTransferred: false;
  fingerprint: string;
}

/**
 * Evaluates whether a previously used callsign is eligible for ordinary reuse or
 * explicit inheritance under one bounded policy.
 *
 * The result is descriptive lifecycle metadata only. It never activates the
 * callsign, rewrites historical attribution, transfers responsibility, proves
 * identity continuity, or grants authority. A later durable acceptance record is
 * required before a new run may become the active holder.
 */
export function evaluateCallsignLifecycle(
  input: CallsignLifecycleRequestInput,
): CallsignLifecycleResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RangeError("Callsign lifecycle request must be an object");
  }

  const evaluatedAt = canonicalTimestamp(input.evaluatedAt, "Evaluation time");
  const requested = canonicalCallsign(input.requestedCallsign, "Requested callsign");
  const prior = canonicalPriorHolder(input.priorHolder, evaluatedAt);
  if (requested.collisionKey !== prior.collisionKey) {
    throw new RangeError("Requested callsign must match the prior holder collision key");
  }

  const newRunId = canonicalRunId(input.newRunId, "New run ID");
  if (newRunId === prior.runId) {
    throw new RangeError("New run ID must differ from the prior holder run ID");
  }

  const mode = canonicalMode(input.mode);
  const policy = canonicalPolicy(input.policy);
  const inheritance = canonicalInheritance(input.inheritance, mode, prior.runId);
  const decision = decideLifecycle(prior, policy, mode, evaluatedAt);
  const eligible = decision === "reusable" || decision === "inherited";
  const coolingOffUntil = decision === "blocked_cooling_off"
    ? coolingOffDeadline(prior, policy)
    : null;
  const lineageKind: CallsignLifecycleResult["lineageKind"] = decision === "reusable"
    ? "reuse"
    : decision === "inherited"
    ? "inherit"
    : null;

  const canonical = {
    version: 1 as const,
    requestedCallsign: requested.display,
    collisionKey: requested.collisionKey,
    newRunId,
    evaluatedAt,
    mode,
    priorHolder: prior,
    policy,
    inheritance,
    decision,
    eligible,
    coolingOffUntil,
    previouslyUsed: true as const,
    lineageKind,
    priorAttributionPreserved: true as const,
    activatesCallsign: false as const,
    requiresDurableAcceptance: true as const,
    identityContinuity: false as const,
    authorityTransferred: false as const,
    responsibilityTransferred: false as const,
  };
  const fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;

  return { ...canonical, fingerprint };
}

function canonicalPriorHolder(
  input: PriorCallsignHolderInput,
  evaluatedAt: string,
): CallsignLifecycleResult["priorHolder"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RangeError("Prior callsign holder must be an object");
  }

  const callsign = canonicalCallsign(input.callsign, "Prior callsign");
  const runId = canonicalRunId(input.runId, "Prior holder run ID");
  const state = canonicalState(input.state);
  const lastActiveAt = canonicalTimestamp(input.lastActiveAt, "Prior last activity");
  const releasedAt = input.releasedAt === undefined
    ? null
    : canonicalTimestamp(input.releasedAt, "Release time");
  const retiredAt = input.retiredAt === undefined
    ? null
    : canonicalTimestamp(input.retiredAt, "Retirement time");

  if (Date.parse(lastActiveAt) > Date.parse(evaluatedAt)) {
    throw new RangeError("Prior activity cannot be later than evaluation time");
  }

  if (state === "released") {
    if (!releasedAt || retiredAt) {
      throw new RangeError("Released callsign state requires release time and no retirement time");
    }
    if (Date.parse(releasedAt) < Date.parse(lastActiveAt)) {
      throw new RangeError("Release time cannot be earlier than prior activity");
    }
    if (Date.parse(releasedAt) > Date.parse(evaluatedAt)) {
      throw new RangeError("Release time cannot be later than evaluation time");
    }
  } else if (state === "retired") {
    if (!retiredAt || releasedAt) {
      throw new RangeError("Retired callsign state requires retirement time and no release time");
    }
    if (Date.parse(retiredAt) < Date.parse(lastActiveAt)) {
      throw new RangeError("Retirement time cannot be earlier than prior activity");
    }
    if (Date.parse(retiredAt) > Date.parse(evaluatedAt)) {
      throw new RangeError("Retirement time cannot be later than evaluation time");
    }
  } else if (releasedAt || retiredAt) {
    throw new RangeError(`${state} callsign state cannot include release or retirement time`);
  }

  return {
    callsign: callsign.display,
    collisionKey: callsign.collisionKey,
    runId,
    state,
    lastActiveAt,
    releasedAt,
    retiredAt,
  };
}

function decideLifecycle(
  prior: CallsignLifecycleResult["priorHolder"],
  policy: CallsignLifecycleResult["policy"],
  mode: CallsignAcquisitionMode,
  evaluatedAt: string,
): CallsignLifecycleDecision {
  if (prior.state === "retired") return "blocked_retired";
  if (mode === "inherit") return "inherited";
  if (prior.state === "active") return "blocked_active";
  if (prior.state === "released" && policy.explicitReleaseBypassesCoolingOff) {
    return "reusable";
  }
  return Date.parse(evaluatedAt) >= Date.parse(coolingOffDeadline(prior, policy))
    ? "reusable"
    : "blocked_cooling_off";
}

function coolingOffDeadline(
  prior: CallsignLifecycleResult["priorHolder"],
  policy: CallsignLifecycleResult["policy"],
): string {
  const quietSince = prior.releasedAt ?? prior.lastActiveAt;
  return new Date(
    Date.parse(quietSince) + policy.coolingOffSeconds * 1_000,
  ).toISOString();
}

function canonicalCallsign(
  value: string,
  label: string,
): { display: string; collisionKey: string } {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
  const display = value.normalize("NFKC").trim().replace(/ {2,}/g, " ");
  if ([...display].length > limits.callsign) {
    throw new RangeError(`${label} must be at most ${limits.callsign} characters`);
  }
  return { display, collisionKey: callsignCollisionKey(display) };
}

function canonicalRunId(value: string, label: string): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError(`${label} must not be empty`);
  if ([...normalized].length > limits.runId) {
    throw new RangeError(`${label} must be at most ${limits.runId} characters`);
  }
  if (!runIdPattern.test(normalized)) {
    throw new RangeError(
      `${label} must start with run_ and contain only letters, digits, dot, underscore, colon, or hyphen`,
    );
  }
  return normalized;
}

function canonicalPolicy(
  input: CallsignLifecyclePolicyInput,
): CallsignLifecycleResult["policy"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RangeError("Callsign lifecycle policy must be an object");
  }
  const version = boundedIdentifier(
    input.version,
    "Callsign policy version",
    limits.policyVersion,
    policyVersionPattern,
  );
  if (
    !Number.isInteger(input.coolingOffSeconds)
    || input.coolingOffSeconds < 0
    || input.coolingOffSeconds > limits.maximumCoolingOffSeconds
  ) {
    throw new RangeError(
      `Callsign cooling-off seconds must be an integer from 0 to ${limits.maximumCoolingOffSeconds}`,
    );
  }
  if (
    input.explicitReleaseBypassesCoolingOff !== undefined
    && typeof input.explicitReleaseBypassesCoolingOff !== "boolean"
  ) {
    throw new RangeError("Explicit release bypass must be a boolean");
  }
  return {
    version,
    coolingOffSeconds: input.coolingOffSeconds,
    explicitReleaseBypassesCoolingOff: input.explicitReleaseBypassesCoolingOff ?? false,
  };
}

function canonicalInheritance(
  input: CallsignInheritanceInput | undefined,
  mode: CallsignAcquisitionMode,
  priorRunId: string,
): CallsignLifecycleResult["inheritance"] {
  if (mode === "reuse") {
    if (input !== undefined) {
      throw new RangeError("Ordinary callsign reuse cannot include inheritance metadata");
    }
    return null;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RangeError("Callsign inheritance requires transfer metadata");
  }
  const fromRunId = canonicalRunId(input.fromRunId, "Inheritance source run ID");
  if (fromRunId !== priorRunId) {
    throw new RangeError("Inheritance source run ID must match the prior holder run ID");
  }
  return {
    fromRunId,
    transferReference: boundedIdentifier(
      input.transferReference,
      "Inheritance transfer reference",
      limits.relationId,
      identifierPattern,
    ),
  };
}

function canonicalState(value: PriorCallsignState): PriorCallsignState {
  if (!priorCallsignStates.includes(value)) {
    throw new RangeError(`Unknown prior callsign state: ${String(value)}`);
  }
  return value;
}

function canonicalMode(value: CallsignAcquisitionMode): CallsignAcquisitionMode {
  if (!callsignAcquisitionModes.includes(value)) {
    throw new RangeError(`Unknown callsign acquisition mode: ${String(value)}`);
  }
  return value;
}

function boundedIdentifier(
  value: string,
  label: string,
  maximumLength: number,
  pattern: RegExp,
): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError(`${label} must not be empty`);
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  if (!pattern.test(normalized)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
  const normalized = value.trim();
  if (!timestampPattern.test(normalized)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const canonical = new Date(milliseconds).toISOString();
  const comparableInput = normalized.includes(".")
    ? normalized
    : normalized.replace(/Z$/, ".000Z");
  if (canonical !== comparableInput) {
    throw new RangeError(`${label} must be a valid calendar timestamp`);
  }
  return canonical;
}
