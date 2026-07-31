import type { GitHubDelegatedReadReceipt } from "./github-delegated-read.js";
import {
  admitHostedGitHubRepositoryObservationInput,
} from "./github-repository-observation-admission.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export const GITHUB_PULL_REQUEST_RECONCILIATION_V1 = 1 as const;

export const githubPullRequestReconciliationStates = [
  "matched",
  "provider_ahead",
  "observation_ahead",
  "conflicted",
  "missing_observation",
  "invalid_evidence",
] as const;

export type GitHubPullRequestReconciliationState =
  typeof githubPullRequestReconciliationStates[number];

export type GitHubPullRequestReconciliationReason =
  | "states_match"
  | "provider_newer"
  | "observation_newer"
  | "same_time_divergence"
  | "observation_missing"
  | "identity_mismatch";

export interface GitHubPullRequestReconciliationInputV1 {
  readonly version: typeof GITHUB_PULL_REQUEST_RECONCILIATION_V1;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly observation: GitHubRepositoryObservation | null;
  readonly providerRead: GitHubDelegatedReadReceipt;
  readonly reconciledAt: string;
}

export interface GitHubPullRequestReconciliationResultV1 {
  readonly version: typeof GITHUB_PULL_REQUEST_RECONCILIATION_V1;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly state: GitHubPullRequestReconciliationState;
  readonly reason: GitHubPullRequestReconciliationReason;
  readonly observationId: string | null;
  readonly observationFingerprint: string | null;
  readonly observationStateFingerprint: string | null;
  readonly observationUpdatedAt: string | null;
  readonly providerBindingId: string;
  readonly providerParametersSha256: string;
  readonly providerRequestId: string | null;
  readonly providerResultSha256: string;
  readonly providerStateFingerprint: string;
  readonly providerUpdatedAt: string;
  readonly reconciledAt: string;
  readonly authorizesMutation: false;
  readonly authorizesProviderWrite: false;
  readonly reconciliationFingerprint: string;
}

export type GitHubPullRequestReconciliationClock = () => Date;

interface ComparablePullRequestState {
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeCommitSha: string | null;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly locked: boolean;
  readonly merged: boolean;
}

interface ParsedObservation {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly observationId: string;
  readonly semanticFingerprint: string;
  readonly sourceTime: string;
  readonly receivedAt: string;
  readonly comparable: ComparablePullRequestState;
}

interface ParsedProviderRead {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly identityConsistent: boolean;
  readonly bindingId: string;
  readonly parametersSha256: string;
  readonly providerRequestId: string | null;
  readonly resultSha256: string;
  readonly updatedAt: string;
  readonly comparable: ComparablePullRequestState;
}

const inputKeys = [
  "version",
  "repository",
  "pullRequestNumber",
  "observation",
  "providerRead",
  "reconciledAt",
] as const;

const delegatedReceiptKeys = [
  "version",
  "project",
  "repositoryFullName",
  "tool",
  "actorId",
  "clientId",
  "connectionId",
  "installationId",
  "bindingId",
  "attachmentId",
  "attachmentSnapshotSha256",
  "capabilityGrantId",
  "approvalId",
  "catalogueFingerprint",
  "parametersSha256",
  "providerRequestId",
  "resultSha256",
  "result",
] as const;

const providerResultKeys = [
  "repositoryFullName",
  "number",
  "id",
  "nodeId",
  "state",
  "draft",
  "locked",
  "merged",
  "title",
  "authorLogin",
  "headRepositoryFullName",
  "headSha",
  "headRef",
  "baseSha",
  "baseRef",
  "mergeCommitSha",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "additions",
  "deletions",
  "changedFiles",
  "commits",
  "reviewComments",
  "comments",
] as const;

const repositoryPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,99})$/u;
const fullRevisionPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const providerRequestPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export function compileGitHubPullRequestReconciliationV1(
  value: unknown,
  trustedClock: GitHubPullRequestReconciliationClock,
): GitHubPullRequestReconciliationResultV1 {
  const input = exactRecord(
    value,
    inputKeys,
    "GitHub pull request reconciliation input",
  );
  if (input.version !== GITHUB_PULL_REQUEST_RECONCILIATION_V1) {
    throw new RangeError(
      "GitHub pull request reconciliation version is unsupported",
    );
  }

  const repository = repositoryName(input.repository);
  const pullRequestNumber = positiveInteger(
    input.pullRequestNumber,
    "GitHub pull request reconciliation number",
  );
  const reconciledAt = timestamp(
    input.reconciledAt,
    "GitHub pull request reconciliation time",
  );
  attestTrustedTime(trustedClock, reconciledAt);

  const observation = input.observation === null
    ? null
    : parseObservation(input.observation);
  const provider = parseProviderRead(input.providerRead);

  if (
    Date.parse(provider.updatedAt) > Date.parse(reconciledAt)
    || (observation !== null
      && Date.parse(observation.receivedAt) > Date.parse(reconciledAt))
  ) {
    throw new RangeError(
      "GitHub pull request evidence follows the reconciliation time",
    );
  }

  const identityMatches = provider.identityConsistent
    && provider.repository === repository
    && provider.pullRequestNumber === pullRequestNumber
    && (observation === null
      || (observation.repository === repository
        && observation.pullRequestNumber === pullRequestNumber));

  const observationStateFingerprint = observation === null
    ? null
    : fingerprintCanonicalRequest(observation.comparable);
  const providerStateFingerprint =
    fingerprintCanonicalRequest(provider.comparable);

  const verdict = !identityMatches
    ? {
      state: "invalid_evidence" as const,
      reason: "identity_mismatch" as const,
    }
    : observation === null
    ? {
      state: "missing_observation" as const,
      reason: "observation_missing" as const,
    }
    : observationStateFingerprint === providerStateFingerprint
    ? {
      state: "matched" as const,
      reason: "states_match" as const,
    }
    : Date.parse(provider.updatedAt) > Date.parse(observation.sourceTime)
    ? {
      state: "provider_ahead" as const,
      reason: "provider_newer" as const,
    }
    : Date.parse(observation.sourceTime) > Date.parse(provider.updatedAt)
    ? {
      state: "observation_ahead" as const,
      reason: "observation_newer" as const,
    }
    : {
      state: "conflicted" as const,
      reason: "same_time_divergence" as const,
    };

  const subject = {
    version: GITHUB_PULL_REQUEST_RECONCILIATION_V1,
    repository,
    pullRequestNumber,
    state: verdict.state,
    reason: verdict.reason,
    observationId: observation?.observationId ?? null,
    observationFingerprint: observation?.semanticFingerprint ?? null,
    observationStateFingerprint,
    observationUpdatedAt: observation?.sourceTime ?? null,
    providerBindingId: provider.bindingId,
    providerParametersSha256: provider.parametersSha256,
    providerRequestId: provider.providerRequestId,
    providerResultSha256: provider.resultSha256,
    providerStateFingerprint,
    providerUpdatedAt: provider.updatedAt,
    reconciledAt,
    authorizesMutation: false as const,
    authorizesProviderWrite: false as const,
  };

  return deepFreeze({
    ...subject,
    reconciliationFingerprint: fingerprintCanonicalRequest(subject),
  });
}

function parseObservation(value: unknown): ParsedObservation {
  const outer = exactRecord(
    value,
    [
      "version",
      "provider",
      "sourceSchema",
      "sourceSchemaVersion",
      "observationId",
      "deliveryId",
      "payloadDigest",
      "semanticFingerprint",
      "eventType",
      "action",
      "repository",
      "actor",
      "subject",
      "relationships",
      "facts",
      "contentRevisions",
      "sourceTime",
      "sourceTimeSource",
      "receivedAt",
      "containsRawContent",
    ],
    "GitHub pull request observation",
  );
  const admitted = admitHostedGitHubRepositoryObservationInput({
    deliveryId: outer.deliveryId,
    eventType: outer.eventType,
    observation: value,
    payloadDigest: outer.payloadDigest,
    receivedAt: outer.receivedAt,
  });
  const observation = admitted.observation;
  if (
    observation.eventType !== "pull_request"
    || observation.subject.kind !== "pull_request"
    || observation.sourceTimeSource !== "provider"
  ) {
    throw new RangeError(
      "GitHub pull request reconciliation requires provider-timed pull_request evidence",
    );
  }

  const pullRequestNumber = positiveInteger(
    observation.relationships.pullRequestNumber,
    "GitHub pull request observation number",
  );
  if (
    observation.relationships.issueNumber !== pullRequestNumber
    || observation.subject.externalId
      !== `github:${observation.repository}#pull/${pullRequestNumber}`
  ) {
    throw new RangeError(
      "GitHub pull request observation identity is inconsistent",
    );
  }

  return {
    repository: repositoryName(observation.repository),
    pullRequestNumber,
    observationId: boundedIdentity(
      observation.observationId,
      "GitHub pull request observation ID",
    ),
    semanticFingerprint: fingerprint(
      observation.semanticFingerprint,
      "GitHub pull request observation fingerprint",
    ),
    sourceTime: timestamp(
      observation.sourceTime,
      "GitHub pull request observation source time",
    ),
    receivedAt: timestamp(
      observation.receivedAt,
      "GitHub pull request observation received time",
    ),
    comparable: comparableState({
      headSha: observation.relationships.revision,
      baseSha: observation.relationships.baseRevision,
      mergeCommitSha: observation.relationships.mergeRevision,
      state: observation.facts.state,
      draft: observation.facts.draft,
      locked: observation.facts.locked,
      merged: observation.facts.merged,
    }, "GitHub pull request observation"),
  };
}

function parseProviderRead(value: unknown): ParsedProviderRead {
  const receipt = exactRecord(
    value,
    delegatedReceiptKeys,
    "GitHub delegated read receipt",
  );
  if (receipt.version !== 1 || receipt.tool !== "get_pr_info") {
    throw new RangeError(
      "GitHub pull request reconciliation requires a get_pr_info receipt",
    );
  }

  const receiptRepository = repositoryName(receipt.repositoryFullName);
  text(receipt.project, "GitHub delegated project", 120);
  text(receipt.actorId, "GitHub delegated actor ID", 120);
  text(receipt.clientId, "GitHub delegated client ID", 240);
  text(receipt.connectionId, "GitHub delegated connection ID", 240);
  text(receipt.installationId, "GitHub delegated installation ID", 64);
  const bindingId = boundedIdentity(
    receipt.bindingId,
    "GitHub delegated binding ID",
  );
  text(receipt.attachmentId, "GitHub delegated attachment ID", 240);
  fingerprint(
    receipt.attachmentSnapshotSha256,
    "GitHub delegated attachment fingerprint",
  );
  nullableIdentity(
    receipt.capabilityGrantId,
    "GitHub delegated capability grant ID",
  );
  nullableIdentity(receipt.approvalId, "GitHub delegated approval ID");
  fingerprint(
    receipt.catalogueFingerprint,
    "GitHub delegated catalogue fingerprint",
  );
  const parametersSha256 = fingerprint(
    receipt.parametersSha256,
    "GitHub delegated parameters fingerprint",
  );
  const providerRequestId = receipt.providerRequestId === null
    ? null
    : pattern(
      receipt.providerRequestId,
      providerRequestPattern,
      "GitHub provider request ID",
    );
  const resultSha256 = fingerprint(
    receipt.resultSha256,
    "GitHub delegated result fingerprint",
  );

  const result = exactRecord(
    receipt.result,
    providerResultKeys,
    "GitHub delegated pull request result",
  );
  if (resultSha256 !== sha256(stableJson(result))) {
    throw new RangeError(
      "GitHub delegated pull request result fingerprint is invalid",
    );
  }

  const resultRepository = repositoryName(result.repositoryFullName);
  const pullRequestNumber = positiveInteger(
    result.number,
    "GitHub delegated pull request number",
  );
  positiveInteger(result.id, "GitHub delegated pull request provider ID");
  boundedIdentity(result.nodeId, "GitHub delegated pull request node ID");
  text(result.title, "GitHub delegated pull request title", 1_024);
  text(result.authorLogin, "GitHub delegated pull request author", 120);
  nullableRepository(
    result.headRepositoryFullName,
    "GitHub delegated pull request head repository",
  );
  text(result.headRef, "GitHub delegated pull request head ref", 512);
  text(result.baseRef, "GitHub delegated pull request base ref", 512);

  const createdAt = timestamp(
    result.createdAt,
    "GitHub delegated pull request created time",
  );
  const updatedAt = timestamp(
    result.updatedAt,
    "GitHub delegated pull request updated time",
  );
  const closedAt = nullableTimestamp(
    result.closedAt,
    "GitHub delegated pull request closed time",
  );
  const mergedAt = nullableTimestamp(
    result.mergedAt,
    "GitHub delegated pull request merged time",
  );
  if (
    Date.parse(updatedAt) < Date.parse(createdAt)
    || (closedAt !== null
      && (Date.parse(closedAt) < Date.parse(createdAt)
        || Date.parse(closedAt) > Date.parse(updatedAt)))
    || (mergedAt !== null
      && (Date.parse(mergedAt) < Date.parse(createdAt)
        || Date.parse(mergedAt) > Date.parse(updatedAt)))
  ) {
    throw new RangeError(
      "GitHub delegated pull request lifecycle time is inconsistent",
    );
  }

  for (const [key, label] of [
    ["additions", "additions"],
    ["deletions", "deletions"],
    ["changedFiles", "changed files"],
    ["commits", "commits"],
    ["reviewComments", "review comments"],
    ["comments", "comments"],
  ] as const) {
    nonNegativeInteger(
      result[key],
      `GitHub delegated pull request ${label}`,
    );
  }

  const comparable = comparableState({
    headSha: result.headSha,
    baseSha: result.baseSha,
    mergeCommitSha: result.mergeCommitSha,
    state: result.state,
    draft: result.draft,
    locked: result.locked,
    merged: result.merged,
  }, "GitHub delegated pull request");
  if (
    (comparable.state === "open" && closedAt !== null)
    || (comparable.state === "closed" && closedAt === null)
    || (comparable.merged && mergedAt === null)
    || (!comparable.merged && mergedAt !== null)
  ) {
    throw new RangeError(
      "GitHub delegated pull request lifecycle fields are inconsistent",
    );
  }

  const expectedParametersSha256 = sha256(
    stableJson({ pr_number: pullRequestNumber }),
  );

  return {
    repository: receiptRepository,
    pullRequestNumber,
    identityConsistent: receiptRepository === resultRepository
      && parametersSha256 === expectedParametersSha256,
    bindingId,
    parametersSha256,
    providerRequestId,
    resultSha256,
    updatedAt,
    comparable,
  };
}

function comparableState(
  value: {
    headSha: unknown;
    baseSha: unknown;
    mergeCommitSha: unknown;
    state: unknown;
    draft: unknown;
    locked: unknown;
    merged: unknown;
  },
  label: string,
): ComparablePullRequestState {
  const state = closed(
    value.state,
    ["open", "closed"] as const,
    `${label} state`,
  );
  const merged = booleanValue(value.merged, `${label} merged flag`);
  const mergeCommitSha = nullableRevision(
    value.mergeCommitSha,
    `${label} merge revision`,
  );
  if (merged && (state !== "closed" || mergeCommitSha === null)) {
    throw new RangeError(`${label} merged state is inconsistent`);
  }
  return {
    headSha: revision(value.headSha, `${label} head revision`),
    baseSha: revision(value.baseSha, `${label} base revision`),
    mergeCommitSha,
    state,
    draft: booleanValue(value.draft, `${label} draft flag`),
    locked: booleanValue(value.locked, `${label} locked flag`),
    merged,
  };
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

function repositoryName(value: unknown): string {
  if (
    typeof value !== "string"
    || value !== value.toLowerCase()
    || value.length > 139
    || !repositoryPattern.test(value)
    || unsafeTextPattern.test(value)
  ) {
    throw new RangeError("GitHub reconciliation repository is invalid");
  }
  return value;
}

function nullableRepository(value: unknown, label: string): string | null {
  if (value === null) return null;
  try {
    return repositoryName(value);
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const parsed = new Date(value);
  const canonical = parsed.toISOString();
  const expected = value.length === 20 ? value.replace(/Z$/u, ".000Z") : value;
  if (!Number.isFinite(parsed.getTime()) || canonical !== expected) {
    throw new RangeError(`${label} must be a canonical timestamp`);
  }
  return canonical;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function attestTrustedTime(
  trustedClock: GitHubPullRequestReconciliationClock,
  reconciledAt: string,
): void {
  let trusted: unknown;
  try {
    trusted = trustedClock();
  } catch {
    throw new RangeError(
      "GitHub reconciliation trusted clock did not attest the reconciliation time",
    );
  }
  if (
    !(trusted instanceof Date)
    || !Number.isFinite(trusted.getTime())
    || trusted.toISOString() !== reconciledAt
  ) {
    throw new RangeError(
      "GitHub reconciliation trusted clock did not attest the reconciliation time",
    );
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new RangeError(`${label} must be boolean`);
  }
  return value;
}

function revision(value: unknown, label: string): string {
  return pattern(value, fullRevisionPattern, label);
}

function nullableRevision(value: unknown, label: string): string | null {
  return value === null ? null : revision(value, label);
}

function fingerprint(value: unknown, label: string): string {
  return pattern(value, sha256Pattern, label);
}

function boundedIdentity(value: unknown, label: string): string {
  return pattern(value, boundedIdentityPattern, label);
}

function nullableIdentity(value: unknown, label: string): string | null {
  return value === null ? null : boundedIdentity(value, label);
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value.trim() !== value
    || unsafeTextPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function pattern(
  value: unknown,
  expected: RegExp,
  label: string,
): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || unsafeTextPattern.test(value)
    || !expected.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function closed<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
