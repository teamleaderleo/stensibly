import { sha256, stableJson } from "./canonical-json.js";
import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import { admitGitHubProviderReceipt } from "./github-provider-receipt-admission.js";
import {
  fingerprintGitHubRepositoryWritePayload,
  type GitHubRepositoryWriteReceipt,
} from "./github-repository-write-provider-service.js";
import { admitGitHubRepositoryWriteReceipt } from "./github-repository-write-receipt-admission.js";
import {
  boundedBody,
  boundedText,
  canonicalBody,
  normalizeGitHubRepository,
} from "./github-provider-validation.js";
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
    getGitHubProviderReceipt(
      project: string,
      idempotencyKey: string,
    ): Promise<GitHubProviderReceipt | null>;
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
  reconcilePublishChange(input: GitHubPublishChangeInput): Promise<OperationWorkflow>;
}

export function withGitHubPublishChangeService<T extends object>(
  target: T,
  operation: GitHubPublishChangeOperation,
): T & GitHubPublishChangeService {
  return Object.assign(target, {
    publishChange: operation.execute.bind(operation),
    reconcilePublishChange: operation.reconcile.bind(operation),
  });
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

  /**
   * Settles one interrupted workflow step from an already-durable provider
   * receipt. This method never calls a provider mutation and never converts an
   * ambiguous receipt into success. The original bounded request is required
   * so every content/body/command digest can be recomputed without retaining
   * caller bodies in the workflow record.
   */
  async reconcile(input: GitHubPublishChangeInput): Promise<OperationWorkflow> {
    await this.#dependencies.assertAuthority(input);
    const existing = await this.#dependencies.workflows.getOperationWorkflow(
      input.project,
      input.idempotencyKey,
    );
    if (!existing) {
      throw new OperationWorkflowConflictError(
        "Operation workflow does not exist before reconciliation",
      );
    }
    const reservation = await this.#dependencies.workflows.reserveOperationWorkflow(
      this.#build(input),
    );
    if (reservation.outcome === "conflict") throw new OperationWorkflowConflictError();
    let workflow = reservation.workflow;
    if (workflow.state === "succeeded") return workflow;
    if (terminalStates.has(workflow.state)) throw new GitHubPublishChangeTerminalError(workflow);

    const step = workflow.steps.find((candidate) =>
      candidate.state === "dispatch_reserved"
      || candidate.state === "pending_reconciliation");
    if (!step) {
      return workflow;
    }
    await this.#dependencies.assertAuthority(input);
    const resolution = await this.#reconcileStep(input, workflow, step.ordinal);
    if (resolution.outcome === "pending_reconciliation") {
      if (step.state === "dispatch_reserved") {
        const pending = settleOperationWorkflowStep(workflow, {
          stepId: step.id,
          outcome: "pending_reconciliation",
          settledAt: this.#now(),
          ...(resolution.providerReceiptRef === null
            ? {}
            : { providerReceiptRef: resolution.providerReceiptRef }),
          errorCode: resolution.code,
        });
        workflow = await this.#transitionReconciledStep(workflow, pending, step.id);
      }
      throw new OperationWorkflowPendingReconciliationError(workflow);
    }

    const next = resolution.outcome === "verified"
      ? settleOperationWorkflowStep(workflow, {
        stepId: step.id,
        outcome: "verified",
        settledAt: this.#now(),
        providerReceiptRef: resolution.providerReceiptRef,
        before: resolution.before,
        after: resolution.after,
        verification: resolution.verification,
      })
      : settleOperationWorkflowStep(workflow, {
        stepId: step.id,
        outcome: "rejected",
        settledAt: this.#now(),
        providerReceiptRef: resolution.providerReceiptRef,
        errorCode: resolution.code,
      });
    workflow = await this.#transitionReconciledStep(workflow, next, step.id);
    if (resolution.outcome === "rejected") {
      throw new GitHubPublishChangeTerminalError(workflow);
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

  async #reconcileStep(
    input: GitHubPublishChangeInput,
    workflow: OperationWorkflow,
    ordinal: number,
  ): Promise<ReconciliationResolution> {
    const step = workflow.steps[ordinal - 1];
    if (!step) throw new OperationWorkflowConflictError("Operation workflow step is unavailable");
    if (ordinal === 2) {
      const raw = await this.#dependencies.repositoryFiles.getRepositoryWriteReceipt(
        workflow.project,
        step.providerIdempotencyKey,
      );
      if (!raw) {
        return pendingResolution("operation_provider_receipt_unavailable", null);
      }
      const receipt = admitGitHubRepositoryWriteReceipt(raw);
      assertRepositoryWriteReceiptMatches(receipt, input, step.providerIdempotencyKey);
      const providerReceiptRef = `github_repository_write_receipt:${receipt.id}`;
      if (receipt.state === "succeeded" && receipt.verified !== null) {
        return {
          outcome: "verified",
          providerReceiptRef,
          before: { parentSha: receipt.expectedParentSha, path: receipt.path },
          after: receipt.verified,
          verification: {
            requestSha256: receipt.requestSha256,
            payloadSha256: receipt.payloadSha256,
            dispatchCount: receipt.dispatchCount,
          },
        };
      }
      if (receipt.state === "rejected") {
        return {
          outcome: "rejected",
          providerReceiptRef,
          code: receipt.error?.code ?? "github_publish_change_step_rejected",
        };
      }
      return pendingResolution(
        receipt.error?.code ?? "operation_provider_receipt_pending",
        providerReceiptRef,
      );
    }

    const raw = await this.#dependencies.publication.getGitHubProviderReceipt(
      workflow.project,
      step.providerIdempotencyKey,
    );
    if (!raw) return pendingResolution("operation_provider_receipt_unavailable", null);
    const receipt = admitGitHubProviderReceipt(raw);
    const providerReceiptRef = `github_provider_receipt:${receipt.id}`;
    const expectedHeadSha = ordinal === 3
      ? await this.#verifiedFileHead(input, workflow)
      : null;
    assertPublicationReceiptMatches(
      receipt,
      input,
      step.providerIdempotencyKey,
      ordinal,
      expectedHeadSha,
    );
    if ((receipt.state === "succeeded" || receipt.state === "reconciled") && receipt.result) {
      return {
        outcome: "verified",
        providerReceiptRef,
        before: ordinal === 1
          ? { ref: `refs/heads/${input.branch}`, state: "absent" }
          : { headSha: expectedHeadSha, baseSha: input.expectedBaseSha },
        after: receipt.result,
        verification: receipt.verification,
      };
    }
    if (receipt.state === "rejected" || receipt.state === "stale") {
      return {
        outcome: "rejected",
        providerReceiptRef,
        code: receipt.error?.code ?? "github_publish_change_step_rejected",
      };
    }
    return pendingResolution(
      receipt.error?.code ?? "operation_provider_receipt_pending",
      providerReceiptRef,
    );
  }

  async #verifiedFileHead(
    input: GitHubPublishChangeInput,
    workflow: OperationWorkflow,
  ): Promise<string> {
    const fileStep = workflow.steps[1];
    if (!fileStep || fileStep.state !== "verified") {
      throw new OperationWorkflowConflictError(
        "Operation workflow file step is not verified before pull request reconciliation",
      );
    }
    const receipt = await this.#dependencies.repositoryFiles.getRepositoryWriteReceipt(
      workflow.project,
      fileStep.providerIdempotencyKey,
    );
    if (!receipt) {
      throw new OperationWorkflowConflictError(
        "Repository write receipt is unavailable before pull request reconciliation",
      );
    }
    const admitted = admitGitHubRepositoryWriteReceipt(receipt);
    assertRepositoryWriteReceiptMatches(admitted, input, fileStep.providerIdempotencyKey);
    if (admitted.state !== "succeeded" || admitted.verified === null) {
      throw new OperationWorkflowConflictError(
        "Repository write receipt is not settled before pull request reconciliation",
      );
    }
    return admitted.verified.nextExpectedParentSha;
  }

  async #transitionReconciledStep(
    current: OperationWorkflow,
    next: OperationWorkflow,
    stepId: string,
  ): Promise<OperationWorkflow> {
    try {
      return await this.#dependencies.workflows.transitionOperationWorkflow({
        current,
        next,
      });
    } catch (error) {
      const latest = await this.#dependencies.workflows.getOperationWorkflow(
        current.project,
        current.idempotencyKey,
      );
      const expectedStep = next.steps.find((step) => step.id === stepId);
      const latestStep = latest?.steps.find((step) => step.id === stepId);
      if (
        latest
        && expectedStep
        && latestStep
        && stableJson(latestStep) === stableJson(expectedStep)
      ) {
        return latest;
      }
      throw error;
    }
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

type ReconciliationResolution =
  | {
    outcome: "verified";
    providerReceiptRef: string;
    before: unknown;
    after: unknown;
    verification: unknown;
  }
  | {
    outcome: "rejected";
    providerReceiptRef: string;
    code: string;
  }
  | {
    outcome: "pending_reconciliation";
    providerReceiptRef: string | null;
    code: string;
  };

function pendingResolution(
  code: string,
  providerReceiptRef: string | null,
): ReconciliationResolution {
  return { outcome: "pending_reconciliation", code, providerReceiptRef };
}

function assertRepositoryWriteReceiptMatches(
  receipt: GitHubRepositoryWriteReceipt,
  input: GitHubPublishChangeInput,
  idempotencyKey: string,
): void {
  const repository = normalizeGitHubRepository(input.repository);
  const payload = input.file.operation === "create_file"
    ? {
      operation: "create_file" as const,
      content: input.file.content,
      message: input.file.message,
    }
    : {
      operation: "update_file" as const,
      content: input.file.content,
      contentSha: input.file.contentSha,
      message: input.file.message,
    };
  if (
    receipt.project !== input.project
    || receipt.repositoryFullName !== repository
    || receipt.targetRef !== input.branch
    || receipt.path !== input.file.path
    || receipt.operation !== input.file.operation
    || receipt.expectedParentSha !== input.fromCommitSha
    || receipt.actorId !== input.actorId
    || receipt.clientId !== input.clientId
    || receipt.idempotencyKey !== idempotencyKey
    || receipt.payloadSha256 !== fingerprintGitHubRepositoryWritePayload(payload)
  ) {
    throw new OperationWorkflowConflictError(
      "Repository write receipt does not match the operation request",
    );
  }
  if (receipt.verified && (
    receipt.verified.repositoryFullName !== repository
    || receipt.verified.targetRef !== receipt.targetRef
    || receipt.verified.path !== receipt.path
    || receipt.verified.operation !== receipt.operation
    || receipt.verified.expectedParentSha !== receipt.expectedParentSha
    || receipt.verified.requestSha256 !== receipt.requestSha256
    || receipt.verified.nextExpectedParentSha !== receipt.verified.commitSha
  )) {
    throw new OperationWorkflowConflictError(
      "Repository write receipt verification does not match the operation request",
    );
  }
}

function assertPublicationReceiptMatches(
  receipt: GitHubProviderReceipt,
  input: GitHubPublishChangeInput,
  idempotencyKey: string,
  ordinal: number,
  expectedHeadSha: string | null,
): void {
  const repository = normalizeGitHubRepository(input.repository);
  const operation = ordinal === 1
    ? "github_create_branch" as const
    : "github_create_pull_request" as const;
  const target = ordinal === 1
    ? `${repository}:refs/heads/${input.branch}`
    : `${repository}:pull:new:${input.branch}->${input.base}`;
  const body = input.body === undefined
    ? undefined
    : boundedBody(input.body, "GitHub pull request body", 128 * 1024);
  const parameters = ordinal === 1
    ? { branch: input.branch, fromCommitSha: input.fromCommitSha }
    : {
      title: boundedText(input.title, "GitHub pull request title", 256),
      body: body ?? null,
      head: input.branch,
      base: input.base,
      expectedHeadSha,
      expectedBaseSha: input.expectedBaseSha,
      draft: input.draft ?? false,
    };
  const parametersSha256 = sha256(stableJson({ operation, target, parameters }));
  if (
    receipt.project !== input.project
    || receipt.provider !== "github"
    || receipt.repositoryFullName !== repository
    || receipt.operation !== operation
    || receipt.target !== target
    || receipt.actorId !== input.actorId
    || receipt.clientId !== input.clientId
    || receipt.idempotencyKey !== idempotencyKey
    || receipt.parametersSha256 !== parametersSha256
    || receipt.attemptCount !== 1
  ) {
    throw new OperationWorkflowConflictError(
      "GitHub publication receipt does not match the operation request",
    );
  }
  if (receipt.state !== "succeeded" && receipt.state !== "reconciled") return;
  if (receipt.verification.state !== "passed" || receipt.result === null) {
    throw new OperationWorkflowConflictError(
      "GitHub publication receipt lacks verified settlement evidence",
    );
  }
  if (ordinal === 1) {
    if (
      !("kind" in receipt.result)
      || receipt.result.kind !== "branch"
      || receipt.result.name !== input.branch
      || receipt.result.ref !== `refs/heads/${input.branch}`
      || receipt.result.commitSha !== input.fromCommitSha
    ) {
      throw new OperationWorkflowConflictError(
        "GitHub branch receipt does not match the operation request",
      );
    }
    return;
  }
  const canonical = canonicalBody(body ?? "");
  if (
    !("kind" in receipt.result)
    || receipt.result.kind !== "pull_request"
    || receipt.result.title !== boundedText(input.title, "GitHub pull request title", 256)
    || receipt.result.head !== input.branch
    || receipt.result.headSha !== expectedHeadSha
    || receipt.result.base !== input.base
    || receipt.result.baseSha !== input.expectedBaseSha
    || receipt.result.draft !== (input.draft ?? false)
    || receipt.result.state !== "open"
    || receipt.result.bodyRevision.sha256 !== sha256(canonical)
    || receipt.result.bodyRevision.byteLength !== Buffer.byteLength(canonical, "utf8")
  ) {
    throw new OperationWorkflowConflictError(
      "GitHub pull request receipt does not match the operation request",
    );
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
