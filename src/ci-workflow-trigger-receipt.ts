import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  CI_RUN_EVENTS,
  type CiRunEvent,
  type CiTrustedClock,
} from "./ci-queue-receipt.js";

export const CI_WORKFLOW_TRIGGER_RECEIPT_V1 = 1 as const;

export type CiWorkflowTriggerState =
  | "run_not_observed"
  | "run_observed"
  | "provider_state_unknown";

export interface CiWorkflowRunReferenceInputV1 {
  runId: number;
  attempt: number;
}

export interface CiWorkflowTriggerObservationInputV1 {
  version: typeof CI_WORKFLOW_TRIGGER_RECEIPT_V1;
  repository: string;
  workflowId: number;
  workflowRevision: string;
  candidateRevision: string;
  event: CiRunEvent;
  pullRequestNumber: number | null;
  observedAt: string;
  lookupComplete: boolean;
  runs: CiWorkflowRunReferenceInputV1[];
}

export interface CiWorkflowTriggerReceiptV1
  extends Omit<CiWorkflowTriggerObservationInputV1, "runs"> {
  runs: readonly Readonly<CiWorkflowRunReferenceInputV1>[];
  triggerState: CiWorkflowTriggerState;
  authorizesMerge: false;
  authorizesMutation: false;
  authorizesRetry: false;
  receiptFingerprint: string;
}

const observationKeys = [
  "version",
  "repository",
  "workflowId",
  "workflowRevision",
  "candidateRevision",
  "event",
  "pullRequestNumber",
  "observedAt",
  "lookupComplete",
  "runs",
] as const;
const runKeys = ["runId", "attempt"] as const;
const maximumPullRequestNumber = 2_147_483_647;
const maximumWorkflowAttempt = 1_000_000;
const shaPattern = /^[0-9a-f]{40}$/u;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const credentialPattern =
  /(?:^|[._:/-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/iu;
const trustedClockError =
  "CI trigger trusted observation clock did not attest the observation time";

type DataRecord = Record<string, unknown>;

/**
 * Compiles exact-candidate workflow lookup evidence.
 *
 * A complete empty lookup records `run_not_observed`: no matching run was
 * visible at the trusted observation time. Incomplete empty lookups remain
 * unknown, and a later observation may validly record a matching run.
 */
export function compileCiWorkflowTriggerReceiptV1(
  value: unknown,
  trustedClock: CiTrustedClock,
): CiWorkflowTriggerReceiptV1 {
  const input = exactRecord(value, observationKeys, "CI trigger observation");
  if (input.version !== CI_WORKFLOW_TRIGGER_RECEIPT_V1) {
    throw new RangeError("CI trigger observation version is unsupported");
  }

  const event = closed(input.event, CI_RUN_EVENTS, "CI trigger event");
  const pullRequestNumber = nullablePositiveInteger(
    input.pullRequestNumber,
    "CI trigger pull request number",
    maximumPullRequestNumber,
  );
  if (event === "pull_request" && pullRequestNumber === null) {
    throw new RangeError("Pull-request CI trigger evidence requires a pull request number");
  }
  if (event !== "pull_request" && pullRequestNumber !== null) {
    throw new RangeError("Only pull-request CI trigger evidence may carry a pull request number");
  }

  const observedAt = canonicalTimestamp(input.observedAt);
  attestTrustedObservationTime(trustedClock, observedAt);
  const lookupComplete = exactBoolean(input.lookupComplete, "CI trigger lookup completeness");
  const runs = exactArray(input.runs, "CI trigger runs", 0, 32)
    .map((entry, index) => {
      const run = exactRecord(entry, runKeys, `CI trigger run ${index}`);
      return Object.freeze({
        runId: positiveInteger(
          run.runId,
          `CI trigger run ${index} ID`,
          Number.MAX_SAFE_INTEGER,
        ),
        attempt: positiveInteger(
          run.attempt,
          `CI trigger run ${index} attempt`,
          maximumWorkflowAttempt,
        ),
      });
    })
    .sort((left, right) => left.runId - right.runId || left.attempt - right.attempt);
  const identities = new Set<string>();
  for (const run of runs) {
    const identity = `${run.runId}:${run.attempt}`;
    if (identities.has(identity)) {
      throw new RangeError("CI trigger runs must have unique run-attempt identities");
    }
    identities.add(identity);
  }

  const triggerState: CiWorkflowTriggerState = runs.length > 0
    ? "run_observed"
    : lookupComplete
      ? "run_not_observed"
      : "provider_state_unknown";
  const receipt = {
    version: CI_WORKFLOW_TRIGGER_RECEIPT_V1,
    repository: repositoryName(input.repository),
    workflowId: positiveInteger(
      input.workflowId,
      "CI trigger workflow ID",
      Number.MAX_SAFE_INTEGER,
    ),
    workflowRevision: commitSha(input.workflowRevision, "CI trigger workflow revision"),
    candidateRevision: commitSha(input.candidateRevision, "CI trigger candidate revision"),
    event,
    pullRequestNumber,
    observedAt,
    lookupComplete,
    runs: Object.freeze(runs),
    triggerState,
    authorizesMerge: false as const,
    authorizesMutation: false as const,
    authorizesRetry: false as const,
  };
  return deepFreeze({
    ...receipt,
    receiptFingerprint: fingerprintCanonicalRequest(receipt),
  });
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} contains unknown fields`);
  }
  if (ownKeys.length !== keys.length) {
    throw new TypeError(`${label} is missing required fields`);
  }
  const output = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < minimum
    || lengthDescriptor.value > maximum
  ) {
    throw new RangeError(`${label} length is outside the accepted range`);
  }
  const length = lengthDescriptor.value as number;
  const allowed = new Set<PropertyKey>([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must be dense data properties`);
    }
    return descriptor.value;
  });
}

function closed<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RangeError(`${label} is unsupported`);
  }
  return value as T[number];
}

function repositoryName(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > 201
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || credentialPattern.test(value)
  ) {
    throw new RangeError("CI trigger repository is invalid");
  }
  if (value !== value.toLowerCase()) {
    throw new RangeError("CI trigger repository must use exact lowercase identity");
  }
  const [owner, name, extra] = value.split("/");
  if (
    extra !== undefined
    || owner === undefined
    || name === undefined
    || owner.includes("--")
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(owner)
    || !/^[a-z0-9](?:[a-z0-9_.-]{0,99})$/u.test(name)
  ) {
    throw new RangeError("CI trigger repository is invalid");
  }
  return value;
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new RangeError(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
    || Object.is(value, -0)
  ) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nullablePositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number | null {
  return value === null ? null : positiveInteger(value, label, maximum);
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new RangeError("CI trigger observation time must be canonical UTC text");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("CI trigger observation time must be canonical UTC text");
  }
  const normalized = new Date(milliseconds).toISOString();
  const canonical = value.includes(".")
    ? normalized === value
    : normalized.replace(/\.000Z$/u, "Z") === value;
  if (!canonical) {
    throw new RangeError("CI trigger observation time must be canonical UTC text");
  }
  return normalized;
}

function attestTrustedObservationTime(
  trustedClock: CiTrustedClock,
  observedAt: string,
): void {
  let trusted: Date;
  try {
    trusted = trustedClock();
  } catch {
    throw new RangeError(trustedClockError);
  }
  if (
    !(trusted instanceof Date)
    || !Number.isFinite(trusted.getTime())
    || trusted.toISOString() !== observedAt
  ) {
    throw new RangeError(trustedClockError);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return value;
}
