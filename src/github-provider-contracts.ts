import type {
  GitHubIssueContext,
  GitHubIssueContextInput,
} from "./github-issue-context.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import type {
  RepositoryWriteProviderResult,
  RepositoryWriteRefReader,
  VerifiedRepositoryWrite,
} from "./repository-write-fence.js";

export const githubIssueProviderOperations = [
  "github_list_issues",
  "github_search_issues",
  "github_get_issue",
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
  "github_add_issue_labels",
  "github_remove_issue_label",
  "github_add_issue_assignees",
  "github_remove_issue_assignees",
] as const;

export type GitHubIssueProviderOperation =
  typeof githubIssueProviderOperations[number];

export const githubRepositoryWriteOperations = [
  "github_create_repository_file",
  "github_update_repository_file",
  "github_delete_repository_file",
] as const;

export type GitHubRepositoryWriteOperation =
  typeof githubRepositoryWriteOperations[number];

export type GitHubProviderOperation =
  | GitHubIssueProviderOperation
  | GitHubRepositoryWriteOperation;

export interface GitHubProviderRequestContext {
  project: string;
  repository: string;
  actorId: string;
  clientId: string;
  capabilityGrantId?: string;
  approvalId?: string;
}

export interface GitHubProviderReceiptLookupInput {
  project: string;
  idempotencyKey: string;
  actorId: string;
  clientId: string;
}

export interface GitHubProviderConnection {
  id: string;
  provider: "github";
  installationId: string;
  accountLogin: string;
  credentialRef: string;
  status: "active" | "suspended" | "revoked";
  repositoryFullNames: string[];
  observedAt: string;
}

export interface GitHubProjectRepositoryBinding {
  id: string;
  project: string;
  repositoryFullName: string;
  connectionId: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  status: "active" | "revoked";
  acceptedAt: string;
}

export interface GitHubProviderBindingStore {
  getGitHubProjectRepositoryBinding(
    project: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null>;
  getGitHubProviderConnection(id: string): Promise<GitHubProviderConnection | null>;
}

export interface GitHubProviderProjectReader {
  getProjectAttachment(project: string): Promise<ProjectAttachmentRecord | null>;
}

export interface GitHubProviderAuthorityDecision {
  allowed: boolean;
  reason?: string;
  capabilityGrantId?: string;
  approvalId?: string;
}

export interface GitHubProviderAuthority {
  authorizeGitHubOperation(input: {
    project: string;
    repositoryFullName: string;
    operation: GitHubProviderOperation;
    actorId: string;
    clientId: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<GitHubProviderAuthorityDecision>;
}

export interface GitHubIssueProviderPage {
  issues: GitHubIssueContextInput[];
  nextCursor: string | null;
  providerRequestId?: string;
}

export interface GitHubIssueCommentInput {
  id: string;
  issueNumber: number;
  body: string;
  canonicalUrl: string;
  createdAt: string;
  updatedAt: string;
  sourceRevision: string;
}

export interface GitHubIssueComment {
  id: string;
  issueNumber: number;
  canonicalUrl: string;
  createdAt: string;
  updatedAt: string;
  sourceRevision: string;
  bodyRevision: {
    byteLength: number;
    sha256: string;
  };
  containsBody: false;
}

export interface GitHubIssueProviderAdapter {
  listIssues(input: {
    repositoryFullName: string;
    state?: "open" | "closed" | "all";
    labels?: string[];
    assignees?: string[];
    cursor?: string;
    limit: number;
  }): Promise<GitHubIssueProviderPage>;
  searchIssues(input: {
    repositoryFullName: string;
    query: string;
    state?: "open" | "closed" | "all";
    cursor?: string;
    limit: number;
  }): Promise<GitHubIssueProviderPage>;
  getIssue(input: {
    repositoryFullName: string;
    issueNumber: number;
  }): Promise<GitHubIssueContextInput>;
  createIssue(input: {
    repositoryFullName: string;
    title: string;
    body?: string;
    labels: string[];
    assignees: string[];
    idempotencyKey: string;
  }): Promise<{ issue: GitHubIssueContextInput; providerRequestId?: string }>;
  updateIssue(input: {
    repositoryFullName: string;
    issueNumber: number;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened" | null;
    expectedSourceRevision: string;
    idempotencyKey: string;
  }): Promise<{ issue: GitHubIssueContextInput; providerRequestId?: string }>;
  addIssueComment(input: {
    repositoryFullName: string;
    issueNumber: number;
    body: string;
    idempotencyKey: string;
  }): Promise<{ comment: GitHubIssueCommentInput; providerRequestId?: string }>;
  getIssueComment(input: {
    repositoryFullName: string;
    issueNumber: number;
    commentId: string;
  }): Promise<GitHubIssueCommentInput>;
  addIssueLabels(input: {
    repositoryFullName: string;
    issueNumber: number;
    labels: string[];
    idempotencyKey: string;
  }): Promise<{ issue: GitHubIssueContextInput; providerRequestId?: string }>;
  removeIssueLabel(input: {
    repositoryFullName: string;
    issueNumber: number;
    label: string;
    idempotencyKey: string;
  }): Promise<{ issue: GitHubIssueContextInput; providerRequestId?: string }>;
  addIssueAssignees(input: {
    repositoryFullName: string;
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }): Promise<{ issue: GitHubIssueContextInput; providerRequestId?: string }>;
  removeIssueAssignees(input: {
    repositoryFullName: string;
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }): Promise<{ issue: GitHubIssueContextInput; providerRequestId?: string }>;
}


export interface GitHubRepositoryWriteAdapter extends RepositoryWriteRefReader {
  createFile(input: {
    repositoryFullName: string;
    path: string;
    content: string;
    message: string;
    targetRef: string;
    idempotencyKey: string;
  }): Promise<RepositoryWriteProviderResult>;
  updateFile(input: {
    repositoryFullName: string;
    path: string;
    content: string;
    message: string;
    contentSha: string;
    targetRef: string;
    idempotencyKey: string;
  }): Promise<RepositoryWriteProviderResult>;
  deleteFile(input: {
    repositoryFullName: string;
    path: string;
    message: string;
    contentSha: string;
    targetRef: string;
    idempotencyKey: string;
  }): Promise<RepositoryWriteProviderResult>;
}

export type GitHubProviderReceiptState =
  | "reserved"
  | "succeeded"
  | "rejected"
  | "stale"
  | "pending_reconciliation"
  | "reconciled";

export interface GitHubProviderReceipt {
  version: 1;
  id: string;
  project: string;
  provider: "github";
  repositoryFullName: string;
  operation: GitHubProviderOperation;
  target: string;
  actorId: string;
  clientId: string;
  connectionId: string;
  installationId: string;
  bindingId: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  capabilityGrantId: string | null;
  approvalId: string | null;
  idempotencyKey: string;
  parametersSha256: string;
  state: GitHubProviderReceiptState;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  providerRequestId: string | null;
  result: GitHubIssueContext | GitHubIssueComment | VerifiedRepositoryWrite | null;
  verification: {
    state: "not_run" | "passed" | "failed";
    checkedAt: string | null;
    sourceRevision: string | null;
  };
  error: {
    code: string;
    message: string;
    retry: "do_not_retry" | "reconcile_before_retry";
  } | null;
  recovery: {
    nextAction:
      | "none"
      | "refresh_and_retry_with_new_version"
      | "inspect_authority_or_provider_rejection"
      | "reconcile_exact_operation";
  };
}

export interface GitHubProviderReceiptReservation {
  receipt: GitHubProviderReceipt;
  outcome: "reserved" | "replay" | "conflict";
}

export interface GitHubRepositoryWriteLane {
  project: string;
  repositoryFullName: string;
  targetRef: string;
  receiptId: string;
  idempotencyKey: string;
  expectedParentSha: string;
  reservedAt: string;
}

export interface GitHubRepositoryWriteLaneReservation {
  outcome: "reserved" | "blocked";
  lane: GitHubRepositoryWriteLane;
}

export interface GitHubProviderReceiptStore {
  reserveGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceiptReservation>;
  reserveGitHubRepositoryWriteLane(
    lane: GitHubRepositoryWriteLane,
  ): Promise<GitHubRepositoryWriteLaneReservation>;
  releaseGitHubRepositoryWriteLane(input: {
    project: string;
    repositoryFullName: string;
    targetRef: string;
    receiptId: string;
  }): Promise<void>;
  updateGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceipt>;
  getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null>;
}

export interface GitHubRepositoryWriteProviderServiceDependencies {
  projects: GitHubProviderProjectReader;
  bindings: GitHubProviderBindingStore;
  authority: GitHubProviderAuthority;
  adapter: GitHubRepositoryWriteAdapter;
  receipts: GitHubProviderReceiptStore;
  now?: () => string;
  idFactory?: () => string;
}

export interface GitHubIssueProviderServiceDependencies {
  projects: GitHubProviderProjectReader;
  bindings: GitHubProviderBindingStore;
  authority: GitHubProviderAuthority;
  adapter: GitHubIssueProviderAdapter;
  receipts: GitHubProviderReceiptStore;
  now?: () => string;
  idFactory?: () => string;
}

export class GitHubProviderBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubProviderBindingError";
  }
}

export class GitHubProviderAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubProviderAuthorityError";
  }
}

export class GitHubProviderIdempotencyConflictError extends Error {
  constructor(_receipt: GitHubProviderReceipt) {
    super("GitHub provider idempotency key was reused by another request");
    this.name = "GitHubProviderIdempotencyConflictError";
  }
}

export class GitHubProviderPendingReconciliationError extends Error {
  readonly receipt: GitHubProviderReceipt;

  constructor(receipt: GitHubProviderReceipt) {
    super("GitHub provider operation requires reconciliation before retry");
    this.name = "GitHubProviderPendingReconciliationError";
    this.receipt = receipt;
  }
}

export class GitHubProviderStaleVersionError extends Error {
  readonly current: GitHubIssueContext;

  constructor(current: GitHubIssueContext) {
    super("GitHub issue source revision changed before the guarded update");
    this.name = "GitHubProviderStaleVersionError";
    this.current = current;
  }
}

export class GitHubProviderRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubProviderRejectedError";
    const normalized = code.trim();
    if (!normalized || normalized.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new RangeError("GitHub provider rejection code is invalid");
    }
    this.code = normalized;
  }
}
