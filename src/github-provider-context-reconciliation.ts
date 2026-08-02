import type {
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "./github-provider-contracts.js";
import type { GitHubIssueContext } from "./github-issue-context.js";
import { parseGitHubIssueExternalId } from "./github-issue-context.js";
import {
  admitGitHubProviderReceipt,
  fingerprintGitHubProviderReceipt,
} from "./github-provider-receipt-admission.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1 = 1 as const;

export type GitHubProviderContextReconciliationOutcome =
  | "await_provider_result"
  | "pending_provider_reconciliation"
  | "no_issue_context_effect"
  | "already_current"
  | "propose_context_acceptance"
  | "identity_conflict";

export type GitHubProviderContextReconciliationNextAction =
  | "wait_for_provider_result"
  | "reconcile_provider_operation"
  | "none"
  | "accept_provider_issue_context"
  | "inspect_issue_identity_conflict";

export interface GitHubProviderContextReconciliationInputV1 {
  version: typeof GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1;
  receipt: GitHubProviderReceipt;
  currentAcceptedIssueExternalId: string | null;
  currentAcceptedSourceRevision: string | null;
}

export interface GitHubProviderContextReconciliationProposalV1 {
  version: typeof GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1;
  provider: "github";
  project: string;
  repositoryFullName: string;
  receiptId: string;
  receiptState: GitHubProviderReceipt["state"];
  operation: GitHubIssueProviderOperation;
  currentAcceptedIssueExternalId: string | null;
  currentAcceptedSourceRevision: string | null;
  providerIssueExternalId: string | null;
  providerSourceRevision: string | null;
  outcome: GitHubProviderContextReconciliationOutcome;
  nextAction: GitHubProviderContextReconciliationNextAction;
  issue: GitHubIssueContext | null;
  receiptFingerprint: string;
  inputFingerprint: string;
  proposalFingerprint: string;
  authorizesProviderMutation: false;
  authorizesContextAcceptance: false;
  grantsAuthority: false;
}

const inputKeys = [
  "version",
  "receipt",
  "currentAcceptedIssueExternalId",
  "currentAcceptedSourceRevision",
] as const;

const issueEffectOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_labels",
  "github_remove_issue_label",
  "github_add_issue_assignees",
  "github_remove_issue_assignees",
]);

const sourceRevisionPattern = /^[A-Za-z0-9._:/@#-]+$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

type DataRecord = Record<string, unknown>;

/**
 * Compiles one provider-write receipt into a non-authorizing proposal for the
 * accepted GitHub issue-context path. This function performs no provider or
 * persistence activity.
 */
export function compileGitHubProviderContextReconciliationV1(
  value: unknown,
): GitHubProviderContextReconciliationProposalV1 {
  const input = exactRecord(
    value,
    inputKeys,
    "GitHub provider context reconciliation input",
  );
  if (input.version !== GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1) {
    throw new RangeError(
      "GitHub provider context reconciliation version is unsupported",
    );
  }

  const receipt = admitGitHubProviderReceipt(input.receipt);
  validateReceiptStateSemantics(receipt);
  const currentAcceptedIssueExternalId = nullableExternalId(
    input.currentAcceptedIssueExternalId,
  );
  const currentAcceptedSourceRevision = nullableSourceRevision(
    input.currentAcceptedSourceRevision,
  );
  if (
    (currentAcceptedIssueExternalId === null)
    !== (currentAcceptedSourceRevision === null)
  ) {
    throw new RangeError(
      "Current accepted GitHub issue identity and source revision must be supplied together",
    );
  }

  const receiptFingerprint = fingerprintGitHubProviderReceipt(receipt);
  const inputFingerprint = fingerprintCanonicalRequest({
    version: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receiptFingerprint,
    currentAcceptedIssueExternalId,
    currentAcceptedSourceRevision,
  });

  const issueResult = isIssueResult(receipt.result) ? receipt.result : null;
  const decision = decideReconciliation(
    receipt,
    issueResult,
    currentAcceptedIssueExternalId,
    currentAcceptedSourceRevision,
  );
  const retainsProviderIssueIdentity =
    decision.outcome === "already_current"
    || decision.outcome === "propose_context_acceptance"
    || decision.outcome === "identity_conflict";
  const providerIssueExternalId = retainsProviderIssueIdentity
    ? issueResult?.reference.externalId ?? null
    : null;
  const providerSourceRevision = retainsProviderIssueIdentity
    ? issueResult?.sourceRevision ?? null
    : null;

  const proposal = {
    version: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    provider: "github" as const,
    project: receipt.project,
    repositoryFullName: receipt.repositoryFullName,
    receiptId: receipt.id,
    receiptState: receipt.state,
    operation: receipt.operation,
    currentAcceptedIssueExternalId,
    currentAcceptedSourceRevision,
    providerIssueExternalId,
    providerSourceRevision,
    outcome: decision.outcome,
    nextAction: decision.nextAction,
    issue: decision.issue,
    receiptFingerprint,
    inputFingerprint,
    authorizesProviderMutation: false as const,
    authorizesContextAcceptance: false as const,
    grantsAuthority: false as const,
  };

  return deepFreeze({
    ...proposal,
    proposalFingerprint: fingerprintCanonicalRequest(proposal),
  });
}

function validateReceiptStateSemantics(receipt: GitHubProviderReceipt): void {
  if (receipt.state === "reserved") {
    if (
      receipt.result !== null
      || receipt.verification.state !== "not_run"
      || receipt.verification.checkedAt !== null
      || receipt.verification.sourceRevision !== null
    ) {
      throw new RangeError(
        "Reserved GitHub provider receipt must not contain result evidence",
      );
    }
    return;
  }
  if (receipt.state === "pending_reconciliation") {
    if (
      receipt.result !== null
      || receipt.verification.state !== "failed"
      || receipt.verification.sourceRevision !== null
    ) {
      throw new RangeError(
        "Pending GitHub provider receipt has contradictory result evidence",
      );
    }
    return;
  }
  if (receipt.state === "rejected") {
    if (
      receipt.result !== null
      || receipt.verification.state !== "not_run"
      || receipt.verification.checkedAt !== null
      || receipt.verification.sourceRevision !== null
    ) {
      throw new RangeError(
        "Rejected GitHub provider receipt must not contain result evidence",
      );
    }
    return;
  }
  if (receipt.state === "stale") {
    if (
      receipt.operation !== "github_update_issue"
      || !isIssueResult(receipt.result)
      || receipt.verification.state !== "failed"
      || receipt.verification.sourceRevision !== receipt.result.sourceRevision
    ) {
      throw new RangeError(
        "Stale GitHub provider receipt lacks exact current-issue readback evidence",
      );
    }
    return;
  }
  if (receipt.result === null || receipt.verification.state !== "passed") {
    throw new RangeError(
      "Settled GitHub provider receipt lacks verified provider readback",
    );
  }
  if (receipt.verification.sourceRevision !== receipt.result.sourceRevision) {
    throw new RangeError(
      "GitHub provider verification source revision does not match provider readback",
    );
  }
}

function decideReconciliation(
  receipt: GitHubProviderReceipt,
  issue: GitHubIssueContext | null,
  currentExternalId: string | null,
  currentSourceRevision: string | null,
): {
  outcome: GitHubProviderContextReconciliationOutcome;
  nextAction: GitHubProviderContextReconciliationNextAction;
  issue: GitHubIssueContext | null;
} {
  if (receipt.state === "reserved") {
    return {
      outcome: "await_provider_result",
      nextAction: "wait_for_provider_result",
      issue: null,
    };
  }
  if (receipt.state === "pending_reconciliation") {
    return {
      outcome: "pending_provider_reconciliation",
      nextAction: "reconcile_provider_operation",
      issue: null,
    };
  }
  if (
    receipt.state === "rejected"
    || receipt.operation === "github_add_issue_comment"
    || !issueEffectOperations.has(receipt.operation)
  ) {
    return noIssueEffect();
  }
  if (issue === null) {
    throw new RangeError(
      "Settled GitHub issue operation requires an admitted provider issue snapshot",
    );
  }

  requireIssueReadbackEvidence(receipt, issue);

  if (
    currentExternalId !== null
    && currentExternalId !== issue.reference.externalId
  ) {
    return {
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      issue: null,
    };
  }
  if (
    currentExternalId === issue.reference.externalId
    && currentSourceRevision === issue.sourceRevision
  ) {
    return {
      outcome: "already_current",
      nextAction: "none",
      issue: null,
    };
  }
  return {
    outcome: "propose_context_acceptance",
    nextAction: "accept_provider_issue_context",
    issue,
  };
}

function requireIssueReadbackEvidence(
  receipt: GitHubProviderReceipt,
  issue: GitHubIssueContext,
): void {
  if (receipt.verification.sourceRevision !== issue.sourceRevision) {
    throw new RangeError(
      "GitHub provider verification source revision does not match the issue snapshot",
    );
  }
  if (receipt.state === "stale") {
    if (receipt.verification.state !== "failed") {
      throw new RangeError(
        "Stale GitHub provider receipt requires failed verification evidence",
      );
    }
    return;
  }
  if (
    (receipt.state === "succeeded" || receipt.state === "reconciled")
    && receipt.verification.state === "passed"
  ) {
    return;
  }
  throw new RangeError(
    "Settled GitHub provider receipt lacks accepted issue readback evidence",
  );
}

function noIssueEffect(): {
  outcome: "no_issue_context_effect";
  nextAction: "none";
  issue: null;
} {
  return {
    outcome: "no_issue_context_effect",
    nextAction: "none",
    issue: null,
  };
}

function isIssueResult(
  value: GitHubProviderReceipt["result"],
): value is GitHubIssueContext {
  return value !== null && "containsIssueBody" in value;
}

function nullableExternalId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("Current accepted GitHub issue external ID is invalid");
  }
  const reference = parseGitHubIssueExternalId(value);
  if (reference.externalId !== value) {
    throw new RangeError(
      "Current accepted GitHub issue external ID must use canonical identity",
    );
  }
  return value;
}

function nullableSourceRevision(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || value.length > 512
    || unsafeTextPattern.test(value)
    || !sourceRevisionPattern.test(value)
  ) {
    throw new RangeError(
      "Current accepted GitHub issue source revision is invalid",
    );
  }
  return value;
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return value;
}
