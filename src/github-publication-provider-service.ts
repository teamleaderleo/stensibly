import { randomUUID } from "node:crypto";
import { normalizeRepositoryRemote } from "./project-contract.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import {
  GitHubProviderAuthorityError,
  GitHubProviderBindingError,
  GitHubProviderIdempotencyConflictError,
  GitHubProviderPendingReconciliationError,
  GitHubProviderRejectedError,
  type GitHubBranchResult,
  type GitHubProjectRepositoryBinding,
  type GitHubProviderAuthorityDecision,
  type GitHubProviderBindingStore,
  type GitHubProviderConnection,
  type GitHubProviderProjectReader,
  type GitHubProviderReceipt,
  type GitHubProviderReceiptStore,
  type GitHubProviderRequestContext,
  type GitHubPublicationProviderAdapter,
  type GitHubPublicationProviderOperation,
  type GitHubPullRequestResult,
} from "./github-provider-contracts.js";
import {
  boundedBody,
  boundedText,
  canonicalBody,
  normalizeGitHubRepository,
  projectSlug,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export interface GitHubPublicationProviderServiceDependencies {
  projects: GitHubProviderProjectReader;
  bindings: GitHubProviderBindingStore;
  authority: {
    authorizeGitHubOperation: (input: {
      project: string;
      repositoryFullName: string;
      operation: GitHubPublicationProviderOperation;
      actorId: string;
      clientId: string;
      capabilityGrantId?: string;
      approvalId?: string;
    }) => Promise<GitHubProviderAuthorityDecision>;
  };
  adapter: GitHubPublicationProviderAdapter;
  receipts: GitHubProviderReceiptStore;
  now?: () => string;
  idFactory?: () => string;
}

interface ResolvedScope {
  project: string;
  repositoryFullName: string;
  attachment: ProjectAttachmentRecord;
  binding: GitHubProjectRepositoryBinding;
  connection: GitHubProviderConnection;
  authority: GitHubProviderAuthorityDecision;
}

class GitHubPublicationStaleVersionError extends Error {
  readonly current: GitHubBranchResult;

  constructor(message: string, current: GitHubBranchResult) {
    super(message);
    this.name = "GitHubPublicationStaleVersionError";
    this.current = current;
  }
}

class GitHubPublicationMutationUnverifiedError extends Error {
  readonly result: GitHubBranchResult | GitHubPullRequestResult;
  readonly providerRequestId: string | null;

  constructor(
    message: string,
    result: GitHubBranchResult | GitHubPullRequestResult,
    providerRequestId: string | null,
  ) {
    super(message);
    this.name = "GitHubPublicationMutationUnverifiedError";
    this.result = result;
    this.providerRequestId = providerRequestId;
  }
}

/**
 * Executes the bounded publication operations that surround repository-file
 * writes. File mutation remains in GitHubRepositoryWriteProviderService so its
 * exact-parent ref lane and reconciliation contract stay authoritative.
 */
export class GitHubPublicationProviderService {
  readonly #projects: GitHubProviderProjectReader;
  readonly #bindings: GitHubProviderBindingStore;
  readonly #authority: GitHubPublicationProviderServiceDependencies["authority"];
  readonly #adapter: GitHubPublicationProviderAdapter;
  readonly #receipts: GitHubProviderReceiptStore;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(dependencies: GitHubPublicationProviderServiceDependencies) {
    this.#projects = dependencies.projects;
    this.#bindings = dependencies.bindings;
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#receipts = dependencies.receipts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#idFactory = dependencies.idFactory ?? (() => `ghop_${randomUUID()}`);
  }

  async createBranch(input: GitHubProviderRequestContext & {
    branch: string;
    fromCommitSha: string;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    const branch = branchName(input.branch);
    const fromCommitSha = commitSha(input.fromCommitSha, "Branch source commit");
    return await this.#executeWrite({
      context: input,
      operation: "github_create_branch",
      target: `${repositoryFullName}:refs/heads/${branch}`,
      idempotencyKey: input.idempotencyKey,
      parameters: { branch, fromCommitSha },
      execute: async (scope, key) => {
        const existing = await this.#adapter.getBranch({
          repositoryFullName: scope.repositoryFullName,
          branch,
        });
        if (existing) {
          throw new GitHubProviderRejectedError(
            "github_branch_already_exists",
            "GitHub branch creation requires an absent target branch",
          );
        }
        const created = await this.#adapter.createBranch({
          repositoryFullName: scope.repositoryFullName,
          branch,
          fromCommitSha,
          idempotencyKey: key,
        });
        let readback: GitHubBranchResult | null;
        try {
          readback = await this.#adapter.getBranch({
            repositoryFullName: scope.repositoryFullName,
            branch,
          });
        } catch {
          throw new GitHubPublicationMutationUnverifiedError(
            "GitHub branch mutation requires exact reconciliation",
            created.branch,
            created.providerRequestId ?? null,
          );
        }
        if (
          !readback
          || readback.name !== branch
          || readback.ref !== `refs/heads/${branch}`
          || readback.commitSha !== fromCommitSha
        ) {
          throw new GitHubPublicationMutationUnverifiedError(
            "GitHub branch mutation requires exact reconciliation",
            created.branch,
            created.providerRequestId ?? null,
          );
        }
        if (stableJson(created.branch) !== stableJson(readback)) {
          throw new GitHubPublicationMutationUnverifiedError(
            "GitHub branch mutation requires exact reconciliation",
            created.branch,
            created.providerRequestId ?? null,
          );
        }
        return {
          result: readback,
          providerRequestId: created.providerRequestId ?? null,
        };
      },
    });
  }

  async createPullRequest(input: GitHubProviderRequestContext & {
    title: string;
    body?: string;
    head: string;
    base: string;
    expectedHeadSha: string;
    expectedBaseSha: string;
    draft?: boolean;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt> {
    const repositoryFullName = normalizeGitHubRepository(input.repository);
    const title = boundedText(input.title, "GitHub pull request title", 256);
    const body = input.body === undefined
      ? undefined
      : boundedBody(input.body, "GitHub pull request body", 128 * 1024);
    const head = branchName(input.head);
    const base = branchName(input.base);
    if (head === base) {
      throw new RangeError("GitHub pull request head and base must differ");
    }
    const expectedHeadSha = commitSha(
      input.expectedHeadSha,
      "Expected pull request head commit",
    );
    const expectedBaseSha = commitSha(
      input.expectedBaseSha,
      "Expected pull request base commit",
    );
    const draft = input.draft ?? false;
    return await this.#executeWrite({
      context: input,
      operation: "github_create_pull_request",
      target: `${repositoryFullName}:pull:new:${head}->${base}`,
      idempotencyKey: input.idempotencyKey,
      parameters: {
        title,
        body: body ?? null,
        head,
        base,
        expectedHeadSha,
        expectedBaseSha,
        draft,
      },
      execute: async (scope, key) => {
        const [headBranch, baseBranch] = await Promise.all([
          this.#adapter.getBranch({
            repositoryFullName: scope.repositoryFullName,
            branch: head,
          }),
          this.#adapter.getBranch({
            repositoryFullName: scope.repositoryFullName,
            branch: base,
          }),
        ]);
        if (!headBranch || !baseBranch) {
          throw new GitHubProviderRejectedError(
            "github_pull_request_branch_missing",
            "GitHub pull request creation requires existing head and base branches",
          );
        }
        if (headBranch.commitSha !== expectedHeadSha) {
          throw new GitHubPublicationStaleVersionError(
            "GitHub pull request head changed before guarded publication",
            headBranch,
          );
        }
        if (baseBranch.commitSha !== expectedBaseSha) {
          throw new GitHubPublicationStaleVersionError(
            "GitHub pull request base changed before guarded publication",
            baseBranch,
          );
        }
        const created = await this.#adapter.createPullRequest({
          repositoryFullName: scope.repositoryFullName,
          title,
          ...(body === undefined ? {} : { body }),
          head,
          base,
          draft,
          idempotencyKey: key,
        });
        let readback: GitHubPullRequestResult;
        try {
          readback = await this.#adapter.getPullRequest({
            repositoryFullName: scope.repositoryFullName,
            pullRequestNumber: created.pullRequest.number,
          });
        } catch {
          throw new GitHubPublicationMutationUnverifiedError(
            "GitHub pull request mutation requires exact reconciliation",
            created.pullRequest,
            created.providerRequestId ?? null,
          );
        }
        if (
          readback.title !== title
          || readback.head !== head
          || readback.headSha !== expectedHeadSha
          || readback.base !== base
          || readback.baseSha !== expectedBaseSha
          || readback.draft !== draft
          || readback.state !== "open"
          || readback.bodyRevision.sha256 !== sha256(canonicalBody(body ?? ""))
        ) {
          throw new GitHubPublicationMutationUnverifiedError(
            "GitHub pull request mutation requires exact reconciliation",
            created.pullRequest,
            created.providerRequestId ?? null,
          );
        }
        if (stableJson(created.pullRequest) !== stableJson(readback)) {
          throw new GitHubPublicationMutationUnverifiedError(
            "GitHub pull request mutation requires exact reconciliation",
            created.pullRequest,
            created.providerRequestId ?? null,
          );
        }
        return {
          result: readback,
          providerRequestId: created.providerRequestId ?? null,
        };
      },
    });
  }

  async #executeWrite(input: {
    context: GitHubProviderRequestContext;
    operation: GitHubPublicationProviderOperation;
    target: string;
    idempotencyKey: string;
    parameters: unknown;
    execute: (
      scope: ResolvedScope,
      idempotencyKey: string,
    ) => Promise<{
      result: GitHubBranchResult | GitHubPullRequestResult;
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
      if (error instanceof GitHubPublicationStaleVersionError) {
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
      if (error instanceof GitHubPublicationMutationUnverifiedError) {
        const checkedAt = this.#now();
        const pending = await this.#receipts.updateGitHubProviderReceipt({
          ...reserved,
          state: "pending_reconciliation",
          updatedAt: checkedAt,
          providerRequestId: error.providerRequestId,
          result: error.result,
          verification: {
            state: "failed",
            checkedAt,
            sourceRevision: error.result.sourceRevision,
          },
          error: {
            code: "ambiguous_provider_outcome",
            message: "GitHub publication outcome requires exact reconciliation",
            retry: "reconcile_before_retry",
          },
          recovery: { nextAction: "reconcile_exact_operation" },
        });
        throw new GitHubProviderPendingReconciliationError(pending);
      }
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
          message: "GitHub publication outcome requires exact reconciliation",
          retry: "reconcile_before_retry",
        },
        recovery: { nextAction: "reconcile_exact_operation" },
      });
      throw new GitHubProviderPendingReconciliationError(pending);
    }
  }

  async #resolveScope(
    context: GitHubProviderRequestContext,
    operation: GitHubPublicationProviderOperation,
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
        authority.reason?.trim()
          || `Operation ${operation} is outside current authority`,
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

function branchName(value: string): string {
  const branch = boundedText(value, "GitHub branch", 240);
  if (
    branch === "@"
    || branch === "HEAD"
    || branch.startsWith("refs/heads/")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.startsWith("-")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || /[~^:?*\[\\\s]/u.test(branch)
  ) {
    throw new RangeError("GitHub branch is invalid");
  }
  const segments = branch.split("/");
  if (segments.some((segment) =>
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || segment.endsWith(".")
    || segment.endsWith(".lock")
  )) {
    throw new RangeError("GitHub branch is invalid");
  }
  return branch;
}

function commitSha(value: string, label: string): string {
  const sha = boundedText(value, label, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
    throw new RangeError(`${label} is invalid`);
  }
  return sha;
}
