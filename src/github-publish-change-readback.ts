import {
  type GitHubPublishChangeInput,
  type GitHubPublishChangeService,
} from "./github-publish-change-operation.js";
import type { GitHubPublicationReadbackReconciler } from "./github-publication-readback-reconciliation.js";
import { admitGitHubRepositoryWriteReceipt } from "./github-repository-write-receipt-admission.js";
import type { GitHubRepositoryWriteReceipt } from "./github-repository-write-provider-service.js";
import {
  OperationWorkflowConflictError,
  OperationWorkflowPendingReconciliationError,
  type OperationWorkflow,
} from "./operation-workflow-contracts.js";

export interface GitHubPublishChangeReadbackDependencies {
  delegate: GitHubPublishChangeService;
  publicationReadback: Pick<
    GitHubPublicationReadbackReconciler,
    "reconcileBranch" | "reconcilePullRequest"
  >;
  repositoryFiles: {
    getRepositoryWriteReceipt(
      project: string,
      idempotencyKey: string,
    ): Promise<GitHubRepositoryWriteReceipt | null>;
  };
}

/**
 * Adds provider observation to the existing durable publish-change reconciler.
 * The delegate remains the only component allowed to mutate workflow state.
 * This bridge performs provider reads only and then re-enters the delegate.
 */
export class GitHubPublishChangeReadbackService
  implements GitHubPublishChangeService
{
  readonly #delegate: GitHubPublishChangeService;
  readonly #publicationReadback: GitHubPublishChangeReadbackDependencies["publicationReadback"];
  readonly #repositoryFiles: GitHubPublishChangeReadbackDependencies["repositoryFiles"];

  constructor(dependencies: GitHubPublishChangeReadbackDependencies) {
    this.#delegate = dependencies.delegate;
    this.#publicationReadback = dependencies.publicationReadback;
    this.#repositoryFiles = dependencies.repositoryFiles;
  }

  async publishChange(input: GitHubPublishChangeInput): Promise<OperationWorkflow> {
    return await this.#delegate.publishChange(input);
  }

  async reconcilePublishChange(
    input: GitHubPublishChangeInput,
  ): Promise<OperationWorkflow> {
    let pending: OperationWorkflowPendingReconciliationError;
    try {
      return await this.#delegate.reconcilePublishChange(input);
    } catch (error) {
      if (!(error instanceof OperationWorkflowPendingReconciliationError)) {
        throw error;
      }
      pending = error;
    }

    const step = pending.workflow.steps.find((candidate) =>
      candidate.state === "dispatch_reserved"
      || candidate.state === "pending_reconciliation");
    if (!step) throw pending;

    const context = {
      project: input.project,
      repository: input.repository,
      actorId: input.actorId,
      clientId: input.clientId,
      ...(input.capabilityGrantId
        ? { capabilityGrantId: input.capabilityGrantId }
        : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    };

    if (step.kind === "github_create_branch") {
      await this.#publicationReadback.reconcileBranch({
        ...context,
        branch: input.branch,
        fromCommitSha: input.fromCommitSha,
        idempotencyKey: step.providerIdempotencyKey,
      });
      return await this.#delegate.reconcilePublishChange(input);
    }

    if (step.kind === "github_create_pull_request") {
      const expectedHeadSha = await this.#verifiedFileHead(
        input,
        pending.workflow,
      );
      await this.#publicationReadback.reconcilePullRequest({
        ...context,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        head: input.branch,
        base: input.base,
        expectedHeadSha,
        expectedBaseSha: input.expectedBaseSha,
        draft: input.draft ?? false,
        idempotencyKey: step.providerIdempotencyKey,
      });
      return await this.#delegate.reconcilePublishChange(input);
    }

    throw pending;
  }

  async #verifiedFileHead(
    input: GitHubPublishChangeInput,
    workflow: OperationWorkflow,
  ): Promise<string> {
    const fileStep = workflow.steps[1];
    if (!fileStep || fileStep.state !== "verified") {
      throw new OperationWorkflowConflictError(
        "Operation workflow file step is not verified before publication readback",
      );
    }
    const raw = await this.#repositoryFiles.getRepositoryWriteReceipt(
      input.project,
      fileStep.providerIdempotencyKey,
    );
    if (!raw) {
      throw new OperationWorkflowConflictError(
        "Repository write receipt is unavailable before publication readback",
      );
    }
    const receipt = admitGitHubRepositoryWriteReceipt(raw);
    if (
      receipt.project !== input.project
      || receipt.repositoryFullName !== input.repository
      || receipt.actorId !== input.actorId
      || receipt.clientId !== input.clientId
      || receipt.idempotencyKey !== fileStep.providerIdempotencyKey
      || receipt.state !== "succeeded"
      || receipt.verified === null
    ) {
      throw new OperationWorkflowConflictError(
        "Repository write receipt changed before publication readback",
      );
    }
    return receipt.verified.nextExpectedParentSha;
  }
}
