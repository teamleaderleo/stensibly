import type {
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "./github-provider-contracts.js";
import {
  parseGitHubIssueExternalId,
  type GitHubIssueContext,
} from "./github-issue-context.js";
import { admitGitHubIssueContextSnapshot } from "./github-project-context-admission.js";
import { admitGitHubProviderReceipt } from "./github-provider-receipt-admission.js";
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
  | "await_provider_result"
  | "reconcile_provider_operation"
  | "none"
  | "submit_context_acceptance"
  | "inspect_issue_identity_conflict";

export interface CurrentGitHubIssueContextIdentityV1 {
  externalId: string;
  sourceRevision: string;
}

export interface GitHubProviderContextReconciliationInputV1 {
  schemaVersion: typeof GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1;
  receipt: GitHubProviderReceipt;
  current: CurrentGitHubIssueContextIdentityV1 | null;
}

export interface GitHubProviderContextReconciliationProposalV1 {
  schemaVersion: typeof GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1;
  project: string;
  repositoryFullName: string;
  receiptId: string;
  operation: GitHubIssueProviderOperation;
  actorId: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  verificationCheckedAt: string | null;
  externalId: string | null;
  currentSourceRevision: string | null;
  providerSourceRevision: string | null;
  outcome: GitHubProviderContextReconciliationOutcome;
  nextAction: GitHubProviderContextReconciliationNextAction;
  providerSnapshot: Readonly<GitHubIssueContext> | null;
  inputFingerprint: string;
  proposalFingerprint: string;
  authorizesProviderMutation: false;
  authorizesContextAcceptance: false;
  authorizesAuthority: false;
}

const inputKeys = ["schemaVersion", "receipt", "current"] as const;
const currentKeys = ["externalId", "sourceRevision"] as const;
const issueResultOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_labels",
  "github_remove_issue_label",
  "github_add_issue_assignees",
  "github_remove_issue_assignees",
]);
const receiptProducingOperations = new Set<GitHubIssueProviderOperation>([
  ...issueResultOperations,
  "github_add_issue_comment",
]);
const sourceRevisionPattern = /^[A-Za-z0-9._:/@#-]+$/u;
const credentialPattern =
  /(?:^|[._:/-])(?:(?:env|secret):\/\/|bearer(?:[._:/-]|$)|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-|eyJ[A-Za-z0-9_-]{8,}\.)/iu;

export function compileGitHubProviderContextReconciliation(
  value: unknown,
): GitHubProviderContextReconciliationProposalV1 {
  const input = exactRecord(value, inputKeys, "GitHub provider context reconciliation input");
  if (input.schemaVersion !== GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1) {
    throw new RangeError("GitHub provider context reconciliation schemaVersion must equal 1");
  }
  const receipt = admitGitHubProviderReceipt(input.receipt as GitHubProviderReceipt);
  assertReceiptLifecycleCoherence(receipt);
  const current = input.current === null ? null : admitCurrentIdentity(input.current);
  const inputFingerprint = fingerprintCanonicalRequest({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt,
    current,
  });

  const decision = decide(receipt, current);
  const body = {
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    project: receipt.project,
    repositoryFullName: receipt.repositoryFullName,
    receiptId: receipt.id,
    operation: receipt.operation,
    actorId: receipt.actorId,
    attachmentId: receipt.attachmentId,
    attachmentSnapshotSha256: receipt.attachmentSnapshotSha256,
    verificationCheckedAt: receipt.verification.checkedAt,
    externalId: decision.externalId,
    currentSourceRevision: current?.sourceRevision ?? null,
    providerSourceRevision: decision.providerSourceRevision,
    outcome: decision.outcome,
    nextAction: decision.nextAction,
    providerSnapshot: decision.providerSnapshot,
    inputFingerprint,
    authorizesProviderMutation: false as const,
    authorizesContextAcceptance: false as const,
    authorizesAuthority: false as const,
  };
  return deepFreeze({
    ...body,
    proposalFingerprint: fingerprintCanonicalRequest(body),
  });
}

interface Decision {
  externalId: string | null;
  providerSourceRevision: string | null;
  outcome: GitHubProviderContextReconciliationOutcome;
  nextAction: GitHubProviderContextReconciliationNextAction;
  providerSnapshot: GitHubIssueContext | null;
}

function decide(
  receipt: GitHubProviderReceipt,
  current: CurrentGitHubIssueContextIdentityV1 | null,
): Decision {
  if (receipt.state === "reserved") {
    return decision(
      null,
      null,
      "await_provider_result",
      "await_provider_result",
    );
  }
  if (receipt.state === "pending_reconciliation") {
    return decision(
      null,
      null,
      "pending_provider_reconciliation",
      "reconcile_provider_operation",
    );
  }
  if (receipt.state === "rejected") {
    return decision(
      null,
      null,
      "no_issue_context_effect",
      "none",
    );
  }
  if (receipt.operation === "github_add_issue_comment") {
    if (receipt.result === null || !("issueNumber" in receipt.result)) {
      throw new Error("Settled GitHub comment receipt requires an admitted comment result");
    }
    const expectedTarget =
      `${receipt.repositoryFullName}#${receipt.result.issueNumber}:comment:new`;
    if (receipt.target !== expectedTarget) {
      throw new Error(
        "Settled GitHub comment receipt target does not bind the provider result",
      );
    }
    return decision(
      null,
      null,
      "no_issue_context_effect",
      "none",
    );
  }
  if (!issueResultOperations.has(receipt.operation)) {
    throw new Error("GitHub operation does not produce reconcilable issue context");
  }
  if (receipt.result === null || !("reference" in receipt.result)) {
    throw new Error("Settled GitHub issue receipt requires an admitted issue result");
  }

  const snapshot = admitGitHubIssueContextSnapshot(receipt.result);
  assertSettledIssueReadback(receipt, snapshot);
  const externalId = snapshot.reference.externalId;
  if (current !== null && current.externalId !== externalId) {
    return decision(
      externalId,
      snapshot.sourceRevision,
      "identity_conflict",
      "inspect_issue_identity_conflict",
    );
  }
  if (current?.sourceRevision === snapshot.sourceRevision) {
    return decision(
      externalId,
      snapshot.sourceRevision,
      "already_current",
      "none",
    );
  }
  return decision(
    externalId,
    snapshot.sourceRevision,
    "propose_context_acceptance",
    "submit_context_acceptance",
    snapshot,
  );
}

function assertReceiptLifecycleCoherence(receipt: GitHubProviderReceipt): void {
  if (!receiptProducingOperations.has(receipt.operation)) {
    throw new Error("GitHub operation does not produce a provider write receipt");
  }

  const verification = receipt.verification;
  switch (receipt.state) {
    case "reserved":
      if (
        receipt.result !== null
        || verification.state !== "not_run"
        || verification.checkedAt !== null
        || verification.sourceRevision !== null
        || receipt.error !== null
        || receipt.recovery.nextAction !== "none"
      ) {
        throw new Error("Reserved GitHub provider receipt lifecycle is inconsistent");
      }
      return;
    case "pending_reconciliation": {
      const interruptedBeforeVerification =
        verification.state === "not_run"
        && verification.checkedAt === null
        && verification.sourceRevision === null
        && receipt.error?.code === "provider_dispatch_in_progress_or_interrupted";
      const ambiguousAfterDispatch =
        verification.state === "failed"
        && verification.checkedAt !== null
        && verification.sourceRevision === null
        && receipt.error?.code === "ambiguous_provider_outcome";
      if (
        receipt.result !== null
        || receipt.error === null
        || receipt.error.retry !== "reconcile_before_retry"
        || receipt.recovery.nextAction !== "reconcile_exact_operation"
        || (!interruptedBeforeVerification && !ambiguousAfterDispatch)
      ) {
        throw new Error(
          "Pending GitHub provider receipt lifecycle is inconsistent",
        );
      }
      return;
    }
    case "rejected":
      if (
        receipt.result !== null
        || verification.state !== "not_run"
        || verification.checkedAt !== null
        || verification.sourceRevision !== null
        || receipt.error === null
        || receipt.error.retry !== "do_not_retry"
        || receipt.recovery.nextAction
          !== "inspect_authority_or_provider_rejection"
      ) {
        throw new Error("Rejected GitHub provider receipt lifecycle is inconsistent");
      }
      return;
    case "stale":
      if (
        receipt.operation !== "github_update_issue"
        || receipt.result === null
        || !("reference" in receipt.result)
        || verification.state !== "failed"
        || verification.checkedAt === null
        || verification.sourceRevision !== receipt.result.sourceRevision
        || receipt.error?.code !== "stale_provider_version"
        || receipt.error.retry !== "do_not_retry"
        || receipt.recovery.nextAction
          !== "refresh_and_retry_with_new_version"
      ) {
        throw new Error("Stale GitHub provider receipt lifecycle is inconsistent");
      }
      return;
    case "succeeded":
    case "reconciled":
      if (
        receipt.result === null
        || verification.state !== "passed"
        || verification.checkedAt === null
        || verification.sourceRevision !== receipt.result.sourceRevision
        || receipt.error !== null
        || receipt.recovery.nextAction !== "none"
      ) {
        throw new Error("Settled GitHub provider receipt lifecycle is inconsistent");
      }
      return;
  }
}

function assertSettledIssueReadback(
  receipt: GitHubProviderReceipt,
  snapshot: GitHubIssueContext,
): void {
  if (snapshot.reference.repositoryFullName !== receipt.repositoryFullName) {
    throw new Error(
      "Settled GitHub issue receipt repository does not bind the provider result",
    );
  }
  const expectedTarget = expectedIssueTarget(
    receipt.operation,
    receipt.repositoryFullName,
    snapshot.reference.number,
  );
  if (receipt.target !== expectedTarget) {
    throw new Error(
      "Settled GitHub issue receipt target does not bind the provider result",
    );
  }

  const expectedVerification = receipt.state === "stale" ? "failed" : "passed";
  if (
    receipt.verification.state !== expectedVerification
    || receipt.verification.checkedAt === null
    || receipt.verification.sourceRevision !== snapshot.sourceRevision
  ) {
    throw new Error(
      "Settled GitHub issue receipt verification does not bind the provider result",
    );
  }
}

function expectedIssueTarget(
  operation: GitHubIssueProviderOperation,
  repositoryFullName: string,
  issueNumber: number,
): string {
  switch (operation) {
    case "github_create_issue":
      return `${repositoryFullName}#new`;
    case "github_update_issue":
      return `${repositoryFullName}#${issueNumber}`;
    case "github_add_issue_labels":
    case "github_remove_issue_label":
      return `${repositoryFullName}#${issueNumber}:labels`;
    case "github_add_issue_assignees":
    case "github_remove_issue_assignees":
      return `${repositoryFullName}#${issueNumber}:assignees`;
    default:
      throw new Error(
        "GitHub operation does not produce reconcilable issue context",
      );
  }
}

function decision(
  externalId: string | null,
  providerSourceRevision: string | null,
  outcome: GitHubProviderContextReconciliationOutcome,
  nextAction: GitHubProviderContextReconciliationNextAction,
  providerSnapshot: GitHubIssueContext | null = null,
): Decision {
  return {
    externalId,
    providerSourceRevision,
    outcome,
    nextAction,
    providerSnapshot,
  };
}

function admitCurrentIdentity(value: unknown): CurrentGitHubIssueContextIdentityV1 {
  const current = exactRecord(value, currentKeys, "Current GitHub issue context identity");
  if (typeof current.externalId !== "string") {
    throw new RangeError("Current GitHub issue external ID is invalid");
  }
  const externalId = parseGitHubIssueExternalId(current.externalId).externalId;
  if (externalId !== current.externalId) {
    throw new RangeError("Current GitHub issue external ID must be canonical");
  }
  if (
    typeof current.sourceRevision !== "string"
    || current.sourceRevision.length === 0
    || current.sourceRevision.length > 512
    || !sourceRevisionPattern.test(current.sourceRevision)
  ) {
    throw new RangeError("Current GitHub issue source revision is invalid");
  }
  if (credentialPattern.test(current.sourceRevision)) {
    throw new RangeError(
      "Current GitHub issue source revision cannot be credential-shaped",
    );
  }
  return Object.freeze({
    externalId,
    sourceRevision: current.sourceRevision,
  });
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.some((key) =>
      typeof key !== "string" || !(keys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError(`${label} contains unknown fields`);
  }
  if (ownKeys.length !== keys.length) {
    throw new TypeError(`${label} is missing required fields`);
  }
  const output = Object.create(null) as Record<string, unknown>;
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
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
