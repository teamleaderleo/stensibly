import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const CI_QUEUE_RECEIPT_V1 = 1 as const;
export const CI_VALIDATION_PROFILE_CONTRACT_V1 = 1 as const;
export const CI_RUN_EVENTS = ["pull_request", "workflow_dispatch", "push", "merge_group"] as const;
export const CI_RUN_STATUSES = ["requested", "waiting", "pending", "queued", "in_progress", "completed"] as const;
export const CI_JOB_STATUSES = CI_RUN_STATUSES;
export const CI_RUN_CONCLUSIONS = [
  "success", "failure", "cancelled", "neutral", "skipped", "timed_out",
  "action_required", "stale", "startup_failure",
] as const;
export const CI_JOB_CONCLUSIONS = CI_RUN_CONCLUSIONS;
export const CI_CANONICAL_COMMAND_IDS_V1 = Object.freeze([
  "lockfile", "typecheck", "bun-tests", "convex-tests", "worker-check", "runtime-parity",
] as const);
export const CI_VALIDATION_PROFILE_COMMANDS_V1 = Object.freeze({
  full_parallel: CI_CANONICAL_COMMAND_IDS_V1,
  serial_full: CI_CANONICAL_COMMAND_IDS_V1,
} as const);

export type CiRunEvent = typeof CI_RUN_EVENTS[number];
export type CiRunStatus = typeof CI_RUN_STATUSES[number];
export type CiJobStatus = typeof CI_JOB_STATUSES[number];
export type CiRunConclusion = typeof CI_RUN_CONCLUSIONS[number];
export type CiJobConclusion = typeof CI_JOB_CONCLUSIONS[number];
export type CiValidationProfileState = "reviewed" | "unreviewed";
export type CiQueueReason = "workflow_request" | "deployment_protection" | "concurrency_limit" | "unknown" | null;
export type CiTrustedClock = () => Date;

export interface CiJobObservationInputV1 {
  jobId: number;
  name: string;
  requestedLabels: string[];
  status: CiJobStatus;
  conclusion: CiJobConclusion | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  runnerOs: string | null;
  runnerArch: string | null;
  runnerImage: string | null;
  failedStep: string | null;
  diagnosticsFingerprint: string | null;
}

export interface CiQueueObservationInputV1 {
  version: typeof CI_QUEUE_RECEIPT_V1;
  repository: string;
  workflowName: string;
  workflowRunId: number;
  workflowAttempt: number;
  event: CiRunEvent;
  pullRequestNumber: number | null;
  candidateRevision: string;
  baseRevision: string | null;
  workflowRevision: string;
  validationProfile: string;
  commandIds: string[];
  concurrencyGroup: string | null;
  supersededByRevision: string | null;
  createdAt: string;
  observedAt: string;
  completedAt: string | null;
  status: CiRunStatus;
  conclusion: CiRunConclusion | null;
  jobs: CiJobObservationInputV1[];
}

export interface CiJobReceiptV1 extends Omit<CiJobObservationInputV1, "requestedLabels"> {
  requestedLabels: readonly string[];
  queueWaitMs: number | null;
  durationMs: number | null;
}

export interface CiQueueReceiptV1 extends Omit<CiQueueObservationInputV1, "commandIds" | "jobs"> {
  commandIds: readonly string[];
  validationProfileState: CiValidationProfileState;
  firstJobStartedAt: string | null;
  queueWaitMs: number | null;
  durationMs: number | null;
  observedQueueAgeMs: number | null;
  awaitingExecutionStart: boolean;
  queueReason: CiQueueReason;
  queuePosition: "unknown";
  jobs: readonly CiJobReceiptV1[];
  authorizesMerge: false;
  authorizesMutation: false;
  receiptFingerprint: string;
}

interface CanonicalTimestamp { readonly value: string; readonly milliseconds: number }
interface ParsedJob {
  readonly receipt: CiJobReceiptV1;
  readonly startedMilliseconds: number | null;
  readonly completedMilliseconds: number | null;
}

const observationKeys = [
  "version", "repository", "workflowName", "workflowRunId", "workflowAttempt", "event",
  "pullRequestNumber", "candidateRevision", "baseRevision", "workflowRevision",
  "validationProfile", "commandIds", "concurrencyGroup", "supersededByRevision",
  "createdAt", "observedAt", "completedAt", "status", "conclusion", "jobs",
] as const;
const jobKeys = [
  "jobId", "name", "requestedLabels", "status", "conclusion", "queuedAt", "startedAt",
  "completedAt", "runnerOs", "runnerArch", "runnerImage", "failedStep", "diagnosticsFingerprint",
] as const;
const preExecutionStatuses = new Set<CiRunStatus>(["requested", "waiting", "pending", "queued"]);
const noStartJobConclusions = new Set<CiJobConclusion>(["skipped", "action_required", "stale", "startup_failure"]);
const zeroJobRunConclusions = new Set<CiRunConclusion>(["cancelled", "skipped", "action_required", "stale", "startup_failure"]);
const compatibility = {
  success: ["success", "neutral", "skipped"],
  failure: ["success", "failure", "cancelled", "neutral", "skipped"],
  cancelled: ["success", "cancelled", "neutral", "skipped"],
  neutral: ["success", "neutral", "skipped"],
  skipped: ["skipped"],
  timed_out: ["success", "cancelled", "neutral", "skipped", "timed_out"],
  action_required: ["action_required", "skipped"],
  stale: ["stale", "skipped"],
  startup_failure: ["startup_failure", "skipped"],
} as const satisfies Record<CiRunConclusion, readonly CiJobConclusion[]>;
const credentialPattern = /(?:^|[._:/-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/iu;
const trustedClockError = "CI trusted observation clock did not attest the observation time";

export function compileCiQueueReceiptV1(value: unknown, trustedClock: CiTrustedClock): CiQueueReceiptV1 {
  const input = exactRecord(value, observationKeys, "CI queue observation");
  if (input.version !== CI_QUEUE_RECEIPT_V1) throw new RangeError("CI queue observation version is unsupported");

  const event = closed(input.event, CI_RUN_EVENTS, "CI run event");
  const pullRequestNumber = nullablePositiveInteger(input.pullRequestNumber, "CI pull request number", 2_147_483_647);
  if (event === "pull_request" && pullRequestNumber === null) throw new RangeError("Pull-request CI requires a pull request number");
  if (event !== "pull_request" && pullRequestNumber !== null) throw new RangeError("Only pull-request CI may carry a pull request number");

  const candidateRevision = commitSha(input.candidateRevision, "CI candidate revision");
  const baseRevision = nullableCommitSha(input.baseRevision, "CI base revision");
  const workflowRevision = commitSha(input.workflowRevision, "CI workflow revision");
  const supersededByRevision = nullableCommitSha(input.supersededByRevision, "CI superseding revision");
  if (supersededByRevision === candidateRevision) throw new RangeError("CI superseding revision must differ from the candidate");

  const createdAt = timestamp(input.createdAt, "CI creation time");
  const observedAt = timestamp(input.observedAt, "CI observation time");
  attestTrustedObservationTime(trustedClock, observedAt);
  const completedAt = nullableTimestamp(input.completedAt, "CI run completion time");
  if (observedAt.milliseconds < createdAt.milliseconds) throw new RangeError("CI observation time cannot precede creation");

  const status = closed(input.status, CI_RUN_STATUSES, "CI run status");
  const conclusion = input.conclusion === null ? null : closed(input.conclusion, CI_RUN_CONCLUSIONS, "CI run conclusion");
  validateTerminal(status, conclusion, "CI run");
  if (status === "completed" && completedAt === null) throw new RangeError("Completed CI runs require a completion time");
  if (status !== "completed" && completedAt !== null) throw new RangeError("Nonterminal CI runs cannot carry a completion time");
  if (completedAt !== null && (completedAt.milliseconds < createdAt.milliseconds || completedAt.milliseconds > observedAt.milliseconds)) {
    throw new RangeError("CI run completion time is outside the observed interval");
  }
  if (supersededByRevision !== null && conclusion !== "cancelled") throw new RangeError("A superseded CI run must be completed as cancelled");

  const parsedJobs = exactArray(input.jobs, "CI jobs", 0, 100)
    .map((entry) => parseJob(entry, createdAt, observedAt))
    .sort((left, right) => left.receipt.jobId - right.receipt.jobId);
  const jobs = parsedJobs.map((job) => job.receipt);
  requireUnique(jobs.map((job) => String(job.jobId)), "CI jobs must have unique job IDs");
  validateRunJobs(status, conclusion, jobs);
  if (completedAt !== null && parsedJobs.some((job) => job.completedMilliseconds !== null && job.completedMilliseconds > completedAt.milliseconds)) {
    throw new RangeError("CI job completion cannot follow run completion");
  }

  const validationProfile = identifier(input.validationProfile, "CI validation profile", 160);
  const commandIds = orderedIdentifiers(input.commandIds, "CI validation command IDs", 1, 50);
  const reviewedCommands = reviewedProfileCommands(validationProfile);
  const validationProfileState: CiValidationProfileState = reviewedCommands === null ? "unreviewed" : "reviewed";
  if (reviewedCommands !== null && !sameStrings(commandIds, reviewedCommands)) {
    throw new RangeError("Reviewed CI validation profile requires its canonical command IDs");
  }

  const firstStarted = parsedJobs
    .filter((job) => job.startedMilliseconds !== null)
    .sort((left, right) => left.startedMilliseconds! - right.startedMilliseconds!)[0] ?? null;
  const firstJobStartedAt = firstStarted?.receipt.startedAt ?? null;
  const firstJobStartedMilliseconds = firstStarted?.startedMilliseconds ?? null;
  const awaitingExecutionStart = status !== "completed" && firstJobStartedAt === null;
  const receipt = {
    version: CI_QUEUE_RECEIPT_V1,
    repository: repositoryName(input.repository),
    workflowName: text(input.workflowName, "CI workflow name", 160),
    workflowRunId: positiveInteger(input.workflowRunId, "CI workflow run ID", Number.MAX_SAFE_INTEGER),
    workflowAttempt: positiveInteger(input.workflowAttempt, "CI workflow attempt", 1_000_000),
    event,
    pullRequestNumber,
    candidateRevision,
    baseRevision,
    workflowRevision,
    validationProfile,
    validationProfileState,
    commandIds,
    concurrencyGroup: nullableText(input.concurrencyGroup, "CI concurrency group", 240),
    supersededByRevision,
    createdAt: createdAt.value,
    observedAt: observedAt.value,
    completedAt: completedAt?.value ?? null,
    status,
    conclusion,
    firstJobStartedAt,
    queueWaitMs: firstJobStartedMilliseconds === null ? null : firstJobStartedMilliseconds - createdAt.milliseconds,
    durationMs: completedAt === null ? null : completedAt.milliseconds - createdAt.milliseconds,
    observedQueueAgeMs: awaitingExecutionStart ? observedAt.milliseconds - createdAt.milliseconds : null,
    awaitingExecutionStart,
    queueReason: queueReason(status, awaitingExecutionStart),
    queuePosition: "unknown" as const,
    jobs,
    authorizesMerge: false as const,
    authorizesMutation: false as const,
  };
  return deepFreeze({ ...receipt, receiptFingerprint: fingerprintCanonicalRequest(receipt) });
}

function parseJob(value: unknown, runCreatedAt: CanonicalTimestamp, observedAt: CanonicalTimestamp): ParsedJob {
  const input = exactRecord(value, jobKeys, "CI job observation");
  const status = closed(input.status, CI_JOB_STATUSES, "CI job status");
  const conclusion = input.conclusion === null ? null : closed(input.conclusion, CI_JOB_CONCLUSIONS, "CI job conclusion");
  validateTerminal(status, conclusion, "CI job");
  const queuedAt = timestamp(input.queuedAt, "CI job queue time");
  const startedAt = nullableTimestamp(input.startedAt, "CI job start time");
  const completedAt = nullableTimestamp(input.completedAt, "CI job completion time");
  if (queuedAt.milliseconds < runCreatedAt.milliseconds || queuedAt.milliseconds > observedAt.milliseconds) {
    throw new RangeError("CI job queue time is outside the observed run interval");
  }
  if (startedAt !== null && (startedAt.milliseconds < queuedAt.milliseconds || startedAt.milliseconds > observedAt.milliseconds)) {
    throw new RangeError("CI job start time is outside its queue interval");
  }
  if (completedAt !== null && (
    completedAt.milliseconds > observedAt.milliseconds
    || (startedAt !== null && completedAt.milliseconds < startedAt.milliseconds)
    || (startedAt === null && completedAt.milliseconds < queuedAt.milliseconds)
  )) throw new RangeError("CI job completion time is outside its execution interval");

  if (preExecutionStatuses.has(status) && (startedAt !== null || completedAt !== null)) {
    throw new RangeError("Pre-execution CI jobs cannot carry execution timestamps");
  }
  if (status === "in_progress" && (startedAt === null || completedAt !== null)) throw new RangeError("In-progress CI jobs require only a start time");
  if (status === "completed" && completedAt === null) throw new RangeError("Completed CI jobs require a completion time");
  if (status === "completed" && startedAt === null && conclusion !== null && !noStartJobConclusions.has(conclusion)) {
    throw new RangeError("This CI job conclusion requires execution start evidence");
  }
  if (status === "completed" && startedAt !== null && conclusion !== null && noStartJobConclusions.has(conclusion)) {
    throw new RangeError("This CI job conclusion cannot carry execution start evidence");
  }

  const runnerOs = nullableText(input.runnerOs, "CI runner OS", 120);
  const runnerArch = nullableText(input.runnerArch, "CI runner architecture", 120);
  const runnerImage = nullableText(input.runnerImage, "CI runner image", 240);
  if (startedAt === null && (runnerOs !== null || runnerArch !== null || runnerImage !== null)) {
    throw new RangeError("Unstarted CI jobs cannot carry runner identity");
  }
  const failedStep = nullableText(input.failedStep, "CI failed step", 240);
  const diagnosticsFingerprint = nullableSha256(input.diagnosticsFingerprint, "CI diagnostics fingerprint");
  if (conclusion !== "failure" && (failedStep !== null || diagnosticsFingerprint !== null)) {
    throw new RangeError("Only failed CI jobs may carry failure diagnostics");
  }
  if (conclusion === "failure" && failedStep === null) throw new RangeError("Failed CI jobs require a bounded failed step");

  const receipt = deepFreeze({
    jobId: positiveInteger(input.jobId, "CI job ID", Number.MAX_SAFE_INTEGER),
    name: text(input.name, "CI job name", 160),
    requestedLabels: sortedIdentifiers(input.requestedLabels, "CI requested runner labels", 1, 20),
    status,
    conclusion,
    queuedAt: queuedAt.value,
    startedAt: startedAt?.value ?? null,
    completedAt: completedAt?.value ?? null,
    queueWaitMs: startedAt === null ? null : startedAt.milliseconds - queuedAt.milliseconds,
    durationMs: startedAt === null || completedAt === null ? null : completedAt.milliseconds - startedAt.milliseconds,
    runnerOs,
    runnerArch,
    runnerImage,
    failedStep,
    diagnosticsFingerprint,
  });
  return {
    receipt,
    startedMilliseconds: startedAt?.milliseconds ?? null,
    completedMilliseconds: completedAt?.milliseconds ?? null,
  };
}

function validateTerminal(
  status: CiRunStatus | CiJobStatus,
  conclusion: CiRunConclusion | CiJobConclusion | null,
  label: string,
): void {
  if ((status === "completed") !== (conclusion !== null)) throw new RangeError(`${label} status and conclusion are inconsistent`);
}

function validateRunJobs(status: CiRunStatus, conclusion: CiRunConclusion | null, jobs: readonly CiJobReceiptV1[]): void {
  if (preExecutionStatuses.has(status) && jobs.some((job) => !preExecutionStatuses.has(job.status))) {
    throw new RangeError("Pre-execution CI runs cannot contain executed jobs");
  }
  if (status === "completed" && jobs.some((job) => job.status !== "completed")) throw new RangeError("Completed CI runs require completed jobs");
  if (status !== "completed" || conclusion === null) return;
  if (jobs.length === 0 && !zeroJobRunConclusions.has(conclusion)) throw new RangeError("This completed CI run requires job evidence");
  if (jobs.some((job) => job.conclusion === null || !compatibility[conclusion].some((candidate) => candidate === job.conclusion))) {
    throw new RangeError("CI run conclusion is incompatible with its job conclusions");
  }
  if (conclusion === "failure" && !hasConclusion(jobs, "failure")) throw new RangeError("Failed CI runs require a failed job");
  if (conclusion === "neutral" && !hasConclusion(jobs, "neutral")) throw new RangeError("Neutral CI runs require a neutral job");
  if (conclusion === "timed_out" && !hasConclusion(jobs, "timed_out")) throw new RangeError("Timed-out CI runs require a timed-out job");
  if (conclusion === "action_required" && jobs.length > 0 && !hasConclusion(jobs, "action_required")) {
    throw new RangeError("Action-required CI runs require action-required job evidence");
  }
  if (conclusion === "stale" && jobs.length > 0 && !hasConclusion(jobs, "stale")) {
    throw new RangeError("Stale CI runs require stale job evidence");
  }
  if (conclusion === "startup_failure" && jobs.length > 0 && !hasConclusion(jobs, "startup_failure")) {
    throw new RangeError("Startup-failure CI runs require startup-failure job evidence");
  }
}

function hasConclusion(jobs: readonly CiJobReceiptV1[], conclusion: CiJobConclusion): boolean {
  return jobs.some((job) => job.conclusion === conclusion);
}

function queueReason(status: CiRunStatus, awaitingExecutionStart: boolean): CiQueueReason {
  if (!awaitingExecutionStart) return null;
  if (status === "requested") return "workflow_request";
  if (status === "waiting") return "deployment_protection";
  if (status === "pending") return "concurrency_limit";
  return "unknown";
}

function reviewedProfileCommands(profile: string): readonly string[] | null {
  if (!Object.hasOwn(CI_VALIDATION_PROFILE_COMMANDS_V1, profile)) return null;
  return CI_VALIDATION_PROFILE_COMMANDS_V1[profile as keyof typeof CI_VALIDATION_PROFILE_COMMANDS_V1];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function attestTrustedObservationTime(trustedClock: CiTrustedClock, observedAt: CanonicalTimestamp): void {
  let trusted: unknown;
  try { trusted = trustedClock(); } catch { throw new RangeError(trustedClockError); }
  if (!(trusted instanceof Date) || !Number.isFinite(trusted.getTime())) throw new RangeError(trustedClockError);
  if (trusted.getTime() !== observedAt.milliseconds || trusted.toISOString() !== observedAt.value) {
    throw new RangeError(trustedClockError);
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RangeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(keys);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new RangeError(`${label} contains unknown fields`);
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new RangeError(`${label} fields must be enumerable data properties`);
    result[key] = descriptor.value;
  }
  for (const key of keys) if (!Object.hasOwn(descriptors, key)) throw new RangeError(`${label} is missing required fields`);
  return result;
}

function exactArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new RangeError(`${label} must be a plain array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) throw new RangeError(`${label} has an invalid length`);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) {
    throw new RangeError(`${label} must contain between ${minimum} and ${maximum} entries`);
  }
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new RangeError(`${label} contains unsupported fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new RangeError(`${label} must be dense`);
    if (!descriptor.enumerable || !("value" in descriptor)) throw new RangeError(`${label} entries must be enumerable data properties`);
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || !value || value.length > maximum || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value) || credentialPattern.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}
function nullableText(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : text(value, label, maximum);
}
function identifier(value: unknown, label: string, maximum: number): string {
  const result = text(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(result)) throw new RangeError(`${label} is invalid`);
  return result;
}
function repositoryName(value: unknown): string {
  const repository = text(value, "CI repository", 201);
  if (repository !== repository.toLowerCase()) throw new RangeError("CI repository must use exact lowercase identity");
  const [owner, name, extra] = repository.split("/");
  if (
    extra !== undefined || owner === undefined || name === undefined || owner.includes("--")
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(owner)
    || !/^[a-z0-9](?:[a-z0-9_.-]{0,99})$/u.test(name)
  ) throw new RangeError("CI repository is invalid");
  return repository;
}
function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) throw new RangeError(`${label} must be a lowercase full commit SHA`);
  return value;
}
function nullableCommitSha(value: unknown, label: string): string | null {
  return value === null ? null : commitSha(value, label);
}
function nullableSha256(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}
function timestamp(value: unknown, label: string): CanonicalTimestamp {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const parsed = new Date(value);
  const milliseconds = parsed.getTime();
  const canonical = parsed.toISOString();
  const expected = value.length === 20 ? value.replace(/Z$/u, ".000Z") : value;
  if (!Number.isFinite(milliseconds) || canonical !== expected) throw new RangeError(`${label} must be a canonical timestamp`);
  return { value: canonical, milliseconds };
}
function nullableTimestamp(value: unknown, label: string): CanonicalTimestamp | null {
  return value === null ? null : timestamp(value, label);
}
function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}
function nullablePositiveInteger(value: unknown, label: string, maximum: number): number | null {
  return value === null ? null : positiveInteger(value, label, maximum);
}
function orderedIdentifiers(value: unknown, label: string, minimum: number, maximum: number): string[] {
  const entries = exactArray(value, label, minimum, maximum).map((entry) => identifier(entry, label, 120));
  requireUnique(entries, `${label} must be unique`);
  return entries;
}
function sortedIdentifiers(value: unknown, label: string, minimum: number, maximum: number): string[] {
  return orderedIdentifiers(value, label, minimum, maximum).sort(compare);
}
function requireUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new RangeError(message);
}
function closed<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) throw new RangeError(`${label} is invalid`);
  return value as T[number];
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
