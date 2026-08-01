import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import { CI_BROWSER_EVIDENCE_TOPOLOGIES_V1 } from "./ci-browser-evidence-profile.js";
import {
  GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
  GITHUB_ACTIONS_CI_VALIDATION_PROFILES,
  GITHUB_ACTIONS_CI_WORKFLOW_NAME,
  GITHUB_ACTIONS_CI_WORKFLOW_PATH,
  compileGitHubActionsCiReceiptV1 as compileNormalizedReceipt,
  type GitHubActionsCiValidationProfile,
} from "./github-actions-ci-receipt-normalized.js";
import {
  CI_JOB_CONCLUSIONS,
  type CiJobConclusion,
  type CiJobReceiptV1,
  type CiQueueReceiptV1,
  type CiRunConclusion,
  type CiTrustedClock,
} from "./ci-queue-receipt.js";

export {
  GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
  GITHUB_ACTIONS_CI_VALIDATION_PROFILES,
  GITHUB_ACTIONS_CI_WORKFLOW_NAME,
  GITHUB_ACTIONS_CI_WORKFLOW_PATH,
};
export type { GitHubActionsCiValidationProfile };

export const GITHUB_ACTIONS_CI_JOB_NAMES = Object.freeze([
  CI_BROWSER_EVIDENCE_TOPOLOGIES_V1.full_parallel.jobName,
  "test",
  "runtime-parity",
  "serial-full",
] as const);

export interface GitHubActionsCiReceiptBundleV1 {
  readonly version: typeof GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1;
  readonly repository: string;
  readonly receivedAt: string;
  readonly workflowRevision: string;
  readonly validationProfile: GitHubActionsCiValidationProfile;
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
  readonly workflowRunAttempt: number;
  readonly workflowJobId: number;
  readonly name:
    | "diagnostics"
    | "runtime-parity-diagnostics"
    | "serial-full-diagnostics";
  readonly digest: string;
}

const bundleKeys = [
  "version", "repository", "receivedAt", "workflowRevision",
  "validationProfile", "run", "jobs", "diagnosticsArtifacts",
] as const;
const runKeys = [
  "id", "attempt", "name", "path", "event", "status", "conclusion",
  "headSha", "createdAt", "completedAt", "pullRequests",
] as const;
const pullRequestKeys = ["number", "headSha", "baseSha"] as const;
const jobKeys = [
  "id", "runId", "runAttempt", "headSha", "workflowName", "name",
  "status", "conclusion", "createdAt", "startedAt", "completedAt",
  "labels", "steps",
] as const;
const stepKeys = ["number", "name", "status", "conclusion"] as const;
const artifactKeys = [
  "workflowRunId", "workflowRunAttempt", "workflowJobId", "name", "digest",
] as const;
const allowedEvents = ["pull_request", "push", "workflow_dispatch"] as const;
const allowedArtifactNames = [
  "diagnostics", "runtime-parity-diagnostics", "serial-full-diagnostics",
] as const;
const realisticCredentialPattern = new RegExp(
  [
    "(?:^|[._:/\\s-])(?:env|secret):\\/\\/",
    "(?:^|[._:/\\s-])github_pat_[A-Za-z0-9_]{20,}",
    "(?:^|[._:/\\s-])gh[pousr]_[A-Za-z0-9]{20,}",
    "(?:^|[._:/\\s-])stn\\.tok_[A-Za-z0-9._-]{20,}",
    "(?:^|[._:/\\s-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}",
    "(?:^|[._:/\\s-])xox[baprs]-[A-Za-z0-9-]{20,}",
    "(?:^|[._:/\\s-])bearer[\\t ]+[A-Za-z0-9._~+/-]{20,}={0,2}",
    "(?:^|[._:/\\s-])eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  ].join("|"),
  "iu",
);
const internalRepository = "receipt/ci-evidence";
const browserJobName = CI_BROWSER_EVIDENCE_TOPOLOGIES_V1.full_parallel.jobName;
const failureEvidenceConclusions = new Set<CiRunConclusion>([
  "failure", "timed_out", "neutral",
]);

interface PublicRun {
  readonly record: Record<string, unknown>;
  readonly id: number;
  readonly attempt: number;
  readonly event: typeof allowedEvents[number];
  readonly conclusion: CiRunConclusion;
  readonly headSha: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly pullRequests: readonly Record<string, unknown>[];
}

interface PublicJob {
  readonly record: Record<string, unknown>;
  readonly id: number;
  readonly name: typeof GITHUB_ACTIONS_CI_JOB_NAMES[number];
  readonly conclusion: CiJobConclusion;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string;
  readonly labels: readonly string[];
  readonly steps: readonly PublicStep[];
}

interface PublicStep {
  readonly record: Record<string, unknown>;
  readonly name: string;
  readonly conclusion: CiJobConclusion;
}

interface PublicArtifact {
  readonly record: Record<string, unknown>;
  readonly workflowJobId: number;
  readonly name: typeof allowedArtifactNames[number];
}

export function compileGitHubActionsCiReceiptV1(
  value: unknown,
  trustedClock: CiTrustedClock,
): CiQueueReceiptV1 {
  const input = exactRecord(value, bundleKeys, "GitHub Actions CI receipt bundle");
  if (input.version !== GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1) {
    throw new RangeError("GitHub Actions CI receipt bundle version is unsupported");
  }
  const repository = repositoryName(input.repository);
  const workflowRevision = commitSha(
    input.workflowRevision,
    "GitHub Actions workflow revision",
  );
  const validationProfile = closed(
    input.validationProfile,
    GITHUB_ACTIONS_CI_VALIDATION_PROFILES,
    "GitHub Actions validation profile",
  );
  const run = parseRun(input.run);
  const jobs = exactArray(input.jobs, "GitHub Actions CI jobs", 4, 4)
    .map((entry, index) => parseJob(entry, index, run));
  requireUnique(jobs.map((job) => String(job.id)), "GitHub Actions CI jobs must have unique IDs");
  requireUnique(jobs.map((job) => job.name), "GitHub Actions CI jobs must have unique canonical names");
  requireCanonicalJobSet(jobs);
  validateProfileTopology(run, validationProfile, jobs);

  const artifacts = exactArray(
    input.diagnosticsArtifacts,
    "GitHub Actions diagnostics artifacts",
    0,
    allowedArtifactNames.length,
  ).map((entry) => parseArtifact(entry, run, jobs));
  requireUnique(
    artifacts.map((artifact) => artifact.name),
    "GitHub Actions diagnostics artifacts must have unique names",
  );

  const internalJobs = normalizedJobs(run, validationProfile, jobs);
  const internalWorkflowRevision = run.event === "pull_request"
    ? commitSha(
      run.pullRequests[0]?.baseSha,
      "GitHub Actions pull request base revision",
    )
    : workflowRevision;
  const internalBundle = {
    version: input.version,
    repository: internalRepository,
    receivedAt: input.receivedAt,
    workflowRevision: internalWorkflowRevision,
    validationProfile,
    supersededByRevision: null,
    run: cloneRun(run),
    jobs: internalJobs.map((job, index) => cloneJob(job, index)),
    diagnosticsArtifacts: artifacts.map((artifact) => ({
      workflowRunId: artifact.record.workflowRunId,
      name: artifact.name,
      digest: artifact.record.digest,
    })),
  };
  const normalized = compileNormalizedReceipt(internalBundle, trustedClock);
  const restoredJobs = jobs
    .map((job) => toReceiptJob(job, artifacts))
    .sort((left, right) => left.jobId - right.jobId);
  const started = restoredJobs
    .filter((job) => job.startedAt !== null)
    .sort((left, right) => Date.parse(left.startedAt!) - Date.parse(right.startedAt!))[0] ?? null;
  const firstJobStartedAt = started?.startedAt ?? null;
  const { receiptFingerprint: ignored, jobs: ignoredJobs, ...normalizedSubject } = normalized;
  void ignored;
  void ignoredJobs;
  const subject = {
    ...normalizedSubject,
    repository,
    workflowRevision,
    concurrencyGroup: concurrencyGroup(
      repository,
      normalized.event,
      normalized.pullRequestNumber,
      normalized.candidateRevision,
      normalized.validationProfile,
    ),
    supersededByRevision: null,
    commandIds: Object.freeze([
      ...normalized.commandIds,
      ...CI_BROWSER_EVIDENCE_TOPOLOGIES_V1[validationProfile].commandIds,
    ]),
    firstJobStartedAt,
    queueWaitMs: firstJobStartedAt === null
      ? null
      : Date.parse(firstJobStartedAt) - Date.parse(run.createdAt),
    jobs: restoredJobs,
  };
  return deepFreeze({
    ...subject,
    receiptFingerprint: fingerprintCanonicalRequest(subject),
  });
}

function parseRun(value: unknown): PublicRun {
  const record = exactRecord(value, runKeys, "GitHub Actions completed run");
  if (record.name !== GITHUB_ACTIONS_CI_WORKFLOW_NAME) {
    throw new RangeError("GitHub Actions completed run has the wrong workflow name");
  }
  if (record.path !== GITHUB_ACTIONS_CI_WORKFLOW_PATH) {
    throw new RangeError("GitHub Actions completed run has the wrong workflow path");
  }
  if (record.status !== "completed") {
    throw new RangeError("GitHub Actions completed run must be terminal");
  }
  const event = closed(record.event, allowedEvents, "GitHub Actions run event");
  const conclusion = closed(record.conclusion, CI_JOB_CONCLUSIONS, "GitHub Actions run conclusion");
  const createdAt = timestamp(record.createdAt, "GitHub Actions run creation time");
  const completedAt = timestamp(record.completedAt, "GitHub Actions run completion time");
  if (Date.parse(completedAt) < Date.parse(createdAt)) {
    throw new RangeError("GitHub Actions run completion cannot precede creation");
  }
  const pullRequests = exactArray(
    record.pullRequests,
    "GitHub Actions run pull requests",
    event === "pull_request" ? 1 : 0,
    event === "pull_request" ? 1 : 0,
  ).map((entry) => exactRecord(
    entry,
    pullRequestKeys,
    "GitHub Actions run pull request",
  ));
  return {
    record,
    id: positiveInteger(record.id, "GitHub Actions workflow run ID"),
    attempt: positiveInteger(record.attempt, "GitHub Actions workflow attempt"),
    event,
    conclusion,
    headSha: commitSha(record.headSha, "GitHub Actions run head revision"),
    createdAt,
    completedAt,
    pullRequests,
  };
}

function parseJob(value: unknown, jobIndex: number, run: PublicRun): PublicJob {
  const record = exactRecord(value, jobKeys, "GitHub Actions completed job");
  if (record.status !== "completed") {
    throw new RangeError("GitHub Actions completed job must be terminal");
  }
  if (positiveInteger(record.runId, "GitHub Actions job run ID") !== run.id) {
    throw new RangeError("GitHub Actions job belongs to another workflow run");
  }
  if (positiveInteger(record.runAttempt, "GitHub Actions job run attempt") !== run.attempt) {
    throw new RangeError("GitHub Actions job belongs to another workflow attempt");
  }
  if (record.workflowName !== GITHUB_ACTIONS_CI_WORKFLOW_NAME) {
    throw new RangeError("GitHub Actions job has the wrong workflow name");
  }
  if (commitSha(record.headSha, "GitHub Actions job head revision") !== run.headSha) {
    throw new RangeError("GitHub Actions job head revision does not match its run");
  }
  const name = closed(
    record.name,
    GITHUB_ACTIONS_CI_JOB_NAMES,
    "GitHub Actions canonical job name",
  );
  const conclusion = closed(
    record.conclusion,
    CI_JOB_CONCLUSIONS,
    "GitHub Actions job conclusion",
  );
  const createdAt = timestamp(record.createdAt, "GitHub Actions job creation time");
  const startedAt = nullableTimestamp(record.startedAt, "GitHub Actions job start time");
  const completedAt = timestamp(record.completedAt, "GitHub Actions job completion time");
  const createdMs = Date.parse(createdAt);
  const startedMs = startedAt === null ? null : Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (
    createdMs < Date.parse(run.createdAt)
    || completedMs > Date.parse(run.completedAt)
    || completedMs < createdMs
    || (startedMs !== null && (startedMs < createdMs || completedMs < startedMs))
  ) {
    throw new RangeError("GitHub Actions job timing is outside its workflow run");
  }
  const labels = exactArray(record.labels, "GitHub Actions job labels", 1, 20)
    .map((entry) => identifier(entry, "GitHub Actions job label", 120));
  requireUnique(labels, "GitHub Actions job labels must be unique");
  const steps = exactArray(record.steps, "GitHub Actions job steps", 0, 100)
    .map((entry, stepIndex) => parseStep(entry, jobIndex, stepIndex));
  if (startedAt === null && steps.length !== 0) {
    throw new RangeError("GitHub Actions unstarted job cannot contain completed steps");
  }
  if (conclusion !== "failure" && steps.some((step) => step.conclusion === "failure")) {
    throw new RangeError("GitHub Actions non-failed job cannot contain a failed step");
  }
  return {
    record,
    id: positiveInteger(record.id, "GitHub Actions job ID"),
    name,
    conclusion,
    createdAt,
    startedAt,
    completedAt,
    labels,
    steps,
  };
}

function parseStep(value: unknown, _jobIndex: number, _stepIndex: number): PublicStep {
  const record = exactRecord(value, stepKeys, "GitHub Actions completed step");
  if (record.status !== "completed") {
    throw new RangeError("GitHub Actions completed step must be terminal");
  }
  return {
    record,
    name: displayText(record.name, "GitHub Actions step name", 240),
    conclusion: closed(record.conclusion, CI_JOB_CONCLUSIONS, "GitHub Actions step conclusion"),
  };
}

function parseArtifact(
  value: unknown,
  run: PublicRun,
  jobs: readonly PublicJob[],
): PublicArtifact {
  const record = exactRecord(value, artifactKeys, "GitHub Actions diagnostics artifact");
  if (positiveInteger(record.workflowRunId, "GitHub Actions artifact run ID") !== run.id) {
    throw new RangeError("GitHub Actions diagnostics artifact belongs to another run");
  }
  if (positiveInteger(record.workflowRunAttempt, "GitHub Actions artifact run attempt") !== run.attempt) {
    throw new RangeError("GitHub Actions diagnostics artifact belongs to another run attempt");
  }
  const name = closed(
    record.name,
    allowedArtifactNames,
    "GitHub Actions diagnostics artifact name",
  );
  const jobName = name === "diagnostics"
    ? "test"
    : name === "runtime-parity-diagnostics"
    ? "runtime-parity"
    : "serial-full";
  const job = jobs.find((candidate) => candidate.name === jobName);
  if (job?.conclusion !== "failure") {
    throw new RangeError("GitHub Actions diagnostics artifact requires its failed canonical job");
  }
  const workflowJobId = positiveInteger(record.workflowJobId, "GitHub Actions artifact job ID");
  if (workflowJobId !== job.id) {
    throw new RangeError("GitHub Actions diagnostics artifact belongs to another workflow job");
  }
  sha256(record.digest, "GitHub Actions diagnostics artifact digest");
  return { record, workflowJobId, name };
}

function requireCanonicalJobSet(jobs: readonly PublicJob[]): void {
  const names = new Set(jobs.map((job) => job.name));
  if (GITHUB_ACTIONS_CI_JOB_NAMES.some((name) => !names.has(name))) {
    throw new RangeError("GitHub Actions CI run requires every canonical job record");
  }
}

function validateProfileTopology(
  run: PublicRun,
  profile: GitHubActionsCiValidationProfile,
  jobs: readonly PublicJob[],
): void {
  if (run.event !== "workflow_dispatch" && profile !== "full_parallel") {
    throw new RangeError("Only manually dispatched CI may use the serial validation profile");
  }
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const browser = byName.get(browserJobName)!;
  const test = byName.get("test")!;
  const parity = byName.get("runtime-parity")!;
  const serial = byName.get("serial-full")!;
  if (profile === "full_parallel") {
    if (run.event !== "pull_request" && serial.conclusion !== "skipped") {
      throw new RangeError("Non-pull-request full-parallel CI requires the serial job to be skipped");
    }
    if (
      run.conclusion === "success"
      && [browser, test, parity, ...(run.event === "pull_request" ? [serial] : [])]
        .some((job) => job.conclusion === "skipped")
    ) {
      throw new RangeError("Successful full-parallel CI requires every active-profile job");
    }
    if (failureEvidenceConclusions.has(run.conclusion)) {
      const active = run.event === "pull_request"
        ? [browser, test, parity, serial]
        : [browser, test, parity];
      if (!active.some((job) => job.conclusion === run.conclusion)) {
        throw new RangeError("Terminal full-parallel CI requires positive active-profile failure evidence");
      }
    }
    return;
  }
  if (
    browser.conclusion !== "skipped"
    || test.conclusion !== "skipped"
    || parity.conclusion !== "skipped"
  ) {
    throw new RangeError("Serial-full CI requires every parallel job to be skipped");
  }
  if (run.conclusion === "success" && serial.conclusion === "skipped") {
    throw new RangeError("Successful serial-full CI requires the serial job");
  }
  if (
    failureEvidenceConclusions.has(run.conclusion)
    && serial.conclusion !== run.conclusion
  ) {
    throw new RangeError("Terminal serial-full CI requires positive serial failure evidence");
  }
}

function normalizedJobs(
  run: PublicRun,
  profile: GitHubActionsCiValidationProfile,
  jobs: readonly PublicJob[],
): PublicJob[] {
  const selected = jobs.filter((job) => job.name !== browserJobName);
  if (profile === "full_parallel" && run.event === "pull_request") {
    return selected.map((job) => job.name === "serial-full"
      ? syntheticSkippedJob(job)
      : job);
  }
  return selected;
}

function syntheticSkippedJob(job: PublicJob): PublicJob {
  const record = {
    ...job.record,
    conclusion: "skipped",
    startedAt: null,
    completedAt: job.createdAt,
    steps: [],
  };
  return {
    ...job,
    record,
    conclusion: "skipped",
    startedAt: null,
    completedAt: job.createdAt,
    steps: [],
  };
}

function cloneRun(run: PublicRun): Record<string, unknown> {
  return {
    ...run.record,
    pullRequests: run.pullRequests.map((pullRequest) => ({ ...pullRequest })),
  };
}

function cloneJob(job: PublicJob, jobIndex: number): Record<string, unknown> {
  return {
    ...job.record,
    labels: job.labels.map((_label, labelIndex) => `label${jobIndex + 1}-${labelIndex + 1}`),
    steps: job.steps.map((step, stepIndex) => ({
      ...step.record,
      name: `Step ${jobIndex + 1}.${stepIndex + 1}`,
    })),
  };
}

function toReceiptJob(
  job: PublicJob,
  artifacts: readonly PublicArtifact[],
): CiJobReceiptV1 {
  const startedMs = job.startedAt === null ? null : Date.parse(job.startedAt);
  const completedMs = Date.parse(job.completedAt);
  return {
    jobId: job.id,
    name: job.name,
    requestedLabels: Object.freeze([...job.labels].sort(compare)),
    status: "completed",
    conclusion: job.conclusion,
    queuedAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    queueWaitMs: startedMs === null ? null : startedMs - Date.parse(job.createdAt),
    durationMs: startedMs === null ? null : completedMs - startedMs,
    runnerOs: null,
    runnerArch: null,
    runnerImage: null,
    failedStep: job.conclusion === "failure"
      ? job.steps.find((step) => step.conclusion === "failure")?.name
        ?? "GitHub Actions job failure"
      : null,
    diagnosticsFingerprint: diagnosticsFingerprint(job.name, artifacts),
  };
}

function diagnosticsFingerprint(
  jobName: PublicJob["name"],
  artifacts: readonly PublicArtifact[],
): string | null {
  if (jobName === browserJobName) return null;
  const artifactName = jobName === "test"
    ? "diagnostics"
    : jobName === "runtime-parity"
    ? "runtime-parity-diagnostics"
    : "serial-full-diagnostics";
  return artifacts.find((artifact) => artifact.name === artifactName)?.record.digest as string | undefined
    ?? null;
}

function concurrencyGroup(
  repository: string,
  event: CiQueueReceiptV1["event"],
  pullRequestNumber: number | null,
  candidateRevision: string,
  profile: string,
): string {
  if (event === "pull_request") return `ci-${repository}-pr-${pullRequestNumber}`;
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
      throw new RangeError(`${label} fields must be enumerable data properties`);
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
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) {
    throw new RangeError(`${label} must contain between ${minimum} and ${maximum} entries`);
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
      throw new RangeError(`${label} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function repositoryName(value: unknown): string {
  const repository = displayText(value, "GitHub Actions repository", 201);
  if (repository !== repository.toLowerCase()) {
    throw new RangeError("GitHub Actions repository must use exact lowercase identity");
  }
  const [owner, name, extra] = repository.split("/");
  if (
    extra !== undefined || owner === undefined || name === undefined
    || owner.includes("--")
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(owner)
    || !/^[a-z0-9](?:[a-z0-9_.-]{0,99})$/u.test(name)
  ) throw new RangeError("GitHub Actions repository is invalid");
  return repository;
}

function displayText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || !value || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
    || realisticCredentialPattern.test(value)
  ) throw new RangeError(`${label} is invalid`);
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
  ) throw new RangeError(`${label} must be an ISO UTC timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`${label} must be a canonical timestamp`);
  }
  const canonical = date.toISOString();
  const expected = value.length === 20 ? value.replace(/Z$/u, ".000Z") : value;
  if (canonical !== expected) throw new RangeError(`${label} must be a canonical timestamp`);
  return canonical;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new RangeError(`${label} must be a lowercase full commit SHA`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
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

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
