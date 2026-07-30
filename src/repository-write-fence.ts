import { createHash } from "node:crypto";

export const repositoryWriteOperations = [
  "create_file",
  "update_file",
  "delete_file",
] as const;

export type RepositoryWriteOperation = typeof repositoryWriteOperations[number];

export interface RepositoryWriteIntent {
  version: 1;
  repositoryFullName: string;
  path: string;
  operation: RepositoryWriteOperation;
  declaredTargetRef: string;
  targetRef: string;
  defaultBranch: string;
  expectedParentSha: string;
  defaultBranchApprovalId?: string;
  authorityFallbackApprovalId?: string;
}

export interface PreparedRepositoryWrite extends RepositoryWriteIntent {
  requestSha256: string;
}

export interface RepositoryWriteProviderResult {
  commitSha?: string;
  providerRequestId?: string;
  targetRef?: string;
  parentSha?: string;
}

export interface RepositoryWriteRefReader {
  getRefHead(input: {
    repositoryFullName: string;
    targetRef: string;
  }): Promise<string | null>;
  getCommitParents(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<string[]>;
}

export interface VerifiedRepositoryWrite {
  version: 1;
  state: "verified";
  repositoryFullName: string;
  path: string;
  operation: RepositoryWriteOperation;
  targetRef: string;
  expectedParentSha: string;
  commitSha: string;
  nextExpectedParentSha: string;
  providerRequestId: string | null;
  requestSha256: string;
  verifiedAt: string;
}

export type RepositoryWriteFenceDisposition =
  | "rejected"
  | "pending_reconciliation";

export class RepositoryWriteFenceError extends Error {
  readonly code: string;
  readonly disposition: RepositoryWriteFenceDisposition;
  readonly retry: "do_not_retry" | "reconcile_before_retry";
  readonly evidence: Readonly<Record<string, string | null>>;

  constructor(input: {
    code: string;
    message: string;
    disposition: RepositoryWriteFenceDisposition;
    retry: "do_not_retry" | "reconcile_before_retry";
    evidence?: Record<string, string | null>;
  }) {
    super(input.message);
    this.name = "RepositoryWriteFenceError";
    this.code = input.code;
    this.disposition = input.disposition;
    this.retry = input.retry;
    this.evidence = Object.freeze({ ...(input.evidence ?? {}) });
  }
}

const intentKeys = new Set([
  "version",
  "repositoryFullName",
  "path",
  "operation",
  "declaredTargetRef",
  "targetRef",
  "defaultBranch",
  "expectedParentSha",
  "defaultBranchApprovalId",
  "authorityFallbackApprovalId",
]);

export function prepareRepositoryWrite(input: unknown): PreparedRepositoryWrite {
  const record = strictRecord(input, "Repository write intent");
  const unknownKeys = Object.keys(record).filter((key) => !intentKeys.has(key));
  if (unknownKeys.length > 0) {
    throw rejected(
      "unknown_repository_write_field",
      `Repository write intent contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.sort().join(", ")}`,
      { unknownFields: unknownKeys.sort().join(",") },
    );
  }

  if (record.version !== 1) {
    throw rejected("unsupported_repository_write_version", "Repository write intent version must be 1");
  }

  const repositoryFullName = repositoryName(record.repositoryFullName);
  const path = repositoryPath(record.path);
  const operation = repositoryWriteOperation(record.operation);
  const declaredTargetRef = branchRef(record.declaredTargetRef, "Declared target ref");
  const targetRef = branchRef(record.targetRef, "Target ref");
  const defaultBranch = branchRef(record.defaultBranch, "Default branch");
  const expectedParentSha = commitSha(record.expectedParentSha, "Expected parent SHA");
  const defaultBranchApprovalId = optionalIdentifier(
    record.defaultBranchApprovalId,
    "Default-branch approval ID",
  );
  const authorityFallbackApprovalId = optionalIdentifier(
    record.authorityFallbackApprovalId,
    "Authority-fallback approval ID",
  );

  if (targetRef !== declaredTargetRef && !authorityFallbackApprovalId) {
    throw rejected(
      "target_ref_changed_without_authority_fallback",
      `Target ref ${targetRef} differs from declared target ref ${declaredTargetRef}`,
      { declaredTargetRef, targetRef },
    );
  }

  if (targetRef === defaultBranch && !defaultBranchApprovalId) {
    throw rejected(
      "default_branch_approval_required",
      `Repository write targets default branch ${defaultBranch} without explicit approval`,
      { defaultBranch, targetRef },
    );
  }

  const intent: RepositoryWriteIntent = {
    version: 1,
    repositoryFullName,
    path,
    operation,
    declaredTargetRef,
    targetRef,
    defaultBranch,
    expectedParentSha,
    ...(defaultBranchApprovalId ? { defaultBranchApprovalId } : {}),
    ...(authorityFallbackApprovalId ? { authorityFallbackApprovalId } : {}),
  };

  return Object.freeze({
    ...intent,
    requestSha256: sha256(stableJson(intent)),
  });
}

export async function verifyRepositoryWriteResult(input: {
  prepared: PreparedRepositoryWrite;
  providerResult: RepositoryWriteProviderResult;
  refs: RepositoryWriteRefReader;
  now?: () => string;
}): Promise<VerifiedRepositoryWrite> {
  const { prepared, providerResult, refs } = input;
  const now = input.now ?? (() => new Date().toISOString());

  const providerTargetRef = providerResult.targetRef === undefined
    ? null
    : branchRef(providerResult.targetRef, "Provider target ref");
  if (providerTargetRef && providerTargetRef !== prepared.targetRef) {
    throw pending(
      "provider_target_ref_mismatch",
      `Provider reported target ref ${providerTargetRef}, expected ${prepared.targetRef}`,
      prepared,
      providerResult,
      { providerTargetRef },
    );
  }

  const returnedParentSha = providerResult.parentSha === undefined
    ? null
    : commitSha(providerResult.parentSha, "Provider parent SHA");
  if (returnedParentSha && returnedParentSha !== prepared.expectedParentSha) {
    throw pending(
      "provider_parent_mismatch",
      `Provider reported parent ${returnedParentSha}, expected ${prepared.expectedParentSha}`,
      prepared,
      providerResult,
      { returnedParentSha },
    );
  }

  if (!providerResult.commitSha) {
    throw pending(
      "provider_commit_identity_missing",
      "Repository write result omitted the commit SHA",
      prepared,
      providerResult,
    );
  }
  const returnedCommitSha = commitSha(providerResult.commitSha, "Provider commit SHA");

  let refHead: string | null;
  let parents: string[];
  try {
    [refHead, parents] = await Promise.all([
      refs.getRefHead({
        repositoryFullName: prepared.repositoryFullName,
        targetRef: prepared.targetRef,
      }),
      refs.getCommitParents({
        repositoryFullName: prepared.repositoryFullName,
        commitSha: returnedCommitSha,
      }),
    ]);
  } catch (error) {
    throw pending(
      "repository_write_verification_unavailable",
      "Repository write verification could not read the target ref and commit ancestry",
      prepared,
      providerResult,
      { verificationError: boundedError(error) },
    );
  }

  const canonicalRefHead = refHead === null ? null : commitSha(refHead, "Target ref head");
  if (canonicalRefHead !== returnedCommitSha) {
    throw pending(
      "target_ref_did_not_land_on_returned_commit",
      `Target ref ${prepared.targetRef} points to ${canonicalRefHead ?? "nothing"}, expected ${returnedCommitSha}`,
      prepared,
      providerResult,
      { refHead: canonicalRefHead },
    );
  }

  const canonicalParents = parents.map((parent) => commitSha(parent, "Commit parent SHA"));
  if (!canonicalParents.includes(prepared.expectedParentSha)) {
    throw pending(
      "returned_commit_does_not_descend_from_expected_parent",
      `Returned commit ${returnedCommitSha} does not directly descend from ${prepared.expectedParentSha}`,
      prepared,
      providerResult,
      { parents: canonicalParents.join(",") || null },
    );
  }

  return Object.freeze({
    version: 1,
    state: "verified",
    repositoryFullName: prepared.repositoryFullName,
    path: prepared.path,
    operation: prepared.operation,
    targetRef: prepared.targetRef,
    expectedParentSha: prepared.expectedParentSha,
    commitSha: returnedCommitSha,
    nextExpectedParentSha: canonicalRefHead,
    providerRequestId: optionalIdentifier(
      providerResult.providerRequestId,
      "Provider request ID",
    ) ?? null,
    requestSha256: prepared.requestSha256,
    verifiedAt: canonicalTimestamp(now()),
  });
}

function pending(
  code: string,
  message: string,
  prepared: PreparedRepositoryWrite,
  providerResult: RepositoryWriteProviderResult,
  extra: Record<string, string | null> = {},
): RepositoryWriteFenceError {
  return new RepositoryWriteFenceError({
    code,
    message,
    disposition: "pending_reconciliation",
    retry: "reconcile_before_retry",
    evidence: {
      repositoryFullName: prepared.repositoryFullName,
      targetRef: prepared.targetRef,
      expectedParentSha: prepared.expectedParentSha,
      returnedCommitSha: typeof providerResult.commitSha === "string"
        ? providerResult.commitSha
        : null,
      providerRequestId: typeof providerResult.providerRequestId === "string"
        ? providerResult.providerRequestId
        : null,
      ...extra,
    },
  });
}

function rejected(
  code: string,
  message: string,
  evidence: Record<string, string | null> = {},
): RepositoryWriteFenceError {
  return new RepositoryWriteFenceError({
    code,
    message,
    disposition: "rejected",
    retry: "do_not_retry",
    evidence,
  });
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected("invalid_repository_write_intent", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function repositoryName(value: unknown): string {
  const text = textValue(value, "Repository full name", 200).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(text)) {
    throw rejected("invalid_repository_full_name", "Use one owner/repository identifier");
  }
  return text;
}

function repositoryPath(value: unknown): string {
  const text = textValue(value, "Repository path", 4_096).replaceAll("\\", "/");
  if (text.startsWith("/") || text.endsWith("/") || text.split("/").includes("..")) {
    throw rejected("invalid_repository_path", "Repository path must be relative and cannot traverse parents");
  }
  return text;
}

function repositoryWriteOperation(value: unknown): RepositoryWriteOperation {
  if (typeof value !== "string" || !repositoryWriteOperations.includes(value as RepositoryWriteOperation)) {
    throw rejected(
      "invalid_repository_write_operation",
      `Repository write operation must be one of ${repositoryWriteOperations.join(", ")}`,
    );
  }
  return value as RepositoryWriteOperation;
}

function branchRef(value: unknown, label: string): string {
  let text = textValue(value, label, 240);
  if (text.startsWith("refs/heads/")) text = text.slice("refs/heads/".length);
  if (
    text.startsWith("-")
    || text.endsWith(".")
    || text.includes("..")
    || text.includes("@{")
    || /[~^:?*\[\\\s]/.test(text)
  ) {
    throw rejected("invalid_repository_target_ref", `${label} is not a canonical branch ref`);
  }
  return text;
}

function commitSha(value: unknown, label: string): string {
  const text = textValue(value, label, 64).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text)) {
    throw rejected("invalid_commit_sha", `${label} must be a full 40- or 64-character hexadecimal SHA`);
  }
  return text;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return textValue(value, label, 240);
}

function textValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw rejected("invalid_repository_write_text", `${label} must be a string`);
  }
  const text = value.normalize("NFKC").trim();
  if (!text || [...text].length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw rejected(
      "invalid_repository_write_text",
      `${label} must contain 1 to ${maximum} safe characters`,
    );
  }
  return text;
}

function canonicalTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw rejected("invalid_verification_timestamp", "Verification time must be a valid timestamp");
  }
  return date.toISOString();
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Canonical JSON value is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
