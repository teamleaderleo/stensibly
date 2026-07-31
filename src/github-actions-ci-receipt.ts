import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  GITHUB_ACTIONS_CI_JOB_NAMES,
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
  type CiQueueReceiptV1,
  type CiRunConclusion,
  type CiTrustedClock,
} from "./ci-queue-receipt.js";

export {
  GITHUB_ACTIONS_CI_JOB_NAMES,
  GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
  GITHUB_ACTIONS_CI_VALIDATION_PROFILES,
  GITHUB_ACTIONS_CI_WORKFLOW_NAME,
  GITHUB_ACTIONS_CI_WORKFLOW_PATH,
};
export type { GitHubActionsCiValidationProfile };

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
    "(?:^|[._:/\\s-])sk-proj-[A-Za-z0-9_-]+",
    "(?:^|[._:/\\s-])sk-[A-Za-z0-9_-]{20,}",
    "(?:^|[._:/\\s-])xox[baprs]-[A-Za-z0-9-]{20,}",
    "(?:^|[._:/\\s-])bearer[\\t ]+[A-Za-z0-9._~+/-]{20,}={0,2}",
    "(?:^|[._:/\\s-])eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  ].join("|"),
  "iu",
);
const fallbackFailedStep = "GitHub Actions job failure";
const internalRepository = "receipt/ci-evidence";

interface PublicRun {
  readonly record: Record<string, unknown>;
  readonly id: number;
  readonly attempt: number;
  readonly event: typeof allowedEvents[number];
  readonly pullRequests: readonly Record<string, unknown>[];
}

interface PublicJob {
  readonly record: Record<string, unknown>;
  readonly id: number;
  readonly name: typeof GITHUB_ACTIONS_CI_JOB_NAMES[number];
  readonly conclusion: CiJobConclusion;
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
  const jobs = exactArray(input.jobs, "GitHub Actions CI jobs", 3, 3)
    .map((entry, index) => parseJob(entry, index));
  requireUnique(jobs.map((job) => String(job.id)), "GitHub Actions CI jobs must have unique IDs");
  requireUnique(jobs.map((job) => job.name), "GitHub Actions CI jobs must have unique canonical names");
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
    jobs: jobs.map((job, index) => cloneJob(job, index)),
    diagnosticsArtifacts: artifacts.map((artifact) => ({
      workflowRunId: artifact.record.workflowRunId,
      name: artifact.name,
      digest: artifact.record.digest,
    })),
  };
  const normalized = compileNormalizedReceipt(internalBundle, trustedClock);
  const originalJobs = new Map(jobs.map((job) => [job.id, job]));
  const restoredJobs = normalized.jobs.map((job) => {
    const original = originalJobs.get(job.jobId)!;
    return {
      ...job,
      requestedLabels: [...original.labels].sort(compare),
      failedStep: job.conclusion === "failure"
        ? original.steps.find((step) => step.conclusion === "failure")?.name
          ?? fallbackFailedStep
        : null,
    };
  });
  const { receiptFingerprint: ignored, ...normalizedSubject } = normalized;
  void ignored;
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
    jobs: restoredJobs,
  };
  return deepFreeze({
    ...subject,
    receiptFingerprint: fingerprintCanonicalRequest(subject),
  });
}

function parseRun(value: unknown): PublicRun {
  const record = exactRecord(value, runKeys, "GitHub Actions completed run");
  const event = closed(record.event, allowedEvents, "GitHub Actions run event");
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
    pullRequests,
  };
}

function parseJob(value: unknown, jobIndex: number): PublicJob {
  const record = exactRecord(value, jobKeys, "GitHub Actions completed job");
  const labels = exactArray(record.labels, "GitHub Actions job labels", 1, 20)
    .map((entry) => identifier(entry, "GitHub Actions job label", 120));
  requireUnique(labels, "GitHub Actions job labels must be unique");
  const steps = exactArray(record.steps, "GitHub Actions job steps", 0, 100)
    .map((entry, stepIndex) => parseStep(entry, jobIndex, stepIndex));
  if (record.startedAt === null && steps.length !== 0) {
    throw new RangeError("GitHub Actions unstarted job cannot contain completed steps");
  }
  return {
    record,
    id: positiveInteger(record.id, "GitHub Actions job ID"),
    name: closed(record.name, GITHUB_ACTIONS_CI_JOB_NAMES, "GitHub Actions canonical job name"),
    conclusion: closed(record.conclusion, CI_JOB_CONCLUSIONS, "GitHub Actions job conclusion"),
    labels,
    steps,
  };
}

function parseStep(value: unknown, _jobIndex: number, _stepIndex: number): PublicStep {
  const record = exactRecord(value, stepKeys, "GitHub Actions completed step");
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
  if (
    positiveInteger(record.workflowRunAttempt, "GitHub Actions artifact run attempt")
      !== run.attempt
  ) {
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
  return { record, workflowJobId, name };
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
