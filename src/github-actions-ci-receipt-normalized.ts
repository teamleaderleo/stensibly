import {
  CI_CANONICAL_COMMAND_IDS_V1,
  CI_JOB_CONCLUSIONS,
  CI_QUEUE_RECEIPT_V1,
  CI_RUN_CONCLUSIONS,
  compileCiQueueReceiptV1,
  type CiJobConclusion,
  type CiQueueReceiptV1,
  type CiRunConclusion,
  type CiTrustedClock,
} from "./ci-queue-receipt.js";

export const GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1 = 1 as const;
export const GITHUB_ACTIONS_CI_WORKFLOW_NAME = "CI" as const;
export const GITHUB_ACTIONS_CI_WORKFLOW_PATH = ".github/workflows/ci.yml" as const;
export const GITHUB_ACTIONS_CI_JOB_NAMES = [
  "test",
  "runtime-parity",
  "serial-full",
] as const;
export const GITHUB_ACTIONS_CI_VALIDATION_PROFILES = [
  "full_parallel",
  "serial_full",
] as const;

export type GitHubActionsCiValidationProfile =
  typeof GITHUB_ACTIONS_CI_VALIDATION_PROFILES[number];

export interface GitHubActionsCiReceiptBundleV1 {
  readonly version: typeof GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1;
  readonly repository: string;
  readonly receivedAt: string;
  readonly workflowRevision: string;
  readonly validationProfile: GitHubActionsCiValidationProfile;
  readonly supersededByRevision: string | null;
  readonly run: GitHubActionsCompletedRunV1;
  readonly jobs: GitHubActionsCompletedJobV1[];
  readonly diagnosticsArtifacts: GitHubActionsDiagnosticsArtifactV1[];
}

export interface GitHubActionsCompletedRunV1 {
  readonly id: number;
  readonly attempt: number;
  readonly name: typeof GITHUB_ACTIONS_CI_WORKFLOW_NAME;
  readonly path: typeof GITHUB_ACTIONS_CI_WORKFLOW_PATH;
  readonly event: "pull_request" | "push" | "workflow_dispatch";
  readonly status: "completed";
  readonly conclusion: CiRunConclusion;
  readonly headSha: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly pullRequests: GitHubActionsRunPullRequestV1[];
}

export interface GitHubActionsRunPullRequestV1 {
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
}

export interface GitHubActionsCompletedJobV1 {
  readonly id: number;
  readonly runId: number;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly workflowName: typeof GITHUB_ACTIONS_CI_WORKFLOW_NAME;
  readonly name: typeof GITHUB_ACTIONS_CI_JOB_NAMES[number];
  readonly status: "completed";
  readonly conclusion: CiJobConclusion;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string;
  readonly labels: string[];
  readonly steps: GitHubActionsCompletedStepV1[];
}

export interface GitHubActionsCompletedStepV1 {
  readonly number: number;
  readonly name: string;
  readonly status: "completed";
  readonly conclusion: CiJobConclusion;
}

export interface GitHubActionsDiagnosticsArtifactV1 {
  readonly workflowRunId: number;
  readonly name:
    | "diagnostics"
    | "runtime-parity-diagnostics"
    | "serial-full-diagnostics";
  readonly digest: string;
}

const bundleKeys = [
  "version",
  "repository",
  "receivedAt",
  "workflowRevision",
  "validationProfile",
  "supersededByRevision",
  "run",
  "jobs",
  "diagnosticsArtifacts",
] as const;
const runKeys = [
  "id",
  "attempt",
  "name",
  "path",
  "event",
  "status",
  "conclusion",
  "headSha",
  "createdAt",
  "completedAt",
  "pullRequests",
] as const;
const pullRequestKeys = ["number", "headSha", "baseSha"] as const;
const jobKeys = [
  "id",
  "runId",
  "runAttempt",
  "headSha",
  "workflowName",
  "name",
  "status",
  "conclusion",
  "createdAt",
  "startedAt",
  "completedAt",
  "labels",
  "steps",
] as const;
const stepKeys = ["number", "name", "status", "conclusion"] as const;
const artifactKeys = ["workflowRunId", "name", "digest"] as const;
const allowedEvents = ["pull_request", "push", "workflow_dispatch"] as const;
const allowedArtifactNames = [
  "diagnostics",
  "runtime-parity-diagnostics",
  "serial-full-diagnostics",
] as const;
const credentialPattern =
  /(?:^|[._:/-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/iu;
const fallbackFailedStep = "GitHub Actions job failure";

export function compileGitHubActionsCiReceiptV1(
  value: unknown,
  trustedClock: CiTrustedClock,
): CiQueueReceiptV1 {
  const input = exactRecord(
    value,
    bundleKeys,
    "GitHub Actions CI receipt bundle",
  );
  if (input.version !== GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1) {
    throw new RangeError("GitHub Actions CI receipt bundle version is unsupported");
  }

  const repository = repositoryName(input.repository);
  const receivedAt = timestamp(input.receivedAt, "GitHub Actions receipt time");
  const workflowRevision = commitSha(
    input.workflowRevision,
    "GitHub Actions workflow revision",
  );
  const validationProfile = closed(
    input.validationProfile,
    GITHUB_ACTIONS_CI_VALIDATION_PROFILES,
    "GitHub Actions validation profile",
  );
  const supersededByRevision = nullableCommitSha(
    input.supersededByRevision,
    "GitHub Actions superseding revision",
  );
  const run = parseRun(input.run);
  const jobs = exactArray(input.jobs, "GitHub Actions CI jobs", 3, 3)
    .map((entry) => parseJob(entry, run));
  requireUnique(
    jobs.map((job) => String(job.id)),
    "GitHub Actions CI jobs must have unique IDs",
  );
  requireUnique(
    jobs.map((job) => job.name),
    "GitHub Actions CI jobs must have unique canonical names",
  );
  requireCanonicalJobSet(jobs);
  validateProfileTopology(run.event, run.conclusion, validationProfile, jobs);

  const artifacts = exactArray(
    input.diagnosticsArtifacts,
    "GitHub Actions diagnostics artifacts",
    0,
    allowedArtifactNames.length,
  ).map((entry) => parseArtifact(entry, run.id));
  requireUnique(
    artifacts.map((artifact) => artifact.name),
    "GitHub Actions diagnostics artifacts must have unique names",
  );
  validateDiagnosticsArtifacts(jobs, artifacts);

  const identity = runIdentity(run, workflowRevision);
  if (supersededByRevision !== null && run.event !== "pull_request") {
    throw new RangeError("Only pull-request CI may carry a superseding revision");
  }

  return compileCiQueueReceiptV1({
    version: CI_QUEUE_RECEIPT_V1,
    repository,
    workflowName: GITHUB_ACTIONS_CI_WORKFLOW_NAME,
    workflowRunId: run.id,
    workflowAttempt: run.attempt,
    event: run.event,
    pullRequestNumber: identity.pullRequestNumber,
    candidateRevision: identity.candidateRevision,
    baseRevision: identity.baseRevision,
    workflowRevision,
    validationProfile,
    commandIds: [...CI_CANONICAL_COMMAND_IDS_V1],
    concurrencyGroup: concurrencyGroup(
      repository,
      run.event,
      identity.pullRequestNumber,
      identity.candidateRevision,
      validationProfile,
    ),
    supersededByRevision,
    createdAt: run.createdAt,
    observedAt: receivedAt,
    completedAt: run.completedAt,
    status: "completed",
    conclusion: run.conclusion,
    jobs: jobs.map((job) => ({
      jobId: job.id,
      name: job.name,
      requestedLabels: job.labels,
      status: "completed" as const,
      conclusion: job.conclusion,
      queuedAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      runnerOs: null,
      runnerArch: null,
      runnerImage: null,
      failedStep: job.conclusion === "failure"
        ? failedStep(job.steps)
        : null,
      diagnosticsFingerprint: job.conclusion === "failure"
        ? diagnosticsFingerprint(job.name, artifacts)
        : null,
    })),
  }, trustedClock);
}

interface ParsedRun {
  readonly id: number;
  readonly attempt: number;
  readonly event: typeof allowedEvents[number];
  readonly conclusion: CiRunConclusion;
  readonly headSha: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly pullRequests: readonly ParsedPullRequest[];
}

interface ParsedPullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
}

interface ParsedJob {
  readonly id: number;
  readonly name: typeof GITHUB_ACTIONS_CI_JOB_NAMES[number];
  readonly conclusion: CiJobConclusion;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string;
  readonly labels: string[];
  readonly steps: ParsedStep[];
}

interface ParsedStep {
  readonly number: number;
  readonly name: string;
  readonly conclusion: CiJobConclusion;
}

interface ParsedArtifact {
  readonly name: typeof allowedArtifactNames[number];
  readonly digest: string;
}

function parseRun(value: unknown): ParsedRun {
  const input = exactRecord(value, runKeys, "GitHub Actions completed run");
  if (input.name !== GITHUB_ACTIONS_CI_WORKFLOW_NAME) {
    throw new RangeError("GitHub Actions completed run has the wrong workflow name");
  }
  if (input.path !== GITHUB_ACTIONS_CI_WORKFLOW_PATH) {
    throw new RangeError("GitHub Actions completed run has the wrong workflow path");
  }
  if (input.status !== "completed") {
    throw new RangeError("GitHub Actions completed run must be terminal");
  }
  const id = positiveInteger(input.id, "GitHub Actions workflow run ID");
  const event = closed(input.event, allowedEvents, "GitHub Actions run event");
  const conclusion = closed(
    input.conclusion,
    CI_RUN_CONCLUSIONS,
    "GitHub Actions run conclusion",
  );
  const headSha = commitSha(input.headSha, "GitHub Actions run head revision");
  const createdAt = timestamp(input.createdAt, "GitHub Actions run creation time");
  const completedAt = timestamp(input.completedAt, "GitHub Actions run completion time");
  if (Date.parse(completedAt) < Date.parse(createdAt)) {
    throw new RangeError("GitHub Actions run completion cannot precede creation");
  }
  const pullRequests = exactArray(
    input.pullRequests,
    "GitHub Actions run pull requests",
    event === "pull_request" ? 1 : 0,
    event === "pull_request" ? 1 : 0,
  ).map(parsePullRequest);
  return {
    id,
    attempt: positiveInteger(input.attempt, "GitHub Actions workflow attempt"),
    event,
    conclusion,
    headSha,
    createdAt,
    completedAt,
    pullRequests,
  };
}

function parsePullRequest(value: unknown): ParsedPullRequest {
  const input = exactRecord(
    value,
    pullRequestKeys,
    "GitHub Actions run pull request",
  );
  return {
    number: positiveInteger(input.number, "GitHub Actions pull request number"),
    headSha: commitSha(
      input.headSha,
      "GitHub Actions pull request head revision",
    ),
    baseSha: commitSha(
      input.baseSha,
      "GitHub Actions pull request base revision",
    ),
  };
}

function parseJob(value: unknown, run: ParsedRun): ParsedJob {
  const input = exactRecord(value, jobKeys, "GitHub Actions completed job");
  if (input.status !== "completed") {
    throw new RangeError("GitHub Actions completed job must be terminal");
  }
  const runId = positiveInteger(input.runId, "GitHub Actions job run ID");
  if (runId !== run.id) {
    throw new RangeError("GitHub Actions job belongs to another workflow run");
  }
  const runAttempt = positiveInteger(
    input.runAttempt,
    "GitHub Actions job run attempt",
  );
  if (runAttempt !== run.attempt) {
    throw new RangeError("GitHub Actions job belongs to another workflow attempt");
  }
  if (input.workflowName !== GITHUB_ACTIONS_CI_WORKFLOW_NAME) {
    throw new RangeError("GitHub Actions job has the wrong workflow name");
  }
  const headSha = commitSha(input.headSha, "GitHub Actions job head revision");
  if (headSha !== run.headSha) {
    throw new RangeError("GitHub Actions job head revision does not match its run");
  }
  const name = closed(
    input.name,
    GITHUB_ACTIONS_CI_JOB_NAMES,
    "GitHub Actions canonical job name",
  );
  const conclusion = closed(
    input.conclusion,
    CI_JOB_CONCLUSIONS,
    "GitHub Actions job conclusion",
  );
  const createdAt = timestamp(input.createdAt, "GitHub Actions job creation time");
  const startedAt = nullableTimestamp(
    input.startedAt,
    "GitHub Actions job start time",
  );
  const completedAt = timestamp(
    input.completedAt,
    "GitHub Actions job completion time",
  );
  const createdMilliseconds = Date.parse(createdAt);
  const startedMilliseconds = startedAt === null ? null : Date.parse(startedAt);
  const completedMilliseconds = Date.parse(completedAt);
  if (
    createdMilliseconds < Date.parse(run.createdAt)
    || completedMilliseconds > Date.parse(run.completedAt)
    || completedMilliseconds < createdMilliseconds
    || (startedMilliseconds !== null
      && (startedMilliseconds < createdMilliseconds
        || completedMilliseconds < startedMilliseconds))
  ) {
    throw new RangeError("GitHub Actions job timing is outside its workflow run");
  }
  const labels = exactArray(
    input.labels,
    "GitHub Actions job labels",
    1,
    20,
  ).map((entry) => identifier(entry, "GitHub Actions job label", 120));
  requireUnique(labels, "GitHub Actions job labels must be unique");
  const steps = exactArray(
    input.steps,
    "GitHub Actions job steps",
    0,
    100,
  ).map(parseStep).sort((left, right) => left.number - right.number);
  requireUnique(
    steps.map((step) => String(step.number)),
    "GitHub Actions job steps must have unique numbers",
  );
  if (
    conclusion !== "failure"
    && steps.some((step) => step.conclusion === "failure")
  ) {
    throw new RangeError(
      "GitHub Actions non-failed job cannot contain a failed step",
    );
  }
  return {
    id: positiveInteger(input.id, "GitHub Actions job ID"),
    name,
    conclusion,
    createdAt,
    startedAt,
    completedAt,
    labels,
    steps,
  };
}

function parseStep(value: unknown): ParsedStep {
  const input = exactRecord(value, stepKeys, "GitHub Actions completed step");
  if (input.status !== "completed") {
    throw new RangeError("GitHub Actions completed step must be terminal");
  }
  return {
    number: positiveInteger(input.number, "GitHub Actions step number"),
    name: displayText(input.name, "GitHub Actions step name", 240),
    conclusion: closed(
      input.conclusion,
      CI_JOB_CONCLUSIONS,
      "GitHub Actions step conclusion",
    ),
  };
}

function parseArtifact(value: unknown, runId: number): ParsedArtifact {
  const input = exactRecord(
    value,
    artifactKeys,
    "GitHub Actions diagnostics artifact",
  );
  if (
    positiveInteger(input.workflowRunId, "GitHub Actions artifact run ID")
      !== runId
  ) {
    throw new RangeError("GitHub Actions diagnostics artifact belongs to another run");
  }
  return {
    name: closed(
      input.name,
      allowedArtifactNames,
      "GitHub Actions diagnostics artifact name",
    ),
    digest: sha256(input.digest, "GitHub Actions diagnostics artifact digest"),
  };
}

function runIdentity(run: ParsedRun, workflowRevision: string): {
  candidateRevision: string;
  baseRevision: string | null;
  pullRequestNumber: number | null;
} {
  if (run.event === "pull_request") {
    const pullRequest = run.pullRequests[0]!;
    if (run.headSha !== pullRequest.headSha) {
      throw new RangeError(
        "GitHub Actions pull request run head does not match the pull request head",
      );
    }
    if (workflowRevision !== pullRequest.baseSha) {
      throw new RangeError(
        "GitHub Actions pull request workflow revision must equal its base revision",
      );
    }
    return {
      candidateRevision: pullRequest.headSha,
      baseRevision: pullRequest.baseSha,
      pullRequestNumber: pullRequest.number,
    };
  }
  if (workflowRevision !== run.headSha) {
    throw new RangeError(
      "GitHub Actions non-pull-request workflow revision must equal the run head",
    );
  }
  return {
    candidateRevision: run.headSha,
    baseRevision: null,
    pullRequestNumber: null,
  };
}

function requireCanonicalJobSet(jobs: readonly ParsedJob[]): void {
  const names = new Set(jobs.map((job) => job.name));
  if (GITHUB_ACTIONS_CI_JOB_NAMES.some((name) => !names.has(name))) {
    throw new RangeError("GitHub Actions CI run requires every canonical job record");
  }
}

function validateProfileTopology(
  event: ParsedRun["event"],
  runConclusion: CiRunConclusion,
  profile: GitHubActionsCiValidationProfile,
  jobs: readonly ParsedJob[],
): void {
  if (event !== "workflow_dispatch" && profile !== "full_parallel") {
    throw new RangeError(
      "Only manually dispatched CI may use the serial validation profile",
    );
  }
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const test = byName.get("test")!;
  const parity = byName.get("runtime-parity")!;
  const serial = byName.get("serial-full")!;
  if (profile === "full_parallel") {
    if (serial.conclusion !== "skipped") {
      throw new RangeError(
        "Full-parallel CI requires the serial job to be skipped",
      );
    }
    if (
      runConclusion === "success"
      && (test.conclusion === "skipped" || parity.conclusion === "skipped")
    ) {
      throw new RangeError(
        "Successful full-parallel CI requires both parallel jobs",
      );
    }
    return;
  }
  if (test.conclusion !== "skipped" || parity.conclusion !== "skipped") {
    throw new RangeError(
      "Serial-full CI requires both parallel jobs to be skipped",
    );
  }
  if (runConclusion === "success" && serial.conclusion === "skipped") {
    throw new RangeError("Successful serial-full CI requires the serial job");
  }
}

function failedStep(steps: readonly ParsedStep[]): string {
  return steps.find((step) => step.conclusion === "failure")?.name
    ?? fallbackFailedStep;
}

function validateDiagnosticsArtifacts(
  jobs: readonly ParsedJob[],
  artifacts: readonly ParsedArtifact[],
): void {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  for (const artifact of artifacts) {
    const jobName = artifact.name === "diagnostics"
      ? "test"
      : artifact.name === "runtime-parity-diagnostics"
      ? "runtime-parity"
      : "serial-full";
    if (byName.get(jobName)?.conclusion !== "failure") {
      throw new RangeError(
        "GitHub Actions diagnostics artifact requires its failed canonical job",
      );
    }
  }
}

function diagnosticsFingerprint(
  jobName: ParsedJob["name"],
  artifacts: readonly ParsedArtifact[],
): string | null {
  const artifactName = jobName === "test"
    ? "diagnostics"
    : jobName === "runtime-parity"
    ? "runtime-parity-diagnostics"
    : "serial-full-diagnostics";
  return artifacts.find((artifact) => artifact.name === artifactName)?.digest
    ?? null;
}

function concurrencyGroup(
  repository: string,
  event: ParsedRun["event"],
  pullRequestNumber: number | null,
  candidateRevision: string,
  profile: GitHubActionsCiValidationProfile,
): string {
  if (event === "pull_request") {
    return `ci-${repository}-pr-${pullRequestNumber}`;
  }
  if (event === "workflow_dispatch") {
    return `ci-${repository}-dispatch-${candidateRevision}-${profile}`;
  }
  return `ci-${repository}-push-${candidateRevision}`;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(keys);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new RangeError(`${label} contains unknown fields`);
    }
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        `${label} fields must be enumerable data properties`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw new RangeError(`${label} is missing required fields`);
    }
  }
  return result;
}

function exactArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} must be a plain array`);
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (
    !Number.isSafeInteger(length)
    || length < minimum
    || length > maximum
  ) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} entries`,
    );
  }
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new RangeError(`${label} contains unsupported fields`);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new RangeError(`${label} must be dense`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        `${label} entries must be enumerable data properties`,
      );
    }
    result.push(descriptor.value);
  }
  return result;
}

function repositoryName(value: unknown): string {
  const result = displayText(value, "GitHub Actions repository", 201);
  if (result !== result.toLowerCase()) {
    throw new RangeError(
      "GitHub Actions repository must use exact lowercase identity",
    );
  }
  const [owner, name, extra] = result.split("/");
  if (
    extra !== undefined
    || owner === undefined
    || name === undefined
    || owner.includes("--")
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(owner)
    || !/^[a-z0-9](?:[a-z0-9_.-]{0,99})$/u.test(name)
  ) {
    throw new RangeError("GitHub Actions repository is invalid");
  }
  return result;
}

function displayText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || credentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string, maximum: number): string {
  const result = displayText(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(result)) {
    throw new RangeError(`${label} is invalid`);
  }
  return result;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const parsed = new Date(value);
  const milliseconds = parsed.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} must be a canonical timestamp`);
  }
  const canonical = parsed.toISOString();
  const expected = value.length === 20 ? value.replace(/Z$/u, ".000Z") : value;
  if (canonical !== expected) {
    throw new RangeError(`${label} must be a canonical timestamp`);
  }
  return canonical;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new RangeError(`${label} must be a lowercase full commit SHA`);
  }
  return value;
}

function nullableCommitSha(value: unknown, label: string): string | null {
  return value === null ? null : commitSha(value, label);
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function closed<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function requireUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new RangeError(message);
}
