import { createHash, randomUUID } from "node:crypto";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
  type GitHubIssueContextInput,
} from "./github-issue-context.js";
import { normalizeRepositoryRemote } from "./project-contract.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";

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

export interface GitHubProviderRequestContext {
  project: string;
  repository: string;
  actorId: string;
  clientId: string;
  capabilityGrantId?: string;
  approvalId?: string;
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
    operation: GitHubIssueProviderOperation;
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
  operation: GitHubIssueProviderOperation;
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
  result: GitHubIssueContext | GitHubIssueComment | null;
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

export interface GitHubProviderReceiptStore {
  reserveGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceiptReservation>;
  updateGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceipt>;
  getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null>;
}

export class InMemoryGitHubProviderReceiptStore
  implements GitHubProviderReceiptStore {
  readonly #receipts = new Map<string, GitHubProviderReceipt>();

  async reserveGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceiptReservation> {
    const key = receiptKey(receipt.project, receipt.idempotencyKey);
    const current = this.#receipts.get(key);
    if (!current) {
      this.#receipts.set(key, clone(receipt));
      return { outcome: "reserved", receipt: clone(receipt) };
    }
    const outcome = current.operation === receipt.operation
        && current.parametersSha256 === receipt.parametersSha256
      ? "replay"
      : "conflict";
    return { outcome, receipt: clone(current) };
  }

  async updateGitHubProviderReceipt(
    receipt: GitHubProviderReceipt,
  ): Promise<GitHubProviderReceipt> {
    const key = receiptKey(receipt.project, receipt.idempotencyKey);
    if (!this.#receipts.has(key)) {
      throw new Error("GitHub provider receipt must be reserved before update");
    }
    this.#receipts.set(key, clone(receipt));
    return clone(receipt);
  }

  async getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null> {
    return clone(this.#receipts.get(receiptKey(project, idempotencyKey)) ?? null);
  }
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
  readonly receipt: GitHubProviderReceipt;

  constructor(receipt: GitHubProviderReceipt) {
    super("GitHub provider idempotency key was reused with different parameters");
    this.name = "GitHubProviderIdempotencyConflictError";
    this.receipt = receipt;
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
    this.code = boundedToken(code, "GitHub provider rejection code", 120);
  }
}

interface ResolvedScope {
  project: string;
  repositoryFullName: string;
  attachment: ProjectAttachmentRecord;
  binding: GitHubProjectRepositoryBinding;
  connection: GitHubProviderConnection;
  authority: GitHubProviderAuthorityDecision;
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

export class GitHubIssueProviderService {
  readonly #projects: GitHubProviderProjectReader;
  readonly #bindings: GitHubProviderBindingStore;
  readonly #authority: GitHubProviderAuthority;
  readonly #adapter: GitHubIssueProviderAdapter;
  readonly #receipts: GitHubProviderReceiptStore;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(dependencies: GitHubIssueProviderServiceDependencies) {
    this.#projects = dependencies.projects;
    this.#bindings = dependencies.bindings;
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#receipts = dependencies.receipts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#idFactory = dependencies.idFactory ?? (() => `ghop_${randomUUID()}`);
  }

  async listIssues(input: GitHubProviderRequestContext & {
    state?: "open" | "closed" | "all";
    labels?: string[];
    assignees?: string[];
    cursor?: string;
    limit?: number;
  }): Promise<{ issues: GitHubIssueContext[]; nextCursor: string | null }> {
    const scope = await this.#resolveScope(input, "github_list_issues");
    const page = await this.#adapter.listIssues({
      repositoryFullName: scope.repositoryFullName,
      ...(input.state ? { state: input.state } : {}),
      ...(input.labels ? { labels: canonicalStringList(input.labels, 100, 100) } : {}),
      ...(input.assignees ? { assignees: canonicalLogins(input.assignees) } : {}),
      ...(input.cursor ? { cursor: boundedText(input.cursor, "GitHub issue cursor", 512) } : {}),
      limit: boundedLimit(input.limit ?? 30),
    });
    return {
      issues: page.issues.map((issue) => buildGitHubIssueContext(issue)),
      nextCursor: page.nextCursor,
    };
  }

  async searchIssues(input: GitHubProviderRequestContext & {
    query: string;
    state?: "open" | "closed" | "all";
    cursor?: string;
    limit?: number;
  }): Promise<{ issues: GitHubIssueContext[]; nextCursor: string | null }> {
    const scope = await this.#resolveScope(input, "github_search_issues");
    const page = await this.#adapter.searchIssues({
      repositoryFullName: scope.repositoryFullName,
      query: boundedText(input.query, "GitHub issue search query", 512),
      ...(input.state ? { state: input.state } : {}),
      ...(input.cursor ? { cursor: boundedText(input.cursor, "GitHub issue cursor", 512) } : {}),
      limit: boundedLimit(input.limit ?? 30),
    });
    return {
      issues: page.issues.map((issue) => buildGitHubIssueContext(issue)),
      nextCursor: page.nextCursor,
    };
  }

  async getIssue(input: GitHubProviderRequestContext & {
    issueNumber: number;
  }): Promise<GitHubIssueContext> {
    const scope = await this.#resolveScope(input, "github_get_issue");
    return buildGitHubIssueContext(await this.#adapter.getIssue({
      repositoryFullName: scope.repositoryFullName,
      issueNumber: positiveInteger(input.issueNumber, "GitHub issue number"),
    }));
  }

  async createIssue(input: GitHubProviderRequestContext & {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    const title = boundedText(input.title, "GitHub issue title", 256);
    const body = input.body === undefined
      ? undefined
      : boundedBody(input.body, "GitHub issue body", 128 * 1024);
    const labels = canonicalStringList(input.labels ?? [], 100, 100);
    const assignees = canonicalLogins(input.assignees ?? []);
    return await this.#executeWrite({
      context: input,
      operation: "github_create_issue",
      target: `${normalizeGitHubRepository(input.repository)}#new`,
      idempotencyKey: input.idempotencyKey,
      parameters: { title, body: body ?? null, labels, assignees },
      execute: async (scope, key) => {
        const created = await this.#adapter.createIssue({
          repositoryFullName: scope.repositoryFullName,
          title,
          ...(body === undefined ? {} : { body }),
          labels,
          assignees,
          idempotencyKey: key,
        });
        const number = positiveInteger(created.issue.number, "Created GitHub issue number");
        const readback = await this.#adapter.getIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber: number,
        });
        verifyIssueFields(readback, { title, body, labels, assignees });
        return {
          result: buildGitHubIssueContext(readback),
          providerRequestId: created.providerRequestId ?? null,
        };
      },
    });
  }

  async updateIssue(input: GitHubProviderRequestContext & {
    issueNumber: number;
    expectedSourceRevision: string;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened" | null;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const expectedSourceRevision = boundedText(
      input.expectedSourceRevision,
      "Expected GitHub issue source revision",
      512,
    );
    const title = input.title === undefined
      ? undefined
      : boundedText(input.title, "GitHub issue title", 256);
    const body = input.body === undefined
      ? undefined
      : boundedBody(input.body, "GitHub issue body", 128 * 1024);
    if (title === undefined && body === undefined && input.state === undefined) {
      throw new RangeError("GitHub issue update must change title, body, or state");
    }
    return await this.#executeWrite({
      context: input,
      operation: "github_update_issue",
      target: `${normalizeGitHubRepository(input.repository)}#${issueNumber}`,
      idempotencyKey: input.idempotencyKey,
      parameters: {
        issueNumber,
        expectedSourceRevision,
        title: title ?? null,
        body: body ?? null,
        state: input.state ?? null,
        stateReason: input.stateReason ?? null,
      },
      execute: async (scope, key) => {
        const currentInput = await this.#adapter.getIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
        });
        const current = buildGitHubIssueContext(currentInput);
        if (current.sourceRevision !== expectedSourceRevision) {
          throw new GitHubProviderStaleVersionError(current);
        }
        const updated = await this.#adapter.updateIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.stateReason === undefined ? {} : { stateReason: input.stateReason }),
          expectedSourceRevision,
          idempotencyKey: key,
        });
        const readback = await this.#adapter.getIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
        });
        verifyIssueFields(readback, {
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.stateReason === undefined ? {} : { stateReason: input.stateReason }),
        });
        return {
          result: buildGitHubIssueContext(readback),
          providerRequestId: updated.providerRequestId ?? null,
        };
      },
    });
  }

  async addIssueComment(input: GitHubProviderRequestContext & {
    issueNumber: number;
    body: string;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const body = boundedBody(input.body, "GitHub issue comment", 64 * 1024);
    return await this.#executeWrite({
      context: input,
      operation: "github_add_issue_comment",
      target: `${normalizeGitHubRepository(input.repository)}#${issueNumber}:comment:new`,
      idempotencyKey: input.idempotencyKey,
      parameters: { issueNumber, body },
      execute: async (scope, key) => {
        const created = await this.#adapter.addIssueComment({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          body,
          idempotencyKey: key,
        });
        const readback = await this.#adapter.getIssueComment({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          commentId: created.comment.id,
        });
        if (canonicalBody(readback.body) !== canonicalBody(body)) {
          throw new Error("GitHub issue comment readback did not match the requested body");
        }
        return {
          result: buildGitHubIssueComment(readback),
          providerRequestId: created.providerRequestId ?? null,
        };
      },
    });
  }

  async addIssueLabels(input: GitHubProviderRequestContext & {
    issueNumber: number;
    labels: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    return await this.#mutateIssueSet({
      context: input,
      issueNumber: input.issueNumber,
      values: canonicalStringList(input.labels, 100, 100),
      field: "labels",
      operation: "github_add_issue_labels",
      idempotencyKey: input.idempotencyKey,
      mutate: (scope, issueNumber, values, key) => this.#adapter.addIssueLabels({
        repositoryFullName: scope.repositoryFullName,
        issueNumber,
        labels: values,
        idempotencyKey: key,
      }),
      expected: (before, values) => canonicalStringList([...before.labels, ...values], 100, 100),
    });
  }

  async removeIssueLabel(input: GitHubProviderRequestContext & {
    issueNumber: number;
    label: string;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    const label = boundedText(input.label, "GitHub issue label", 100);
    return await this.#mutateIssueSet({
      context: input,
      issueNumber: input.issueNumber,
      values: [label],
      field: "labels",
      operation: "github_remove_issue_label",
      idempotencyKey: input.idempotencyKey,
      mutate: (scope, issueNumber, _values, key) => this.#adapter.removeIssueLabel({
        repositoryFullName: scope.repositoryFullName,
        issueNumber,
        label,
        idempotencyKey: key,
      }),
      expected: (before) => before.labels.filter((entry) => entry !== label),
    });
  }

  async addIssueAssignees(input: GitHubProviderRequestContext & {
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    return await this.#mutateIssueSet({
      context: input,
      issueNumber: input.issueNumber,
      values: canonicalLogins(input.assignees),
      field: "assignees",
      operation: "github_add_issue_assignees",
      idempotencyKey: input.idempotencyKey,
      mutate: (scope, issueNumber, values, key) => this.#adapter.addIssueAssignees({
        repositoryFullName: scope.repositoryFullName,
        issueNumber,
        assignees: values,
        idempotencyKey: key,
      }),
      expected: (before, values) => canonicalLogins([...before.assignees, ...values]),
    });
  }

  async removeIssueAssignees(input: GitHubProviderRequestContext & {
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    const assignees = canonicalLogins(input.assignees);
    return await this.#mutateIssueSet({
      context: input,
      issueNumber: input.issueNumber,
      values: assignees,
      field: "assignees",
      operation: "github_remove_issue_assignees",
      idempotencyKey: input.idempotencyKey,
      mutate: (scope, issueNumber, values, key) => this.#adapter.removeIssueAssignees({
        repositoryFullName: scope.repositoryFullName,
        issueNumber,
        assignees: values,
        idempotencyKey: key,
      }),
      expected: (before, values) => before.assignees.filter((entry) => !values.includes(entry)),
    });
  }

  async #mutateIssueSet(input: {
    context: GitHubProviderRequestContext;
    issueNumber: number;
    values: string[];
    field: "labels" | "assignees";
    operation:
      | "github_add_issue_labels"
      | "github_remove_issue_label"
      | "github_add_issue_assignees"
      | "github_remove_issue_assignees";
    idempotencyKey: string;
    mutate: (
      scope: ResolvedScope,
      issueNumber: number,
      values: string[],
      key: string,
    ) => Promise<{ issue: GitHubIssueContextInput; providerRequestId?: string }>;
    expected: (before: GitHubIssueContext, values: string[]) => string[];
  }): Promise<GitHubProviderReceipt> {
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    if (input.values.length === 0) {
      throw new RangeError(`GitHub issue ${input.field} mutation requires at least one value`);
    }
    return await this.#executeWrite({
      context: input.context,
      operation: input.operation,
      target: `${normalizeGitHubRepository(input.context.repository)}#${issueNumber}:${input.field}`,
      idempotencyKey: input.idempotencyKey,
      parameters: { issueNumber, values: input.values },
      execute: async (scope, key) => {
        const before = buildGitHubIssueContext(await this.#adapter.getIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
        }));
        const expected = input.expected(before, input.values);
        const mutated = await input.mutate(scope, issueNumber, input.values, key);
        const readback = await this.#adapter.getIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
        });
        const actual = input.field === "labels"
          ? canonicalStringList(readback.labels ?? [], 100, 100)
          : canonicalLogins(readback.assignees ?? []);
        if (stableJson(actual) !== stableJson(expected)) {
          throw new Error(`GitHub issue ${input.field} readback did not match the requested mutation`);
        }
        return {
          result: buildGitHubIssueContext(readback),
          providerRequestId: mutated.providerRequestId ?? null,
        };
      },
    });
  }

  async #executeWrite(input: {
    context: GitHubProviderRequestContext;
    operation: Exclude<GitHubIssueProviderOperation,
      "github_list_issues" | "github_search_issues" | "github_get_issue">;
    target: string;
    idempotencyKey: string;
    parameters: unknown;
    execute: (
      scope: ResolvedScope,
      idempotencyKey: string,
    ) => Promise<{
      result: GitHubIssueContext | GitHubIssueComment;
      providerRequestId: string | null;
    }>;
  }): Promise<GitHubProviderReceipt> {
    const scope = await this.#resolveScope(input.context, input.operation);
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "GitHub provider idempotency key",
      240,
    );
    const now = this.#now();
    const reserved: GitHubProviderReceipt = {
      version: 1,
      id: boundedText(this.#idFactory(), "GitHub provider receipt ID", 240),
      project: scope.project,
      provider: "github",
      repositoryFullName: scope.repositoryFullName,
      operation: input.operation,
      target: boundedText(input.target, "GitHub provider target", 512),
      actorId: boundedText(input.context.actorId, "GitHub provider actor ID", 120),
      clientId: boundedText(input.context.clientId, "GitHub provider client ID", 240),
      connectionId: scope.connection.id,
      installationId: scope.connection.installationId,
      bindingId: scope.binding.id,
      attachmentId: scope.attachment.id,
      attachmentSnapshotSha256: scope.attachment.snapshot.snapshotSha256,
      capabilityGrantId: scope.authority.capabilityGrantId
        ?? input.context.capabilityGrantId
        ?? null,
      approvalId: scope.authority.approvalId ?? input.context.approvalId ?? null,
      idempotencyKey,
      parametersSha256: sha256(stableJson({
        operation: input.operation,
        target: input.target,
        parameters: input.parameters,
      })),
      state: "reserved",
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
      providerRequestId: null,
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: null,
      recovery: { nextAction: "none" },
    };
    const reservation = await this.#receipts.reserveGitHubProviderReceipt(reserved);
    if (reservation.outcome === "conflict") {
      throw new GitHubProviderIdempotencyConflictError(reservation.receipt);
    }
    if (reservation.outcome === "replay") {
      if (reservation.receipt.state === "pending_reconciliation") {
        throw new GitHubProviderPendingReconciliationError(reservation.receipt);
      }
      return reservation.receipt;
    }

    try {
      const executed = await input.execute(scope, idempotencyKey);
      return await this.#receipts.updateGitHubProviderReceipt({
        ...reserved,
        state: "succeeded",
        updatedAt: this.#now(),
        providerRequestId: executed.providerRequestId,
        result: executed.result,
        verification: {
          state: "passed",
          checkedAt: this.#now(),
          sourceRevision: executed.result.sourceRevision,
        },
      });
    } catch (error) {
      if (error instanceof GitHubProviderStaleVersionError) {
        const stale = await this.#receipts.updateGitHubProviderReceipt({
          ...reserved,
          state: "stale",
          updatedAt: this.#now(),
          result: error.current,
          verification: {
            state: "failed",
            checkedAt: this.#now(),
            sourceRevision: error.current.sourceRevision,
          },
          error: {
            code: "stale_provider_version",
            message: error.message,
            retry: "do_not_retry",
          },
          recovery: { nextAction: "refresh_and_retry_with_new_version" },
        });
        return stale;
      }
      if (error instanceof GitHubProviderRejectedError) {
        return await this.#receipts.updateGitHubProviderReceipt({
          ...reserved,
          state: "rejected",
          updatedAt: this.#now(),
          error: {
            code: error.code,
            message: boundedText(error.message, "GitHub provider rejection", 1_000),
            retry: "do_not_retry",
          },
          recovery: {
            nextAction: "inspect_authority_or_provider_rejection",
          },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      const pending = await this.#receipts.updateGitHubProviderReceipt({
        ...reserved,
        state: "pending_reconciliation",
        updatedAt: this.#now(),
        verification: {
          state: "failed",
          checkedAt: this.#now(),
          sourceRevision: null,
        },
        error: {
          code: "ambiguous_provider_outcome",
          message: boundedText(message, "GitHub provider ambiguity", 1_000),
          retry: "reconcile_before_retry",
        },
        recovery: { nextAction: "reconcile_exact_operation" },
      });
      throw new GitHubProviderPendingReconciliationError(pending);
    }
  }

  async #resolveScope(
    context: GitHubProviderRequestContext,
    operation: GitHubIssueProviderOperation,
  ): Promise<ResolvedScope> {
    const project = projectSlug(context.project);
    const repositoryFullName = normalizeGitHubRepository(context.repository);
    const attachment = await this.#projects.getProjectAttachment(project);
    if (!attachment) {
      throw new GitHubProviderBindingError(
        `Project ${project} has no accepted repository attachment`,
      );
    }
    const declared = attachment.snapshot.contract.repositories
      .map((repository) => normalizeRepositoryRemote(repository))
      .filter((repository): repository is string => repository !== null)
      .map((repository) => repository.toLowerCase());
    if (!declared.includes(repositoryFullName)) {
      throw new GitHubProviderBindingError(
        `Repository ${repositoryFullName} is outside the accepted project attachment`,
      );
    }
    const binding = await this.#bindings.getGitHubProjectRepositoryBinding(
      project,
      repositoryFullName,
    );
    if (!binding || binding.status !== "active") {
      throw new GitHubProviderBindingError(
        `Repository ${repositoryFullName} has no active GitHub provider binding`,
      );
    }
    if (
      binding.project !== project
      || normalizeGitHubRepository(binding.repositoryFullName) !== repositoryFullName
      || binding.attachmentId !== attachment.id
      || binding.attachmentSnapshotSha256 !== attachment.snapshot.snapshotSha256
    ) {
      throw new GitHubProviderBindingError(
        "GitHub provider binding is stale against the accepted project attachment",
      );
    }
    const connection = await this.#bindings.getGitHubProviderConnection(
      binding.connectionId,
    );
    if (!connection || connection.status !== "active") {
      throw new GitHubProviderBindingError(
        "GitHub provider connection is unavailable or inactive",
      );
    }
    const accessible = connection.repositoryFullNames
      .map(normalizeGitHubRepository)
      .includes(repositoryFullName);
    if (!accessible) {
      throw new GitHubProviderBindingError(
        `GitHub installation ${connection.installationId} no longer exposes ${repositoryFullName}`,
      );
    }
    const authority = await this.#authority.authorizeGitHubOperation({
      project,
      repositoryFullName,
      operation,
      actorId: boundedText(context.actorId, "GitHub provider actor ID", 120),
      clientId: boundedText(context.clientId, "GitHub provider client ID", 240),
      ...(context.capabilityGrantId
        ? { capabilityGrantId: boundedText(context.capabilityGrantId, "Capability grant ID", 240) }
        : {}),
      ...(context.approvalId
        ? { approvalId: boundedText(context.approvalId, "Approval ID", 240) }
        : {}),
    });
    if (!authority.allowed) {
      throw new GitHubProviderAuthorityError(
        authority.reason?.trim() || `Operation ${operation} is outside current authority`,
      );
    }
    return {
      project,
      repositoryFullName,
      attachment,
      binding,
      connection,
      authority,
    };
  }
}

export function buildGitHubIssueComment(
  input: GitHubIssueCommentInput,
): GitHubIssueComment {
  const body = canonicalBody(input.body);
  return Object.freeze({
    id: boundedText(input.id, "GitHub issue comment ID", 240),
    issueNumber: positiveInteger(input.issueNumber, "GitHub issue number"),
    canonicalUrl: boundedUrl(input.canonicalUrl, "GitHub issue comment URL"),
    createdAt: isoTimestamp(input.createdAt, "GitHub issue comment created time"),
    updatedAt: isoTimestamp(input.updatedAt, "GitHub issue comment updated time"),
    sourceRevision: boundedText(
      input.sourceRevision,
      "GitHub issue comment source revision",
      512,
    ),
    bodyRevision: {
      byteLength: Buffer.byteLength(body, "utf8"),
      sha256: sha256(body),
    },
    containsBody: false as const,
  });
}

export function normalizeGitHubRepository(value: string): string {
  const normalized = normalizeRepositoryRemote(value);
  if (!normalized || !/^[^/]+\/[^/]+$/.test(normalized)) {
    throw new RangeError("Use one canonical GitHub owner/repository identifier");
  }
  return normalized.toLowerCase();
}

function verifyIssueFields(
  issue: GitHubIssueContextInput,
  expected: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened" | null;
    labels?: string[];
    assignees?: string[];
  },
): void {
  if (expected.title !== undefined && issue.title !== expected.title) {
    throw new Error("GitHub issue title readback did not match the requested value");
  }
  if (
    expected.body !== undefined
    && canonicalBody(issue.body ?? "") !== canonicalBody(expected.body)
  ) {
    throw new Error("GitHub issue body readback did not match the requested value");
  }
  if (expected.state !== undefined && issue.state !== expected.state) {
    throw new Error("GitHub issue state readback did not match the requested value");
  }
  if (
    expected.stateReason !== undefined
    && (issue.stateReason ?? null) !== expected.stateReason
  ) {
    throw new Error("GitHub issue state reason readback did not match the requested value");
  }
  if (
    expected.labels !== undefined
    && stableJson(canonicalStringList(issue.labels ?? [], 100, 100))
      !== stableJson(expected.labels)
  ) {
    throw new Error("GitHub issue labels readback did not match the requested values");
  }
  if (
    expected.assignees !== undefined
    && stableJson(canonicalLogins(issue.assignees ?? []))
      !== stableJson(expected.assignees)
  ) {
    throw new Error("GitHub issue assignees readback did not match the requested values");
  }
}

function projectSlug(value: string): string {
  const project = boundedText(value, "Project slug", 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(project)) {
    throw new RangeError("Use a lowercase project slug");
  }
  return project;
}

function canonicalStringList(
  values: readonly string[],
  maximum: number,
  valueMaximum: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new RangeError(`GitHub provider list accepts at most ${maximum} values`);
  }
  return [...new Set(values.map((value) => boundedText(
    value,
    "GitHub provider list value",
    valueMaximum,
  )))].sort(codeUnitCompare);
}

function canonicalLogins(values: readonly string[]): string[] {
  return canonicalStringList(values, 100, 39).map((value) => {
    const login = value.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login)) {
      throw new RangeError(`GitHub login is invalid: ${value}`);
    }
    return login;
  }).sort(codeUnitCompare);
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError("GitHub issue page limit must be between 1 and 100");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${label} must contain 1 to ${maximum} characters`);
  }
  if (/\p{Cc}|\p{Cf}/u.test(normalized)) {
    throw new RangeError(`${label} contains unsafe characters`);
  }
  return normalized;
}

function boundedToken(value: string, label: string, maximum: number): string {
  const token = boundedText(value, label, maximum);
  if (!/^[A-Za-z0-9._:-]+$/.test(token)) {
    throw new RangeError(`${label} is invalid`);
  }
  return token;
}

function boundedBody(value: string, label: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const normalized = canonicalBody(value);
  if (!normalized.trim()) throw new RangeError(`${label} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new RangeError(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  if (/\u0000/.test(normalized)) throw new RangeError(`${label} contains NUL bytes`);
  return normalized;
}

function canonicalBody(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function boundedUrl(value: string, label: string): string {
  const text = boundedText(value, label, 4_096);
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new RangeError(`${label} must be a credential-free HTTPS URL`);
  }
  return url.toString();
}

function isoTimestamp(value: string, label: string): string {
  const text = boundedText(value, label, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new RangeError(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return text;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => codeUnitCompare(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function receiptKey(project: string, idempotencyKey: string): string {
  return `${project}\u0000${idempotencyKey}`;
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}
