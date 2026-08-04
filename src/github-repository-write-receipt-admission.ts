import { sha256, stableJson } from "./canonical-json.js";
import type {
  GitHubRepositoryWriteReceipt,
  GitHubRepositoryWriteReceiptState,
} from "./github-repository-write-provider-service.js";
import {
  repositoryWriteOperations,
  type RepositoryWriteOperation,
  type VerifiedRepositoryWrite,
} from "./repository-write-fence.js";

const receiptKeys = [
  "version",
  "id",
  "project",
  "repositoryFullName",
  "targetRef",
  "path",
  "operation",
  "expectedParentSha",
  "requestSha256",
  "payloadSha256",
  "actorId",
  "clientId",
  "idempotencyKey",
  "state",
  "dispatchCount",
  "createdAt",
  "updatedAt",
  "verified",
  "error",
] as const;
const verifiedKeys = [
  "version",
  "state",
  "repositoryFullName",
  "path",
  "operation",
  "targetRef",
  "defaultBranch",
  "expectedParentSha",
  "authorityId",
  "authorityGeneration",
  "defaultBranchApprovalId",
  "commitSha",
  "nextExpectedParentSha",
  "providerRequestId",
  "requestSha256",
  "verifiedAt",
  "authorizesRetry",
] as const;
const errorKeys = ["code", "retry"] as const;
const states = [
  "reserved",
  "rejected",
  "pending_reconciliation",
  "verified_pending_release",
  "succeeded",
] as const;
const credentialShapedPattern =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}|bearer\s+[A-Za-z0-9._~+\/-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|authorization\s*:|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function admitGitHubRepositoryWriteReceipt(
  value: unknown,
): GitHubRepositoryWriteReceipt {
  const record = exactDataRecord(value, receiptKeys);
  if (record.version !== 1) throw invalidReceipt();
  const state = exactState(record.state);
  const createdAt = exactTimestamp(record.createdAt);
  const updatedAt = exactTimestamp(record.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw invalidReceipt();

  const receipt: GitHubRepositoryWriteReceipt = {
    version: 1,
    id: exactIdentifier(record.id),
    project: exactSlug(record.project),
    repositoryFullName: exactRepository(record.repositoryFullName),
    targetRef: exactBranchRef(record.targetRef),
    path: exactRepositoryPath(record.path),
    operation: exactOperation(record.operation),
    expectedParentSha: exactCommitSha(record.expectedParentSha),
    requestSha256: exactSha256(record.requestSha256),
    payloadSha256: exactSha256(record.payloadSha256),
    actorId: exactIdentifier(record.actorId),
    clientId: exactIdentifier(record.clientId),
    idempotencyKey: exactIdentifier(record.idempotencyKey),
    state,
    dispatchCount: exactDispatchCount(record.dispatchCount),
    createdAt,
    updatedAt,
    verified: null,
    error: null,
  };

  const verified = record.verified === null
    ? null
    : admitVerified(record.verified, receipt);
  const error = record.error === null ? null : admitError(record.error);
  enforceLifecycle(receipt, verified, error);

  const result: GitHubRepositoryWriteReceipt = {
    ...receipt,
    verified,
    error,
  };
  if (verified) Object.freeze(verified);
  if (error) Object.freeze(error);
  return Object.freeze(result);
}

export function canonicalGitHubRepositoryWriteReceiptJson(
  receipt: GitHubRepositoryWriteReceipt,
): string {
  return stableJson(admitGitHubRepositoryWriteReceipt(receipt));
}

export function parseGitHubRepositoryWriteReceiptJson(
  value: unknown,
): GitHubRepositoryWriteReceipt {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 256 * 1024
  ) {
    throw invalidReceipt();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidReceipt();
  }
  const receipt = admitGitHubRepositoryWriteReceipt(parsed);
  if (stableJson(receipt) !== value) {
    throw new Error(
      "GitHub repository write receipt JSON must be canonical",
    );
  }
  return receipt;
}

export function fingerprintGitHubRepositoryWriteReceipt(
  receipt: GitHubRepositoryWriteReceipt,
): string {
  return sha256(canonicalGitHubRepositoryWriteReceiptJson(receipt));
}

function admitVerified(
  value: unknown,
  receipt: GitHubRepositoryWriteReceipt,
): VerifiedRepositoryWrite {
  const record = exactDataRecord(value, verifiedKeys);
  if (
    record.version !== 1
    || record.state !== "verified"
    || record.authorizesRetry !== false
  ) {
    throw invalidReceipt();
  }
  const targetRef = exactBranchRef(record.targetRef);
  const defaultBranch = exactBranchRef(record.defaultBranch);
  const approvalId = record.defaultBranchApprovalId === null
    ? null
    : exactIdentifier(record.defaultBranchApprovalId);
  if (
    (targetRef === defaultBranch && approvalId === null)
    || (targetRef !== defaultBranch && approvalId !== null)
  ) {
    throw invalidReceipt();
  }
  const commitSha = exactCommitSha(record.commitSha);
  const verifiedAt = exactTimestamp(record.verifiedAt);
  const result: VerifiedRepositoryWrite = {
    version: 1,
    state: "verified",
    repositoryFullName: exactRepository(record.repositoryFullName),
    path: exactRepositoryPath(record.path),
    operation: exactOperation(record.operation),
    targetRef,
    defaultBranch,
    expectedParentSha: exactCommitSha(record.expectedParentSha),
    authorityId: exactIdentifier(record.authorityId),
    authorityGeneration: exactPositiveInteger(record.authorityGeneration),
    defaultBranchApprovalId: approvalId,
    commitSha,
    nextExpectedParentSha: exactCommitSha(record.nextExpectedParentSha),
    providerRequestId: record.providerRequestId === null
      ? null
      : exactIdentifier(record.providerRequestId),
    requestSha256: exactSha256(record.requestSha256),
    verifiedAt,
    authorizesRetry: false,
  };
  if (
    result.repositoryFullName !== receipt.repositoryFullName
    || result.path !== receipt.path
    || result.operation !== receipt.operation
    || result.targetRef !== receipt.targetRef
    || result.expectedParentSha !== receipt.expectedParentSha
    || result.requestSha256 !== receipt.requestSha256
    || result.nextExpectedParentSha !== result.commitSha
    || Date.parse(result.verifiedAt) < Date.parse(receipt.createdAt)
    || Date.parse(result.verifiedAt) > Date.parse(receipt.updatedAt)
  ) {
    throw invalidReceipt();
  }
  return result;
}

function admitError(value: unknown): NonNullable<GitHubRepositoryWriteReceipt["error"]> {
  const record = exactDataRecord(value, errorKeys);
  if (
    record.retry !== "do_not_retry"
    && record.retry !== "reconcile_before_retry"
  ) {
    throw invalidReceipt();
  }
  return {
    code: exactIdentifier(record.code),
    retry: record.retry,
  };
}

function enforceLifecycle(
  receipt: GitHubRepositoryWriteReceipt,
  verified: VerifiedRepositoryWrite | null,
  error: GitHubRepositoryWriteReceipt["error"],
): void {
  if (receipt.state === "reserved") {
    if (verified !== null || error !== null) throw invalidReceipt();
    return;
  }
  if (receipt.state === "rejected") {
    if (verified !== null || error?.retry !== "do_not_retry") {
      throw invalidReceipt();
    }
    return;
  }
  if (receipt.state === "pending_reconciliation") {
    if (verified !== null || error?.retry !== "reconcile_before_retry") {
      throw invalidReceipt();
    }
    return;
  }
  if (receipt.dispatchCount !== 1 || verified === null) throw invalidReceipt();
  if (receipt.state === "verified_pending_release") {
    if (error?.retry !== "reconcile_before_retry") throw invalidReceipt();
    return;
  }
  if (error !== null) throw invalidReceipt();
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw invalidReceipt();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidReceipt();
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw invalidReceipt();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalKeys.length
    || actualKeys.some((key, index) => key !== canonicalKeys[index])
  ) {
    throw invalidReceipt();
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of canonicalKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw invalidReceipt();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactState(value: unknown): GitHubRepositoryWriteReceiptState {
  if (
    typeof value !== "string"
    || !states.includes(value as typeof states[number])
  ) {
    throw invalidReceipt();
  }
  return value as GitHubRepositoryWriteReceiptState;
}

function exactOperation(value: unknown): RepositoryWriteOperation {
  if (
    typeof value !== "string"
    || !repositoryWriteOperations.includes(value as RepositoryWriteOperation)
  ) {
    throw invalidReceipt();
  }
  return value as RepositoryWriteOperation;
}

function exactRepository(value: unknown): string {
  const text = exactAscii(value, 200);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/u.test(text)) {
    throw invalidReceipt();
  }
  return text.toLowerCase();
}

function exactRepositoryPath(value: unknown): string {
  const text = exactAscii(value, 4_096);
  if (
    text.trim() !== text
    || text.includes("\\")
    || text.startsWith("/")
    || text.endsWith("/")
  ) {
    throw invalidReceipt();
  }
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalidReceipt();
  }
  return text;
}

function exactBranchRef(value: unknown): string {
  const text = exactAscii(value, 240);
  if (
    text === "@"
    || text === "HEAD"
    || text.startsWith("refs/heads/")
    || text.startsWith("/")
    || text.endsWith("/")
    || text.startsWith("-")
    || text.includes("//")
    || text.includes("..")
    || text.includes("@{")
    || /[~^:?*\[\\\s]/u.test(text)
  ) {
    throw invalidReceipt();
  }
  const segments = text.split("/");
  if (
    segments.some((segment) =>
      !segment
      || segment === "."
      || segment === ".."
      || segment.startsWith(".")
      || segment.endsWith(".")
      || segment.endsWith(".lock")
    )
  ) {
    throw invalidReceipt();
  }
  return text;
}

function exactIdentifier(value: unknown): string {
  const text = exactAscii(value, 240);
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,238}[A-Za-z0-9])?$/u.test(text)
  ) {
    throw invalidReceipt();
  }
  return text;
}

function exactSlug(value: unknown): string {
  const text = exactAscii(value, 80);
  if (text !== text.toLowerCase() || !/^[a-z0-9][a-z0-9_-]*$/u.test(text)) {
    throw invalidReceipt();
  }
  return text;
}

function exactCommitSha(value: unknown): string {
  const text = exactAscii(value, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(text)) {
    throw invalidReceipt();
  }
  return text;
}

function exactSha256(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw invalidReceipt();
  }
  return value;
}

function exactPositiveInteger(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 1
  ) {
    throw invalidReceipt();
  }
  return value;
}

function exactDispatchCount(value: unknown): 0 | 1 {
  if (Object.is(value, -0) || (value !== 0 && value !== 1)) {
    throw invalidReceipt();
  }
  return value;
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || !utcTimestampPattern.test(value)) {
    throw invalidReceipt();
  }
  const date = new Date(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normalized) {
    throw invalidReceipt();
  }
  return date.toISOString();
}

function exactAscii(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumBytes
    || !/^[\x20-\x7e]+$/u.test(value)
    || credentialShapedPattern.test(value)
  ) {
    throw invalidReceipt();
  }
  return value;
}

function invalidReceipt(): Error {
  return new Error("GitHub repository write receipt is invalid");
}
