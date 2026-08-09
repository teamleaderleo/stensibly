import { sha256, stableJson } from "./canonical-json.js";
import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import type { GitHubRepositoryWriteReceipt } from "./github-repository-write-provider-service.js";
import {
  OperationWorkflowConflictError,
  OperationWorkflowPendingReconciliationError,
  type OperationAuthorityFence,
  type OperationWorkflow,
  type OperationWorkflowStore,
} from "./operation-workflow-contracts.js";
import {
  buildOperationWorkflow,
  reserveOperationWorkflowStep,
  settleOperationWorkflowStep,
} from "./operation-workflow-machine.js";

export type GitHubPublishChangeFile =
  | {
    operation: "create_file";
    path: string;
    content: string;
    message: string;
  }
  | {
    operation: "update_file";
    path: string;
    contentSha: string;
    content: string;
    message: string;
  };

export interface GitHubPublishChangeInput extends GitHubProviderRequestContext {
  itemId: string;
  runId: string;
  authorityFence: OperationAuthorityFence;
  branch: string;
  fromCommitSha: string;
  file: GitHubPublishChangeFile;
  base: string;
  expectedBaseSha: string;
  title: string;
  body?: string;
  draft?: boolean;
  idempotencyKey: string;
}

export interface GitHubPublishChangeDependencies {
  workflows: OperationWorkflowStore;
  assertAuthority(input: GitHubPublishChangeInput): Promise<void>;
  publication: {
    createBranch(input: GitHubProviderRequestContext & {
      branch: string;
      fromCommitSha: string;
      idempotencyKey: string;
    }): Promise<GitHubProviderReceipt>;
    createPullRequest(input: GitHubProviderRequestContext & {
      title: string;
      body?: string;
      head: string;
      base: string;
      expectedHeadSha: string;
      expectedBaseSha: string;
      draft?: boolean;
      idempotencyKey: string;
    }): Promise<GitHubProviderReceipt>;
  };
  repositoryFiles: {
    createRepositoryFile(input: GitHubProviderRequestContext & {
      path: string;
      branch: string;
      expectedParentSha: string;
      content: string;
      message: string;
      idempotencyKey: string;
    }): Promise<GitHubRepositoryWriteReceipt>;
    updateRepositoryFile(input: GitHubProviderRequestContext & {
      path: string;
      branch: string;
      expectedParentSha: string;
      contentSha: string;
      content: string;
      message: string;
      idempotencyKey: string;
    }): Promise<GitHubRepositoryWriteReceipt>;
    getRepositoryWriteReceipt(
      project: string,
      idempotencyKey: string,
    ): Promise<GitHubRepositoryWriteReceipt | null>;
  };
  now?: () => string;
  idFactory?: () => string;
}

export interface GitHubPublishChangeService {
  publishChange(input: GitHubPublishChangeInput): Promise<OperationWorkflow>;
}

export function withGitHubPublishChangeService<T extends object>(
  target: T,
  operation: GitHubPublishChangeOperation,
): T & GitHubPublishChangeService {
  return Object.assign(target, { publishChange: operation.execute.bind(operation) });
}

/**
 * Composes the already-guarded GitHub branch, exact-parent file, and pull
 * request providers under one durable operation. A step reservation is
 * committed before each provider call. If settlement is lost, replay marks the
 * step ambiguous and refuses to dispatch another external effect.
 */
export class GitHubPublishChangeOperation {
  readonly #dependencies: GitHubPublishChangeDependencies;
  readonly #now: () => string;

  constructor(dependencies: GitHubPublishChangeDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(input: GitHubPublishChangeInput): Promise<OperationWorkflow> {
    await this.#dependencies.assertAuthority(input);
    const workflowCandidate = this.#build(input);
    const reservation = await this.#dependencies.workflows.reserveOperationWorkflow(workflowCandidate);
    if (reservation.outcome === "conflict") throw new OperationWorkflowConflictError();
    let workflow = reservation.workflow;
    if (workflow.state === "succeeded") return workflow;
    if (workflow.state === "waiting_reconciliation") {
      throw new OperationWorkflowPendingReconciliationError(workflow);
    }
    if (terminalStates.has(workflow.state)) throw new GitHubPublishChangeTerminalError(workflow);

    const interrupted = workflow.steps.find((step) => step.state === "dispatch_reserved");
    if (interrupted) {
      const pending = settleOperationWorkflowStep(workflow, {
        stepId: interrupted.id,
        outcome: "pending_reconciliation",
        settledAt: this.#now(),
        errorCode: "operation_step_settlement_interrupted",
      });
      workflow = await this.#dependencies.workflows.transitionOperationWorkflow({
        current: workflow,
        next: pending,
      });
      throw new OperationWorkflowPendingReconciliationError(workflow);
    }

    for (const step of workflow.steps) {
      if (step.state === "verified") continue;
      await this.#dependencies.assertAuthority(input);
      const reserved = reserveOperationWorkflowStep(workflow, step.id, this.#now());
      workflow = await this.#dependencies.workflows.transitionOperationWorkflow({
        current: workflow,
        next: reserved,
      });
      let settlement: {
        providerReceiptRef: string;
        before: unknown;
        after: unknown;
        verification: unknown;
      };
      try {
        await this.#dependencies.assertAuthority(input);
        settlement = await this.#dispatch(input, workflow, step.ordinal);
      } catch (error) {
        if (error instanceof OperationWorkflowPendingReconciliationError) throw error;
        const classification = classifyProviderFailure(error);
        const next = settleOperationWorkflowStep(workflow, {
          stepId: step.id,
          outcome: classification.outcome,
          settledAt: this.#now(),
          ...(classification.providerReceiptRef === null
            ? {}
            : { providerReceiptRef: classification.providerReceiptRef }),
          errorCode: classification.code,
        });
        workflow = await this.#dependencies.workflows.transitionOperationWorkflow({
          current: workflow,
          next,
        });
        if (classification.outcome === "pending_reconciliation") {
          throw new OperationWorkflowPendingReconciliationError(workflow);
        }
        throw new GitHubPublishChangeTerminalError(workflow);
      }
      const verified = settleOperationWorkflowStep(workflow, {
        stepId: step.id,
        outcome: "verified",
        settledAt: this.#now(),
        ...settlement,
      });
      try {
        workflow = await this.#dependencies.workflows.transitionOperationWorkflow({
          current: workflow,
          next: verified,
        });
      } catch {
        throw new OperationWorkflowSettlementError(workflow, settlement.providerReceiptRef);
      }
    }
    return workflow;
  }

  #build(input: GitHubPublishChangeInput): OperationWorkflow {
    const operationId = this.#dependencies.idFactory?.() ?? operationIdFor(input);
    const context = providerContext(input);
    const fileCommand = fileCommandEvidence(input.file, input.fromCommitSha, input.branch);
    return buildOperationWorkflow({
      id: operationId,
      project: input.project,
      itemId: input.itemId,
      runId: input.runId,
      actorId: input.actorId,
      clientId: input.clientId,
      kind: "github_publish_change",
      target: `${input.repository}:refs/heads/${input.branch}`,
      request: publishRequestEvidence(input),
      idempotencyKey: input.idempotencyKey,
      authorityFence: input.authorityFence,
      steps: [
        {
          kind: "github_create_branch",
          providerIdempotencyKey: providerStepKey(input, 1),
          command: { repository: input.repository, branch: input.branch, fromCommitSha: input.fromCommitSha },
          compensation: {
            disposition: "conditionally_reversible",
            kind: "github_delete_created_branch_if_owned",
            command: { repository: input.repository, branch: input.branch, operationId },
          },
        },
        {
          kind: input.file.operation === "create_file" ? "github_create_file" : "github_update_file",
          providerIdempotencyKey: providerStepKey(input, 2),
          command: fileCommand,
          compensation: {
            disposition: "compensatable",
            kind: "github_restore_file_preimage",
            command: { repository: input.repository, branch: input.branch, path: input.file.path, operationId },
          },
        },
        {
          kind: "github_create_pull_request",
          providerIdempotencyKey: providerStepKey(input, 3),
          command: {
            repository: input.repository,
            title: input.title,
            bodySha256: sha256(input.body ?? ""),
            head: input.branch,
            base: input.base,
            expectedBaseSha: input.expectedBaseSha,
            draft: input.draft ?? false,
          },
          compensation: {
            disposition: "conditionally_reversible",
            kind: "github_close_created_pull_request_if_open",
            command: { repository: input.repository, head: input.branch, base: input.base, operationId },
          },
        },
      ],
      now: this.#now(),
    });
  }

  async #dispatch(
    input: GitHubPublishChangeInput,
    workflow: OperationWorkflow,
    ordinal: number,
  ): Promise<{
    providerReceiptRef: string;
    before: unknown;
    after: unknown;
    verification: unknown;
  }> {
    const context = providerContext(input);
    const key = workflow.steps[ordinal - 1]?.providerIdempotencyKey;
    if (!key) {
      throw new OperationWorkflowConflictError("Operation workflow provider key is unavailable");
    }
    if (ordinal === 1) {
      const receipt = await this.#dependencies.publication.createBranch({
        ...context,
        branch: input.branch,
        fromCommitSha: input.fromCommitSha,
        idempotencyKey: key,
      });
      const branch = requireSucceededBranch(receipt);
      return {
        providerReceiptRef: `github_provider_receipt:${receipt.id}`,
        before: { ref: `refs/heads/${input.branch}`, state: "absent" },
        after: branch,
        verification: receipt.verification,
      };
    }
    if (ordinal === 2) {
      const receipt = input.file.operation === "create_file"
        ? await this.#dependencies.repositoryFiles.createRepositoryFile({
          ...context,
          path: input.file.path,
          branch: input.branch,
          expectedParentSha: input.fromCommitSha,
          content: input.file.content,
          message: input.file.message,
          idempotencyKey: key,
        })
        : await this.#dependencies.repositoryFiles.updateRepositoryFile({
          ...context,
          path: input.file.path,
          branch: input.branch,
          expectedParentSha: input.fromCommitSha,
          contentSha: input.file.contentSha,
          content: input.file.content,
          message: input.file.message,
          idempotencyKey: key,
        });
      if (receipt.state !== "succeeded" || receipt.verified === null) {
        throw providerReceiptFailure(receipt);
      }
      return {
        providerReceiptRef: `github_repository_write_receipt:${receipt.id}`,
        before: { parentSha: receipt.expectedParentSha, path: receipt.path },
        after: receipt.verified,
        verification: {
          requestSha256: receipt.requestSha256,
          payloadSha256: receipt.payloadSha256,
          dispatchCount: receipt.dispatchCount,
        },
      };
    }
    const fileStep = workflow.steps[1];
    if (!fileStep || fileStep.state !== "verified") {
      throw new RangeError("GitHub publish change file step is not verified");
    }
    const fileReceipt = await this.#dependencies.workflows.getOperationWorkflow(
      workflow.project,
      workflow.idempotencyKey,
    );
    if (!fileReceipt || fileReceipt.revision !== workflow.revision) {
      throw new OperationWorkflowConflictError("Operation workflow changed before pull request dispatch");
    }
    // The exact head is obtained from the repository-write result carried by
    // the live dispatch, not reconstructed from content or prose.
    const writeReceipt = await this.#dependencies.repositoryFiles.getRepositoryWriteReceipt(
      input.project,
      workflow.steps[1]!.providerIdempotencyKey,
    );
    if (!writeReceipt) throw new OperationWorkflowConflictError("Repository write receipt disappeared before pull request dispatch");
    const headSha = writeReceipt.verified?.nextExpectedParentSha;
    if (!headSha) throw providerReceiptFailure(writeReceipt);
    const receipt = await this.#dependencies.publication.createPullRequest({
      ...context,
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      head: input.branch,
      base: input.base,
      expectedHeadSha: headSha,
      expectedBaseSha: input.expectedBaseSha,
      draft: input.draft ?? false,
      idempotencyKey: key,
    });
    const pullRequest = requireSucceededPullRequest(receipt);
    return {
      providerReceiptRef: `github_provider_receipt:${receipt.id}`,
      before: { headSha, baseSha: input.expectedBaseSha },
      after: pullRequest,
      verification: receipt.verification,
    };
  }

}

export class GitHubPublishChangeTerminalError extends Error {
  readonly code = "github_publish_change_terminal";
  readonly workflow: OperationWorkflow;

  constructor(workflow: OperationWorkflow) {
    super("GitHub publish change did not complete");
    this.name = "GitHubPublishChangeTerminalError";
    this.workflow = workflow;
  }
}

export class OperationWorkflowSettlementError extends Error {
  readonly code = "operation_workflow_settlement_failed";
  readonly workflow: OperationWorkflow;
  readonly providerReceiptRef: string;

  constructor(workflow: OperationWorkflow, providerReceiptRef: string) {
    super("Verified GitHub publish change step requires workflow reconciliation");
    this.name = "OperationWorkflowSettlementError";
    this.workflow = workflow;
    this.providerReceiptRef = providerReceiptRef;
  }
}

function providerContext(input: GitHubPublishChangeInput): GitHubProviderRequestContext {
  return {
    project: input.project,
    repository: input.repository,
    actorId: input.actorId,
    clientId: input.clientId,
    ...(input.capabilityGrantId === undefined ? {} : { capabilityGrantId: input.capabilityGrantId }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
  };
}

function publishRequestEvidence(input: GitHubPublishChangeInput): unknown {
  return {
    project: input.project,
    repository: input.repository,
    itemId: input.itemId,
    runId: input.runId,
    actorId: input.actorId,
    clientId: input.clientId,
    authorityFence: {
      resource: input.authorityFence.resource,
      holderId: input.authorityFence.holderId,
      generation: input.authorityFence.generation,
    },
    branch: input.branch,
    fromCommitSha: input.fromCommitSha,
    file: fileCommandEvidence(input.file, input.fromCommitSha, input.branch),
    base: input.base,
    expectedBaseSha: input.expectedBaseSha,
    title: input.title,
    bodySha256: sha256(input.body ?? ""),
    draft: input.draft ?? false,
    idempotencyKey: input.idempotencyKey,
  };
}

function fileCommandEvidence(file: GitHubPublishChangeFile, expectedParentSha: string, branch: string): unknown {
  return {
    operation: file.operation,
    path: file.path,
    branch,
    expectedParentSha,
    ...(file.operation === "update_file" ? { contentSha: file.contentSha } : {}),
    contentSha256: sha256(file.content),
    contentByteLength: Buffer.byteLength(file.content, "utf8"),
    messageSha256: sha256(file.message),
  };
}

function operationIdFor(input: GitHubPublishChangeInput): string {
  return `opw_${sha256(stableJson(publishRequestEvidence(input))).slice("sha256:".length, "sha256:".length + 32)}`;
}

function providerStepKey(input: GitHubPublishChangeInput, ordinal: number): string {
  return `opstep:${sha256(stableJson({
    project: input.project,
    idempotencyKey: input.idempotencyKey,
    ordinal,
  })).slice("sha256:".length, "sha256:".length + 48)}`;
}

function requireSucceededBranch(receipt: GitHubProviderReceipt) {
  if (receipt.state !== "succeeded" || !receipt.result || !("kind" in receipt.result) || receipt.result.kind !== "branch") throw providerReceiptFailure(receipt);
  return receipt.result;
}

function requireSucceededPullRequest(receipt: GitHubProviderReceipt) {
  if (receipt.state !== "succeeded" || !receipt.result || !("kind" in receipt.result) || receipt.result.kind !== "pull_request") throw providerReceiptFailure(receipt);
  return receipt.result;
}

function providerReceiptFailure(receipt: GitHubProviderReceipt | GitHubRepositoryWriteReceipt): Error & { receipt: typeof receipt; code: string } {
  const error = new Error("GitHub provider step did not produce verified success") as Error & { receipt: typeof receipt; code: string };
  error.receipt = receipt;
  error.code = receipt.error?.code ?? "github_publish_change_step_rejected";
  return error;
}

function classifyProviderFailure(error: unknown): {
  outcome: "pending_reconciliation" | "rejected";
  code: string;
  providerReceiptRef: string | null;
} {
  const candidate = error && typeof error === "object" ? error as {
    code?: unknown;
    receipt?: GitHubProviderReceipt | GitHubRepositoryWriteReceipt;
  } : {};
  const receipt = candidate.receipt;
  const pending = receipt?.state === "pending_reconciliation" || receipt?.state === "verified_pending_release";
  const prefix = receipt && "repositoryFullName" in receipt && "dispatchCount" in receipt
    ? "github_repository_write_receipt"
    : "github_provider_receipt";
  return {
    outcome: pending ? "pending_reconciliation" : "rejected",
    code: typeof candidate.code === "string" && /^[A-Za-z0-9._:-]{1,120}$/u.test(candidate.code)
      ? candidate.code
      : receipt?.error?.code ?? "github_publish_change_step_rejected",
    providerReceiptRef: receipt ? `${prefix}:${receipt.id}` : null,
  };
}

const terminalStates = new Set([
  "compensated", "partially_completed", "failed", "cancelled", "escalated",
]);
