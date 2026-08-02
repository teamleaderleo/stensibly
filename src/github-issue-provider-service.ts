import { randomUUID } from "node:crypto";
import type {
  GitHubIssueContext,
  GitHubIssueContextInput,
} from "./github-issue-context.js";
import { normalizeRepositoryRemote } from "./project-contract.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import {
  GitHubProviderAuthorityError,
  GitHubProviderBindingError,
  GitHubProviderIdempotencyConflictError,
  GitHubProviderPendingReconciliationError,
  GitHubProviderRejectedError,
  GitHubProviderStaleVersionError,
  type GitHubIssueComment,
  type GitHubIssueProviderOperation,
  type GitHubIssueProviderServiceDependencies,
  type GitHubProjectRepositoryBinding,
  type GitHubProviderAuthorityDecision,
  type GitHubProviderConnection,
  type GitHubProviderReceipt,
  type GitHubProviderReceiptLookupInput,
  type GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import {
  boundedBody,
  boundedLimit,
  boundedText,
  buildScopedGitHubIssueComment,
  buildScopedGitHubIssueContext,
  canonicalBody,
  canonicalLogins,
  canonicalStringList,
  normalizeGitHubRepository,
  positiveInteger,
  projectSlug,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

interface ResolvedScope {
  project: string;
  repositoryFullName: string;
  attachment: ProjectAttachmentRecord;
  binding: GitHubProjectRepositoryBinding;
  connection: GitHubProviderConnection;
  authority: GitHubProviderAuthorityDecision;
}

export class GitHubIssueProviderService {
  readonly #projects: GitHubIssueProviderServiceDependencies["projects"];
  readonly #bindings: GitHubIssueProviderServiceDependencies["bindings"];
  readonly #authority: GitHubIssueProviderServiceDependencies["authority"];
  readonly #adapter: GitHubIssueProviderServiceDependencies["adapter"];
  readonly #receipts: GitHubIssueProviderServiceDependencies["receipts"];
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

  async getReceipt(
    input: GitHubProviderReceiptLookupInput,
  ): Promise<GitHubProviderReceipt | null> {
    const project = projectSlug(input.project);
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "GitHub provider idempotency key",
      240,
    );
    const actorId = boundedText(input.actorId, "GitHub provider actor ID", 120);
    const clientId = boundedText(input.clientId, "GitHub provider client ID", 240);
    const receipt = await this.#receipts.getGitHubProviderReceipt(
      project,
      idempotencyKey,
    );
    if (!receipt) return null;
    if (receipt.actorId !== actorId || receipt.clientId !== clientId) {
      throw new GitHubProviderAuthorityError(
        "GitHub provider receipt belongs to another actor or client",
      );
    }
    return receipt;
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
      ...(input.labels
        ? { labels: canonicalStringList(input.labels, 100, 100) }
        : {}),
      ...(input.assignees
        ? { assignees: canonicalLogins(input.assignees) }
        : {}),
      ...(input.cursor
        ? { cursor: boundedText(input.cursor, "GitHub issue cursor", 512) }
        : {}),
      limit: boundedLimit(input.limit ?? 30),
    });
    return {
      issues: page.issues.map((issue) =>
        buildScopedGitHubIssueContext(issue, scope.repositoryFullName)
      ),
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
      ...(input.cursor
        ? { cursor: boundedText(input.cursor, "GitHub issue cursor", 512) }
        : {}),
      limit: boundedLimit(input.limit ?? 30),
    });
    return {
      issues: page.issues.map((issue) =>
        buildScopedGitHubIssueContext(issue, scope.repositoryFullName)
      ),
      nextCursor: page.nextCursor,
    };
  }

  async getIssue(input: GitHubProviderRequestContext & {
    issueNumber: number;
  }): Promise<GitHubIssueContext> {
    const scope = await this.#resolveScope(input, "github_get_issue");
    const issue = await this.#adapter.getIssue({
      repositoryFullName: scope.repositoryFullName,
      issueNumber: positiveInteger(input.issueNumber, "GitHub issue number"),
    });
    return buildScopedGitHubIssueContext(issue, scope.repositoryFullName);
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
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    return await this.#executeWrite({
      context: input,
      operation: "github_create_issue",
      target: `${repositoryFullName}#new`,
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
        const number = positiveInteger(
          created.issue.number,
          "Created GitHub issue number",
        );
        const readback = await this.#readIssueAfterMutation(
          scope.repositoryFullName,
          number,
        );
        const result = buildScopedGitHubIssueContext(
          readback,
          scope.repositoryFullName,
        );
        verifyIssueFields(readback, { title, body, labels, assignees });
        return {
          result,
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
    if (
      title === undefined
      && body === undefined
      && input.state === undefined
    ) {
      throw new RangeError("GitHub issue update must change title, body, or state");
    }
    if (input.stateReason !== undefined && input.state === undefined) {
      throw new RangeError("GitHub issue state reason requires an explicit state change");
    }
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    return await this.#executeWrite({
      context: input,
      operation: "github_update_issue",
      target: `${repositoryFullName}#${issueNumber}`,
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
        const current = buildScopedGitHubIssueContext(
          currentInput,
          scope.repositoryFullName,
        );
        if (current.sourceRevision !== expectedSourceRevision) {
          throw new GitHubProviderStaleVersionError(current);
        }
        const updated = await this.#adapter.updateIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.stateReason === undefined
            ? {}
            : { stateReason: input.stateReason }),
          expectedSourceRevision,
          idempotencyKey: key,
        });
        const readback = await this.#readIssueAfterMutation(
          scope.repositoryFullName,
          issueNumber,
        );
        const result = buildScopedGitHubIssueContext(
          readback,
          scope.repositoryFullName,
        );
        verifyIssueFields(readback, {
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.stateReason === undefined
            ? {}
            : { stateReason: input.stateReason }),
        });
        return {
          result,
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
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    return await this.#executeWrite({
      context: input,
      operation: "github_add_issue_comment",
      target: `${repositoryFullName}#${issueNumber}:comment:new`,
      idempotencyKey: input.idempotencyKey,
      parameters: { issueNumber, body },
      execute: async (scope, key) => {
        const created = await this.#adapter.addIssueComment({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          body,
          idempotencyKey: key,
        });
        const readback = await this.#readCommentAfterMutation(
          scope.repositoryFullName,
          issueNumber,
          created.comment.id,
        );
        if (canonicalBody(readback.body) !== canonicalBody(body)) {
          throw new Error(
            "GitHub issue comment readback did not match the requested body",
          );
        }
        return {
          result: buildScopedGitHubIssueComment(
            readback,
            scope.repositoryFullName,
            issueNumber,
          ),
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
      mutate: (scope, issueNumber, values, key) =>
        this.#adapter.addIssueLabels({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          labels: values,
          idempotencyKey: key,
        }),
      expected: (before, values) =>
        canonicalStringList(
          [...new Set([...before.labels, ...values])],
          100,
          100,
        ),
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
      mutate: (scope, issueNumber, _values, key) =>
        this.#adapter.removeIssueLabel({
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
      mutate: (scope, issueNumber, values, key) =>
        this.#adapter.addIssueAssignees({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          assignees: values,
          idempotencyKey: key,
        }),
      expected: (before, values) =>
        canonicalLogins([...new Set([...before.assignees, ...values])]),
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
      mutate: (scope, issueNumber, values, key) =>
        this.#adapter.removeIssueAssignees({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
          assignees: values,
          idempotencyKey: key,
        }),
      expected: (before, values) =>
        before.assignees.filter((entry) => !values.includes(entry)),
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
      throw new RangeError(
        `GitHub issue ${input.field} mutation requires at least one value`,
      );
    }
    const repositoryFullName = normalizeGitHubRepository(input.context.repository);
    return await this.#executeWrite({
      context: input.context,
      operation: input.operation,
      target: `${repositoryFullName}#${issueNumber}:${input.field}`,
      idempotencyKey: input.idempotencyKey,
      parameters: { issueNumber, values: input.values },
      execute: async (scope, key) => {
        const beforeInput = await this.#adapter.getIssue({
          repositoryFullName: scope.repositoryFullName,
          issueNumber,
        });
        const before = buildScopedGitHubIssueContext(
          beforeInput,
          scope.repositoryFullName,
        );
        const expected = input.expected(before, input.values);
        const mutated = await input.mutate(scope, issueNumber, input.values, key);
        const readback = await this.#readIssueAfterMutation(
          scope.repositoryFullName,
          issueNumber,
        );
        const result = buildScopedGitHubIssueContext(
          readback,
          scope.repositoryFullName,
        );
        const actual = input.field === "labels"
          ? canonicalStringList(readback.labels ?? [], 100, 100)
          : canonicalLogins(readback.assignees ?? []);
        if (stableJson(actual) !== stableJson(expected)) {
          throw new Error(
            `GitHub issue ${input.field} readback did not match the requested mutation`,
          );
        }
        return {
          result,
          providerRequestId: mutated.providerRequestId ?? null,
        };
      },
    });
  }

  async #readIssueAfterMutation(
    repositoryFullName: string,
    issueNumber: number,
  ): Promise<GitHubIssueContextInput> {
    try {
      return await this.#adapter.getIssue({
        repositoryFullName,
        issueNumber,
      });
    } catch {
      throw new Error(
        "GitHub issue readback could not confirm the mutation; reconcile before retry",
      );
    }
  }

  async #readCommentAfterMutation(
    repositoryFullName: string,
    issueNumber: number,
    commentId: string,
  ) {
    try {
      return await this.#adapter.getIssueComment({
        repositoryFullName,
        issueNumber,
        commentId,
      });
    } catch {
      throw new Error(
        "GitHub issue comment readback could not confirm the mutation; reconcile before retry",
      );
    }
  }

  async #executeWrite(input: {
    context: GitHubProviderRequestContext;
    operation: Exclude<
      GitHubIssueProviderOperation,
      "github_list_issues" | "github_search_issues" | "github_get_issue"
    >;
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
    const actorId = boundedText(
      input.context.actorId,
      "GitHub provider actor ID",
      120,
    );
    const clientId = boundedText(
      input.context.clientId,
      "GitHub provider client ID",
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
      actorId,
      clientId,
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
      const checkedAt = this.#now();
      return await this.#receipts.updateGitHubProviderReceipt({
        ...reserved,
        state: "succeeded",
        updatedAt: checkedAt,
        providerRequestId: executed.providerRequestId,
        result: executed.result,
        verification: {
          state: "passed",
          checkedAt,
          sourceRevision: executed.result.sourceRevision,
        },
      });
    } catch (error) {
      if (error instanceof GitHubProviderStaleVersionError) {
        const checkedAt = this.#now();
        return await this.#receipts.updateGitHubProviderReceipt({
          ...reserved,
          state: "stale",
          updatedAt: checkedAt,
          result: error.current,
          verification: {
            state: "failed",
            checkedAt,
            sourceRevision: error.current.sourceRevision,
          },
          error: {
            code: "stale_provider_version",
            message: error.message,
            retry: "do_not_retry",
          },
          recovery: { nextAction: "refresh_and_retry_with_new_version" },
        });
      }
      if (error instanceof GitHubProviderRejectedError) {
        return await this.#receipts.updateGitHubProviderReceipt({
          ...reserved,
          state: "rejected",
          updatedAt: this.#now(),
          error: {
            code: error.code,
            message: boundedText(
              error.message,
              "GitHub provider rejection",
              1_000,
            ),
            retry: "do_not_retry",
          },
          recovery: {
            nextAction: "inspect_authority_or_provider_rejection",
          },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      const checkedAt = this.#now();
      const pending = await this.#receipts.updateGitHubProviderReceipt({
        ...reserved,
        state: "pending_reconciliation",
        updatedAt: checkedAt,
        verification: {
          state: "failed",
          checkedAt,
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
      || normalizeGitHubRepository(binding.repositoryFullName)
        !== repositoryFullName
      || binding.attachmentId !== attachment.id
      || binding.attachmentSnapshotSha256
        !== attachment.snapshot.snapshotSha256
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
        ? {
          capabilityGrantId: boundedText(
            context.capabilityGrantId,
            "Capability grant ID",
            240,
          ),
        }
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
    throw new Error(
      "GitHub issue state reason readback did not match the requested value",
    );
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
    throw new Error(
      "GitHub issue assignees readback did not match the requested values",
    );
  }
}
