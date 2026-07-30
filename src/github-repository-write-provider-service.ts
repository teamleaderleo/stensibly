import { randomUUID } from "node:crypto";
import { normalizeRepositoryRemote } from "./project-contract.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import {
  GitHubProviderAuthorityError,
  GitHubProviderBindingError,
  GitHubProviderIdempotencyConflictError,
  GitHubProviderPendingReconciliationError,
  type GitHubProjectRepositoryBinding,
  type GitHubProviderAuthorityDecision,
  type GitHubProviderConnection,
  type GitHubProviderReceipt,
  type GitHubProviderRequestContext,
  type GitHubRepositoryWriteOperation,
  type GitHubRepositoryWriteProviderServiceDependencies,
} from "./github-provider-contracts.js";
import {
  boundedBody,
  boundedText,
  normalizeGitHubRepository,
  projectSlug,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type PreparedRepositoryWrite,
  type RepositoryWriteOperation,
  type RepositoryWriteProviderResult,
} from "./repository-write-fence.js";

interface ResolvedScope {
  project: string;
  repositoryFullName: string;
  attachment: ProjectAttachmentRecord;
  binding: GitHubProjectRepositoryBinding;
  connection: GitHubProviderConnection;
  authority: GitHubProviderAuthorityDecision;
}

interface BaseRepositoryWriteInput extends GitHubProviderRequestContext {
  intent: unknown;
  message: string;
  idempotencyKey: string;
}

export class GitHubRepositoryWriteProviderService {
  readonly #projects: GitHubRepositoryWriteProviderServiceDependencies["projects"];
  readonly #bindings: GitHubRepositoryWriteProviderServiceDependencies["bindings"];
  readonly #authority: GitHubRepositoryWriteProviderServiceDependencies["authority"];
  readonly #adapter: GitHubRepositoryWriteProviderServiceDependencies["adapter"];
  readonly #receipts: GitHubRepositoryWriteProviderServiceDependencies["receipts"];
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(dependencies: GitHubRepositoryWriteProviderServiceDependencies) {
    this.#projects = dependencies.projects;
    this.#bindings = dependencies.bindings;
    this.#authority = dependencies.authority;
    this.#adapter = dependencies.adapter;
    this.#receipts = dependencies.receipts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#idFactory = dependencies.idFactory ?? (() => `ghop_${randomUUID()}`);
  }

  async createFile(input: BaseRepositoryWriteInput & {
    content: string;
  }): Promise<GitHubProviderReceipt> {
    const prepared = this.#prepare(input, "create_file");
    const content = boundedBody(input.content, "GitHub repository file content", 10 * 1024 * 1024);
    const message = boundedText(input.message, "GitHub repository commit message", 256);
    return await this.#executeWrite({
      context: input,
      prepared,
      operation: "github_create_repository_file",
      idempotencyKey: input.idempotencyKey,
      parameters: contentEvidence(content, message),
      dispatch: (key) => this.#adapter.createFile({
        repositoryFullName: prepared.repositoryFullName,
        path: prepared.path,
        content,
        message,
        targetRef: prepared.targetRef,
        idempotencyKey: key,
      }),
    });
  }

  async updateFile(input: BaseRepositoryWriteInput & {
    content: string;
    contentSha: string;
  }): Promise<GitHubProviderReceipt> {
    const prepared = this.#prepare(input, "update_file");
    const content = boundedBody(input.content, "GitHub repository file content", 10 * 1024 * 1024);
    const message = boundedText(input.message, "GitHub repository commit message", 256);
    const contentSha = gitObjectSha(input.contentSha, "GitHub repository content SHA");
    return await this.#executeWrite({
      context: input,
      prepared,
      operation: "github_update_repository_file",
      idempotencyKey: input.idempotencyKey,
      parameters: { ...contentEvidence(content, message), contentSha },
      dispatch: (key) => this.#adapter.updateFile({
        repositoryFullName: prepared.repositoryFullName,
        path: prepared.path,
        content,
        message,
        contentSha,
        targetRef: prepared.targetRef,
        idempotencyKey: key,
      }),
    });
  }

  async deleteFile(input: BaseRepositoryWriteInput & {
    contentSha: string;
  }): Promise<GitHubProviderReceipt> {
    const prepared = this.#prepare(input, "delete_file");
    const message = boundedText(input.message, "GitHub repository commit message", 256);
    const contentSha = gitObjectSha(input.contentSha, "GitHub repository content SHA");
    return await this.#executeWrite({
      context: input,
      prepared,
      operation: "github_delete_repository_file",
      idempotencyKey: input.idempotencyKey,
      parameters: { message, contentSha },
      dispatch: (key) => this.#adapter.deleteFile({
        repositoryFullName: prepared.repositoryFullName,
        path: prepared.path,
        message,
        contentSha,
        targetRef: prepared.targetRef,
        idempotencyKey: key,
      }),
    });
  }

  #prepare(
    input: GitHubProviderRequestContext & { intent: unknown },
    expectedOperation: RepositoryWriteOperation,
  ): PreparedRepositoryWrite {
    const prepared = prepareRepositoryWrite(input.intent);
    if (prepared.operation !== expectedOperation) {
      throw new RepositoryWriteFenceError({
        code: "repository_write_operation_mismatch",
        message: `Repository write intent operation ${prepared.operation} does not match ${expectedOperation}`,
        disposition: "rejected",
        retry: "do_not_retry",
        evidence: {
          intentOperation: prepared.operation,
          expectedOperation,
        },
      });
    }
    const contextRepository = normalizeGitHubRepository(input.repository);
    if (contextRepository !== prepared.repositoryFullName) {
      throw new RepositoryWriteFenceError({
        code: "repository_write_binding_mismatch",
        message: `Repository write intent targets ${prepared.repositoryFullName}, outside request repository ${contextRepository}`,
        disposition: "rejected",
        retry: "do_not_retry",
        evidence: {
          intentRepositoryFullName: prepared.repositoryFullName,
          contextRepositoryFullName: contextRepository,
        },
      });
    }
    return prepared;
  }

  async #executeWrite(input: {
    context: GitHubProviderRequestContext;
    prepared: PreparedRepositoryWrite;
    operation: GitHubRepositoryWriteOperation;
    idempotencyKey: string;
    parameters: unknown;
    dispatch: (idempotencyKey: string) => Promise<RepositoryWriteProviderResult>;
  }): Promise<GitHubProviderReceipt> {
    const scope = await this.#resolveScope(input.context, input.operation);
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "GitHub provider idempotency key",
      240,
    );
    const actorId = boundedText(input.context.actorId, "GitHub provider actor ID", 120);
    const clientId = boundedText(input.context.clientId, "GitHub provider client ID", 240);
    const now = this.#now();
    const reserved: GitHubProviderReceipt = {
      version: 1,
      id: boundedText(this.#idFactory(), "GitHub provider receipt ID", 240),
      project: scope.project,
      provider: "github",
      repositoryFullName: scope.repositoryFullName,
      operation: input.operation,
      target: `${scope.repositoryFullName}:${input.prepared.targetRef}:${input.prepared.path}`,
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
        requestSha256: input.prepared.requestSha256,
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

    const laneReservation = await this.#receipts.reserveGitHubRepositoryWriteLane({
      project: scope.project,
      repositoryFullName: scope.repositoryFullName,
      targetRef: input.prepared.targetRef,
      receiptId: reserved.id,
      idempotencyKey,
      expectedParentSha: input.prepared.expectedParentSha,
      reservedAt: now,
    });
    if (laneReservation.outcome === "blocked") {
      const pending = await this.#pendingReceipt(reserved, {
        code: "repository_write_verification_in_progress",
        message: `Repository ref ${input.prepared.targetRef} already has an unverified write`,
      });
      throw new GitHubProviderPendingReconciliationError(pending);
    }

    try {
      const providerResult = await input.dispatch(idempotencyKey);
      const verified = await verifyRepositoryWriteResult({
        prepared: input.prepared,
        providerResult,
        refs: this.#adapter,
        now: this.#now,
      });
      const succeeded = await this.#receipts.updateGitHubProviderReceipt({
        ...reserved,
        state: "succeeded",
        updatedAt: verified.verifiedAt,
        providerRequestId: verified.providerRequestId,
        result: verified,
        verification: {
          state: "passed",
          checkedAt: verified.verifiedAt,
          sourceRevision: verified.commitSha,
        },
      });
      await this.#receipts.releaseGitHubRepositoryWriteLane({
        project: scope.project,
        repositoryFullName: scope.repositoryFullName,
        targetRef: input.prepared.targetRef,
        receiptId: reserved.id,
      });
      return succeeded;
    } catch (error) {
      if (error instanceof GitHubProviderPendingReconciliationError) throw error;
      if (error instanceof RepositoryWriteFenceError) {
        const pending = await this.#pendingReceipt(reserved, {
          code: error.code,
          message: error.message,
        });
        throw new GitHubProviderPendingReconciliationError(pending);
      }
      const message = error instanceof Error ? error.message : String(error);
      const pending = await this.#pendingReceipt(reserved, {
        code: "ambiguous_provider_outcome",
        message,
      });
      throw new GitHubProviderPendingReconciliationError(pending);
    }
  }

  async #pendingReceipt(
    reserved: GitHubProviderReceipt,
    error: { code: string; message: string },
  ): Promise<GitHubProviderReceipt> {
    const checkedAt = this.#now();
    return await this.#receipts.updateGitHubProviderReceipt({
      ...reserved,
      state: "pending_reconciliation",
      updatedAt: checkedAt,
      verification: {
        state: "failed",
        checkedAt,
        sourceRevision: null,
      },
      error: {
        code: boundedText(error.code, "GitHub repository write error code", 120),
        message: boundedText(error.message, "GitHub repository write error", 1_000),
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    });
  }

  async #resolveScope(
    context: GitHubProviderRequestContext,
    operation: GitHubRepositoryWriteOperation,
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
    const connection = await this.#bindings.getGitHubProviderConnection(binding.connectionId);
    if (!connection || connection.status !== "active") {
      throw new GitHubProviderBindingError(
        "GitHub provider connection is unavailable or inactive",
      );
    }
    if (!connection.repositoryFullNames.map(normalizeGitHubRepository).includes(repositoryFullName)) {
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
    return { project, repositoryFullName, attachment, binding, connection, authority };
  }
}

function contentEvidence(content: string, message: string): {
  contentByteLength: number;
  contentSha256: string;
  message: string;
} {
  return {
    contentByteLength: Buffer.byteLength(content, "utf8"),
    contentSha256: sha256(content),
    message,
  };
}

function gitObjectSha(value: string, label: string): string {
  const sha = boundedText(value, label, 64).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new RangeError(`${label} must be a full hexadecimal SHA`);
  }
  return sha;
}
