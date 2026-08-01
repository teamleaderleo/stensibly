import type {
  GitHubIssueComment,
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
  GitHubProviderReceiptState,
} from "./github-provider-contracts.js";
import { githubIssueProviderOperations } from "./github-provider-contracts.js";
import {
  canonicalJsonString,
  fingerprintExactText,
} from "./idempotency-request-fingerprint.js";
import { parseStrictJson } from "./strict-json.js";

const receiptKeys = [
  "actorId",
  "approvalId",
  "attachmentId",
  "attachmentSnapshotSha256",
  "attemptCount",
  "bindingId",
  "capabilityGrantId",
  "clientId",
  "connectionId",
  "createdAt",
  "error",
  "id",
  "idempotencyKey",
  "installationId",
  "operation",
  "parametersSha256",
  "project",
  "provider",
  "providerRequestId",
  "recovery",
  "repositoryFullName",
  "result",
  "state",
  "target",
  "updatedAt",
  "verification",
  "version",
] as const;
const verificationKeys = ["checkedAt", "sourceRevision", "state"] as const;
const errorKeys = ["code", "message", "retry"] as const;
const recoveryKeys = ["nextAction"] as const;
const commentKeys = [
  "bodyRevision",
  "canonicalUrl",
  "containsBody",
  "createdAt",
  "id",
  "issueNumber",
  "sourceRevision",
  "updatedAt",
] as const;
const bodyRevisionKeys = ["byteLength", "sha256"] as const;
const issueKeys = [
  "assignees",
  "bodyRevision",
  "containsIssueBody",
  "contentSha256",
  "createdAt",
  "labels",
  "milestone",
  "provider",
  "providerNodeId",
  "reference",
  "relationships",
  "snapshotSha256",
  "sourceRevision",
  "state",
  "stateReason",
  "title",
  "updatedAt",
  "version",
] as const;
const issueReferenceKeys = [
  "canonicalUrl",
  "externalId",
  "host",
  "number",
  "owner",
  "provider",
  "repository",
  "repositoryFullName",
] as const;
const issueBodyRevisionKeys = ["byteLength", "present", "sha256"] as const;
const milestoneKeys = ["number", "title"] as const;
const relationshipKeys = ["kind", "target"] as const;

const receiptStates: readonly GitHubProviderReceiptState[] = [
  "reserved",
  "succeeded",
  "rejected",
  "stale",
  "pending_reconciliation",
  "reconciled",
];
const verificationStates = ["not_run", "passed", "failed"] as const;
const retryKinds = ["do_not_retry", "reconcile_before_retry"] as const;
const recoveryActions = [
  "none",
  "refresh_and_retry_with_new_version",
  "inspect_authority_or_provider_rejection",
  "reconcile_exact_operation",
] as const;
const relationshipKinds = [
  "parent",
  "sub_issue",
  "blocked_by",
  "blocks",
  "related",
] as const;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const hashPattern = /^sha256:[0-9a-f]{64}$/;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const projectPattern = /^[a-z0-9][a-z0-9-_]{0,79}$/;
const boundedIdentifierPattern = /^[A-Za-z0-9._:/@#-]+$/;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const credentialPattern =
  /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9_]{20,}|authorization\s*:|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const maximumReceiptBytes = 512 * 1024;

export function canonicalGitHubProviderReceiptJson(
  value: GitHubProviderReceipt,
): string {
  return canonicalJsonString(admitGitHubProviderReceipt(value));
}

export function fingerprintGitHubProviderReceipt(
  value: GitHubProviderReceipt,
): string {
  return fingerprintExactText(canonicalGitHubProviderReceiptJson(value));
}

export function parseGitHubProviderReceiptJson(
  value: string,
): GitHubProviderReceipt {
  if (typeof value !== "string" || byteLength(value) > maximumReceiptBytes) {
    throw new RangeError("GitHub provider receipt JSON is oversized");
  }
  const parsed = parseStrictJson(value, {
    maxBytes: maximumReceiptBytes,
    maxDepth: 24,
    maxStringLength: 131_072,
    maxObjectKeys: 128,
    maxArrayLength: 128,
    prefix: "GITHUB_PROVIDER_RECEIPT",
  });
  const receipt = admitGitHubProviderReceipt(parsed);
  if (canonicalJsonString(receipt) !== value) {
    throw new RangeError("GitHub provider receipt JSON must be canonical");
  }
  return receipt;
}

export function admitGitHubProviderReceipt(
  value: unknown,
): GitHubProviderReceipt {
  if (!isRecord(value) || !hasExactKeys(value, receiptKeys)) {
    throw new RangeError("GitHub provider receipt has an invalid field set");
  }
  if (value.version !== 1 || value.provider !== "github") {
    throw new RangeError("GitHub provider receipt version or provider is invalid");
  }
  const project = exactString(value.project, "project", 80, projectPattern);
  const repositoryFullName = exactString(
    value.repositoryFullName,
    "repository",
    140,
    repositoryPattern,
  );
  const operation = exactEnum(
    value.operation,
    githubIssueProviderOperations,
    "operation",
  ) as GitHubIssueProviderOperation;
  const state = exactEnum(value.state, receiptStates, "state");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new RangeError("GitHub provider receipt update precedes creation");
  }
  const receipt: GitHubProviderReceipt = {
    version: 1,
    id: exactIdentifier(value.id, "receipt ID", 240),
    project,
    provider: "github",
    repositoryFullName,
    operation,
    target: exactText(value.target, "target", 512),
    actorId: exactText(value.actorId, "actor ID", 120),
    clientId: exactText(value.clientId, "client ID", 240),
    connectionId: exactIdentifier(value.connectionId, "connection ID", 240),
    installationId: exactIdentifier(value.installationId, "installation ID", 240),
    bindingId: exactIdentifier(value.bindingId, "binding ID", 240),
    attachmentId: exactIdentifier(value.attachmentId, "attachment ID", 240),
    attachmentSnapshotSha256: exactHash(
      value.attachmentSnapshotSha256,
      "attachment snapshot hash",
    ),
    capabilityGrantId: nullableIdentifier(
      value.capabilityGrantId,
      "capability grant ID",
      240,
    ),
    approvalId: nullableIdentifier(value.approvalId, "approval ID", 240),
    idempotencyKey: exactText(value.idempotencyKey, "idempotency key", 240),
    parametersSha256: exactHash(value.parametersSha256, "parameters hash"),
    state,
    attemptCount: positiveInteger(value.attemptCount, "attempt count"),
    createdAt,
    updatedAt,
    providerRequestId: nullableText(
      value.providerRequestId,
      "provider request ID",
      240,
    ),
    result: admitResult(value.result, repositoryFullName),
    verification: admitVerification(value.verification),
    error: admitError(value.error),
    recovery: admitRecovery(value.recovery),
  };
  if (receipt.verification.checkedAt !== null) {
    if (Date.parse(receipt.verification.checkedAt) < Date.parse(createdAt)) {
      throw new RangeError("GitHub provider verification precedes receipt creation");
    }
    if (Date.parse(receipt.verification.checkedAt) > Date.parse(updatedAt)) {
      throw new RangeError("GitHub provider verification follows receipt update");
    }
  }
  if (credentialPattern.test(canonicalJsonString(receipt))) {
    throw new RangeError("GitHub provider receipt contains credential-shaped text");
  }
  return deepFreeze(receipt);
}

export function sameGitHubProviderReceiptRequest(
  left: GitHubProviderReceipt,
  right: GitHubProviderReceipt,
): boolean {
  return left.operation === right.operation
    && left.parametersSha256 === right.parametersSha256
    && left.repositoryFullName === right.repositoryFullName
    && left.actorId === right.actorId
    && left.clientId === right.clientId;
}

export function sameGitHubProviderReceiptImmutableIdentity(
  left: GitHubProviderReceipt,
  right: GitHubProviderReceipt,
): boolean {
  return left.version === right.version
    && left.id === right.id
    && left.project === right.project
    && left.provider === right.provider
    && left.repositoryFullName === right.repositoryFullName
    && left.operation === right.operation
    && left.target === right.target
    && left.actorId === right.actorId
    && left.clientId === right.clientId
    && left.connectionId === right.connectionId
    && left.installationId === right.installationId
    && left.bindingId === right.bindingId
    && left.attachmentId === right.attachmentId
    && left.attachmentSnapshotSha256 === right.attachmentSnapshotSha256
    && left.capabilityGrantId === right.capabilityGrantId
    && left.approvalId === right.approvalId
    && left.idempotencyKey === right.idempotencyKey
    && left.parametersSha256 === right.parametersSha256
    && left.createdAt === right.createdAt;
}

export function interruptedGitHubProviderReceipt(
  current: GitHubProviderReceipt,
): GitHubProviderReceipt {
  return admitGitHubProviderReceipt({
    ...current,
    state: "pending_reconciliation",
    error: {
      code: "provider_dispatch_in_progress_or_interrupted",
      message:
        "GitHub provider dispatch may still be in progress or may have been interrupted",
      retry: "reconcile_before_retry",
    },
    recovery: { nextAction: "reconcile_exact_operation" },
  });
}

function admitVerification(value: unknown): GitHubProviderReceipt["verification"] {
  if (!isRecord(value) || !hasExactKeys(value, verificationKeys)) {
    throw new RangeError("GitHub provider verification has an invalid field set");
  }
  return {
    state: exactEnum(value.state, verificationStates, "verification state"),
    checkedAt: value.checkedAt === null
      ? null
      : timestamp(value.checkedAt, "verification time"),
    sourceRevision: nullableText(value.sourceRevision, "source revision", 512),
  };
}

function admitError(value: unknown): GitHubProviderReceipt["error"] {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, errorKeys)) {
    throw new RangeError("GitHub provider error has an invalid field set");
  }
  return {
    code: exactIdentifier(value.code, "error code", 120),
    message: exactText(value.message, "error message", 1_000),
    retry: exactEnum(value.retry, retryKinds, "retry policy"),
  };
}

function admitRecovery(value: unknown): GitHubProviderReceipt["recovery"] {
  if (!isRecord(value) || !hasExactKeys(value, recoveryKeys)) {
    throw new RangeError("GitHub provider recovery has an invalid field set");
  }
  return {
    nextAction: exactEnum(value.nextAction, recoveryActions, "recovery action"),
  };
}

function admitResult(
  value: unknown,
  repositoryFullName: string,
): GitHubProviderReceipt["result"] {
  if (value === null) return null;
  if (!isRecord(value)) throw new RangeError("GitHub provider result is invalid");
  if (value.containsBody === false) {
    return admitComment(value, repositoryFullName);
  }
  if (value.containsIssueBody === false) {
    return admitIssue(value, repositoryFullName);
  }
  throw new RangeError("GitHub provider result type is invalid");
}

function admitComment(
  value: Record<string, unknown>,
  repositoryFullName: string,
): GitHubIssueComment {
  if (!hasExactKeys(value, commentKeys)) {
    throw new RangeError("GitHub issue comment result has an invalid field set");
  }
  const issueNumber = positiveInteger(value.issueNumber, "comment issue number");
  const id = exactText(value.id, "comment ID", 240);
  const canonicalUrl = exactText(value.canonicalUrl, "comment URL", 512);
  const escapedRepository = escapeRegExp(repositoryFullName);
  const escapedId = escapeRegExp(id);
  if (!new RegExp(
    `^https://github\\.com/${escapedRepository}/issues/${issueNumber}#issuecomment-${escapedId}$`,
  ).test(canonicalUrl)) {
    throw new RangeError("GitHub issue comment URL is outside the bound repository");
  }
  const bodyRevision = admitBodyRevision(value.bodyRevision, false);
  return {
    id,
    issueNumber,
    canonicalUrl,
    createdAt: timestamp(value.createdAt, "comment createdAt"),
    updatedAt: timestamp(value.updatedAt, "comment updatedAt"),
    sourceRevision: exactText(value.sourceRevision, "comment source revision", 512),
    bodyRevision,
    containsBody: false,
  };
}

function admitIssue(
  value: Record<string, unknown>,
  repositoryFullName: string,
): GitHubProviderReceipt["result"] {
  if (!hasExactKeys(value, issueKeys)) {
    throw new RangeError("GitHub issue result has an invalid field set");
  }
  if (value.version !== 1 || value.provider !== "github") {
    throw new RangeError("GitHub issue result version or provider is invalid");
  }
  const reference = admitIssueReference(value.reference, repositoryFullName);
  const labels = exactStringArray(value.labels, "labels", 100, 100);
  const assignees = exactStringArray(value.assignees, "assignees", 100, 100);
  const relationships = exactArray(value.relationships, "relationships", 100).map(
    (entry) => {
      if (!isRecord(entry) || !hasExactKeys(entry, relationshipKeys)) {
        throw new RangeError("GitHub issue relationship is invalid");
      }
      return {
        kind: exactEnum(entry.kind, relationshipKinds, "relationship kind"),
        target: admitIssueReference(entry.target, undefined),
      };
    },
  );
  const milestone = value.milestone === null
    ? null
    : admitMilestone(value.milestone);
  const state = exactEnum(value.state, ["open", "closed"] as const, "issue state");
  const stateReason = value.stateReason === null
    ? null
    : exactEnum(
      value.stateReason,
      ["completed", "not_planned", "reopened"] as const,
      "issue state reason",
    );
  return {
    version: 1,
    provider: "github",
    reference,
    title: exactText(value.title, "issue title", 256),
    bodyRevision: admitBodyRevision(value.bodyRevision, true),
    state,
    stateReason,
    labels,
    assignees,
    milestone,
    relationships,
    createdAt: timestamp(value.createdAt, "issue createdAt"),
    updatedAt: timestamp(value.updatedAt, "issue updatedAt"),
    providerNodeId: nullableText(value.providerNodeId, "provider node ID", 256),
    sourceRevision: exactText(value.sourceRevision, "issue source revision", 512),
    contentSha256: exactHash(value.contentSha256, "issue content hash"),
    snapshotSha256: exactHash(value.snapshotSha256, "issue snapshot hash"),
    containsIssueBody: false,
  };
}

function admitIssueReference(
  value: unknown,
  expectedRepositoryFullName: string | undefined,
) {
  if (!isRecord(value) || !hasExactKeys(value, issueReferenceKeys)) {
    throw new RangeError("GitHub issue reference is invalid");
  }
  if (value.provider !== "github" || value.host !== "github.com") {
    throw new RangeError("GitHub issue reference provider or host is invalid");
  }
  const owner = exactText(value.owner, "owner", 39);
  const repository = exactText(value.repository, "repository", 100);
  const repositoryFullName = exactString(
    value.repositoryFullName,
    "reference repository",
    140,
    repositoryPattern,
  );
  if (
    repositoryFullName !== `${owner}/${repository}`
    || (
      expectedRepositoryFullName !== undefined
      && repositoryFullName !== expectedRepositoryFullName
    )
  ) {
    throw new RangeError("GitHub issue reference repository identity is invalid");
  }
  const number = positiveInteger(value.number, "issue number");
  const externalId = `github:${repositoryFullName}#${number}`;
  const canonicalUrl = `https://github.com/${repositoryFullName}/issues/${number}`;
  if (value.externalId !== externalId || value.canonicalUrl !== canonicalUrl) {
    throw new RangeError("GitHub issue reference derived identity is invalid");
  }
  return {
    provider: "github" as const,
    host: "github.com" as const,
    owner,
    repository,
    repositoryFullName,
    number,
    externalId,
    canonicalUrl,
  };
}

function admitBodyRevision(value: unknown, issue: boolean) {
  const keys = issue ? issueBodyRevisionKeys : bodyRevisionKeys;
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new RangeError("GitHub body revision is invalid");
  }
  const common = {
    byteLength: nonnegativeInteger(value.byteLength, "body byte length"),
    sha256: exactHash(value.sha256, "body hash"),
  };
  return issue
    ? { present: Boolean(value.present), ...common }
    : common;
}

function admitMilestone(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, milestoneKeys)) {
    throw new RangeError("GitHub milestone is invalid");
  }
  return {
    number: positiveInteger(value.number, "milestone number"),
    title: exactText(value.title, "milestone title", 256),
  };
}

function exactStringArray(
  value: unknown,
  label: string,
  maximum: number,
  maximumLength: number,
): string[] {
  const entries = exactArray(value, label, maximum).map((entry) =>
    exactText(entry, label, maximumLength)
  );
  if (new Set(entries).size !== entries.length) {
    throw new RangeError(`GitHub provider ${label} must be unique`);
  }
  return entries;
}

function exactArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`GitHub provider ${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = exactString(value, label, 32, timestampPattern);
  if (!Number.isFinite(Date.parse(result))) {
    throw new RangeError(`GitHub provider ${label} is invalid`);
  }
  return result;
}

function exactHash(value: unknown, label: string): string {
  return exactString(value, label, 71, hashPattern);
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  return exactString(value, label, maximum, boundedIdentifierPattern);
}

function nullableIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  return value === null ? null : exactIdentifier(value, label, maximum);
}

function nullableText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  return value === null ? null : exactText(value, label, maximum);
}

function exactText(value: unknown, label: string, maximum: number): string {
  const result = exactString(value, label, maximum);
  if (unsafeTextPattern.test(result)) {
    throw new RangeError(`GitHub provider ${label} contains unsafe text`);
  }
  return result;
}

function exactString(
  value: unknown,
  label: string,
  maximum: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || (pattern !== undefined && !pattern.test(value))
  ) {
    throw new RangeError(`GitHub provider ${label} is invalid`);
  }
  return value;
}

function exactEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new RangeError(`GitHub provider ${label} is invalid`);
  }
  return value as T[number];
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RangeError(`GitHub provider ${label} is invalid`);
  }
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(`GitHub provider ${label} is invalid`);
  }
  return Number(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
