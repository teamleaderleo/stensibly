import { sha256, stableJson } from "./canonical-json.js";
import type { GitHubProviderReceipt } from "./github-provider-contracts.js";
import type { GitHubRepositoryWriteReceipt } from "./github-repository-write-provider-service.js";
import {
  admitGitHubRepositoryFullName,
  admitGitObjectId,
} from "./github-repository-write-admission.js";
import {
  exactHeadRef,
  type GitHubRunnerGitBranchMutator,
  type GitHubRunnerGitMutationResult,
} from "./github-runner-git-branch-mutator.js";
import {
  OperationWorkflowConflictError,
  type OperationAuthorityFence,
  type OperationWorkflow,
  type OperationWorkflowStore,
} from "./operation-workflow-contracts.js";
import {
  buildOperationWorkflow,
  reserveOperationWorkflowStep,
  settleOperationWorkflowStep,
} from "./operation-workflow-machine.js";

export type GitHubBranchCompensationAction = "delete" | "restore";

export interface GitHubBranchCompensationInput {
  project: string;
  itemId: string;
  runId: string;
  actorId: string;
  clientId: string;
  authorityFence: OperationAuthorityFence;
  repository: string;
  targetRef: string;
  recordedSha: string;
  sourceOperationId: string;
  sourceOperationIdempotencyKey: string;
  action: GitHubBranchCompensationAction;
  deleteCompensationId?: string;
  deleteCompensationIdempotencyKey?: string;
  idempotencyKey: string;
}

export interface GitHubBranchCompensationObservation {
  repositoryFullName: string;
  targetRef: string;
  defaultBranchRef: string;
  state: "present" | "absent";
  commitSha: string | null;
  protection: "unprotected" | "protected" | "unknown";
  sourceRevision: string;
}

export interface GitHubBranchCompensationDependencies {
  workflows: OperationWorkflowStore;
  assertAuthority(input: GitHubBranchCompensationInput): Promise<void>;
  getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null>;
  getRepositoryWriteReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubRepositoryWriteReceipt | null>;
  observeBranch(input: {
    repositoryFullName: string;
    targetRef: string;
  }): Promise<GitHubBranchCompensationObservation>;
  runner: GitHubRunnerGitBranchMutator;
  excludedRefs?: readonly string[];
  now?: () => string;
  idFactory?: () => string;
}

interface AdmittedSource {
  workflow: OperationWorkflow;
  repositoryFullName: string;
  targetRef: string;
  recordedSha: string;
}

interface AdmittedBranchReceipt {
  name: string;
  ref: string;
  commitSha: string;
}

export class GitHubBranchCompensationConflictError extends Error {
  readonly code: string;
  readonly workflow: OperationWorkflow | null;

  constructor(code: string, workflow: OperationWorkflow | null = null) {
    super("GitHub branch compensation conflicts with current durable or provider state");
    this.name = "GitHubBranchCompensationConflictError";
    this.code = exactCode(code);
    this.workflow = workflow;
  }
}

export class GitHubBranchCompensationPendingReconciliationError extends Error {
  readonly code = "github_branch_compensation_pending_reconciliation";
  readonly workflow: OperationWorkflow;

  constructor(workflow: OperationWorkflow) {
    super("GitHub branch compensation requires reconciliation before another mutation");
    this.name = "GitHubBranchCompensationPendingReconciliationError";
    this.workflow = workflow;
  }
}

/**
 * Executes branch deletion/restoration as a separate forward operation. The
 * originating publish workflow stays immutable evidence. Every mutation is a
 * runner Git push with an explicit remote-ref lease; provider observations are
 * read-only and are used for admission, readback, and ambiguous-result repair.
 */
export class GitHubBranchCompensationService {
  readonly #dependencies: GitHubBranchCompensationDependencies;
  readonly #now: () => string;
  readonly #excludedRefs: ReadonlySet<string>;

  constructor(dependencies: GitHubBranchCompensationDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#excludedRefs = new Set((dependencies.excludedRefs ?? []).map(exactHeadRef));
  }

  async execute(input: GitHubBranchCompensationInput): Promise<OperationWorkflow> {
    const source = await this.#admitSource(input);
    if (input.action === "restore") await this.#admitDeleteIdentity(input, source);
    await this.#dependencies.assertAuthority(input);

    const candidate = this.#build(input, source);
    const reservation = await this.#dependencies.workflows.reserveOperationWorkflow(candidate);
    if (reservation.outcome === "conflict") {
      throw new OperationWorkflowConflictError(
        "GitHub branch compensation idempotency key was reused by another request",
      );
    }
    let workflow = reservation.workflow;
    if (workflow.state === "succeeded") return workflow;
    const step = workflow.steps[0]!;
    if (workflow.state === "failed") {
      throw new GitHubBranchCompensationConflictError(
        step.errorCode ?? "github_branch_compensation_failed",
        workflow,
      );
    }
    if (workflow.state === "waiting_reconciliation"
      || step.state === "dispatch_reserved"
      || step.state === "pending_reconciliation") {
      return await this.#reconcileReserved(input, source, workflow);
    }
    if (workflow.state !== "reserved" || step.state !== "planned") {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_state_conflict",
        workflow,
      );
    }

    await this.#dependencies.assertAuthority(input);
    let before: GitHubBranchCompensationObservation;
    try {
      before = admitObservation(
        await this.#dependencies.observeBranch({
          repositoryFullName: source.repositoryFullName,
          targetRef: source.targetRef,
        }),
        source,
      );
    } catch {
      return await this.#rejectPlanned(
        workflow,
        "github_branch_compensation_observation_unavailable",
      );
    }

    if (before.defaultBranchRef === source.targetRef) {
      return await this.#rejectPlanned(
        workflow,
        "github_branch_compensation_default_branch",
      );
    }
    if (this.#excludedRefs.has(source.targetRef)) {
      return await this.#rejectPlanned(
        workflow,
        "github_branch_compensation_excluded_ref",
      );
    }
    if (before.protection === "protected") {
      return await this.#rejectPlanned(
        workflow,
        "github_branch_compensation_protected_ref",
      );
    }
    if (before.protection === "unknown") {
      return await this.#rejectPlanned(
        workflow,
        "github_branch_compensation_protection_unknown",
      );
    }
    if (input.action === "delete") {
      if (before.state !== "present" || before.commitSha !== source.recordedSha) {
        return await this.#rejectPlanned(
          workflow,
          "github_branch_compensation_head_conflict",
        );
      }
    } else if (before.state !== "absent") {
      return await this.#rejectPlanned(
        workflow,
        "github_branch_compensation_restore_occupied",
      );
    }

    await this.#dependencies.assertAuthority(input);
    workflow = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next: reserveOperationWorkflowStep(workflow, step.id, this.#now()),
    });

    let mutation: GitHubRunnerGitMutationResult;
    try {
      mutation = input.action === "delete"
        ? await this.#dependencies.runner.deleteBranchExact({
          repositoryFullName: source.repositoryFullName,
          targetRef: source.targetRef,
          expectedOldSha: source.recordedSha,
          idempotencyKey: workflow.steps[0]!.providerIdempotencyKey,
        })
        : await this.#dependencies.runner.restoreBranchExact({
          repositoryFullName: source.repositoryFullName,
          targetRef: source.targetRef,
          recordedSha: source.recordedSha,
          idempotencyKey: workflow.steps[0]!.providerIdempotencyKey,
        });
    } catch {
      return await this.#hold(workflow, "github_branch_compensation_runner_ambiguous");
    }

    if (mutation.outcome === "lease_conflict") {
      return await this.#reject(
        workflow,
        input.action === "delete"
          ? "github_branch_compensation_head_conflict"
          : "github_branch_compensation_restore_occupied",
        mutation,
      );
    }
    if (mutation.outcome === "rejected") {
      return await this.#reject(
        workflow,
        "github_branch_compensation_runner_rejected",
        mutation,
      );
    }

    return await this.#readbackAfterMutation(
      input,
      source,
      workflow,
      before,
      mutation,
    );
  }

  async #admitSource(input: GitHubBranchCompensationInput): Promise<AdmittedSource> {
    const repositoryFullName = admitGitHubRepositoryFullName(input.repository);
    const targetRef = exactHeadRef(input.targetRef);
    const recordedSha = admitGitObjectId(input.recordedSha);
    const sourceOperationId = exactIdentifier(
      input.sourceOperationId,
      "Source operation ID",
      160,
    );
    const sourceKey = exactIdentifier(
      input.sourceOperationIdempotencyKey,
      "Source operation idempotency key",
      240,
    );
    const source = await this.#dependencies.workflows.getOperationWorkflow(
      input.project,
      sourceKey,
    );
    if (!source
      || source.id !== sourceOperationId
      || source.kind !== "github_publish_change"
      || source.target !== `${repositoryFullName}:${targetRef}`
      || source.steps.length < 2) {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_source_conflict",
      );
    }
    const branchStep = source.steps[0]!;
    if (branchStep.kind !== "github_create_branch" || branchStep.state !== "verified") {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_source_branch_unverified",
      );
    }
    const branchReceipt = await this.#dependencies.getGitHubProviderReceipt(
      input.project,
      branchStep.providerIdempotencyKey,
    );
    const branchReceiptResult = admittedBranchReceipt(
      branchReceipt,
      source,
      repositoryFullName,
      targetRef,
    );
    if (branchStep.commandSha256 !== sha256(stableJson({
      repository: repositoryFullName,
      branch: branchReceiptResult.name,
      fromCommitSha: branchReceiptResult.commitSha,
    }))) {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_source_command_conflict",
      );
    }
    if (branchStep.compensation.kind !== "github_delete_created_branch_if_owned"
      || branchStep.compensation.commandSha256 !== sha256(stableJson({
        repository: repositoryFullName,
        branch: branchReceiptResult.name,
        operationId: source.id,
      }))) {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_source_plan_conflict",
      );
    }

    let finalSha = branchReceiptResult.commitSha;
    const fileStep = source.steps[1]!;
    if (fileStep.state === "verified") {
      const write = await this.#dependencies.getRepositoryWriteReceipt(
        input.project,
        fileStep.providerIdempotencyKey,
      );
      if (!write
        || write.project !== input.project
        || write.repositoryFullName !== repositoryFullName
        || write.targetRef !== targetRef
        || write.idempotencyKey !== fileStep.providerIdempotencyKey
        || write.state !== "succeeded"
        || write.verified === null
        || write.verified.repositoryFullName !== repositoryFullName
        || write.verified.targetRef !== targetRef) {
        throw new GitHubBranchCompensationConflictError(
          "github_branch_compensation_source_write_conflict",
        );
      }
      finalSha = admitGitObjectId(write.verified.nextExpectedParentSha);
    } else if (!["planned", "rejected", "cancelled"].includes(fileStep.state)) {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_source_unresolved",
      );
    }
    if (recordedSha !== finalSha) {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_recorded_sha_conflict",
      );
    }
    return Object.freeze({
      workflow: source,
      repositoryFullName,
      targetRef,
      recordedSha: finalSha,
    });
  }

  async #admitDeleteIdentity(
    input: GitHubBranchCompensationInput,
    source: AdmittedSource,
  ): Promise<void> {
    const deleteId = exactIdentifier(
      input.deleteCompensationId,
      "Delete compensation ID",
      160,
    );
    const deleteKey = exactIdentifier(
      input.deleteCompensationIdempotencyKey,
      "Delete compensation idempotency key",
      240,
    );
    const prior = await this.#dependencies.workflows.getOperationWorkflow(
      input.project,
      deleteKey,
    );
    if (!prior
      || prior.id !== deleteId
      || prior.kind !== "github_branch_compensation"
      || prior.state !== "succeeded"
      || prior.target !== `${source.repositoryFullName}:${source.targetRef}`
      || prior.steps.length !== 1
      || prior.steps[0]!.kind !== "github_delete_branch_exact_sha"
      || prior.steps[0]!.state !== "verified"
      || prior.requestSha256 !== branchCompensationRequestSha({
        action: "delete",
        repositoryFullName: source.repositoryFullName,
        targetRef: source.targetRef,
        recordedSha: source.recordedSha,
        sourceOperationId: source.workflow.id,
        sourceOperationIdempotencyKey: source.workflow.idempotencyKey,
        deleteCompensationId: null,
        deleteCompensationIdempotencyKey: null,
      })) {
      throw new GitHubBranchCompensationConflictError(
        "github_branch_compensation_delete_identity_conflict",
      );
    }
  }

  #build(
    input: GitHubBranchCompensationInput,
    source: AdmittedSource,
  ): OperationWorkflow {
    const request = branchCompensationRequest({
      action: input.action,
      repositoryFullName: source.repositoryFullName,
      targetRef: source.targetRef,
      recordedSha: source.recordedSha,
      sourceOperationId: source.workflow.id,
      sourceOperationIdempotencyKey: source.workflow.idempotencyKey,
      deleteCompensationId: input.action === "restore"
        ? input.deleteCompensationId!
        : null,
      deleteCompensationIdempotencyKey: input.action === "restore"
        ? input.deleteCompensationIdempotencyKey!
        : null,
    });
    const command = input.action === "delete"
      ? {
        repository: source.repositoryFullName,
        targetRef: source.targetRef,
        expectedOldSha: source.recordedSha,
        nextSha: null,
        sourceOperationId: source.workflow.id,
      }
      : {
        repository: source.repositoryFullName,
        targetRef: source.targetRef,
        expectedOldSha: null,
        nextSha: source.recordedSha,
        sourceOperationId: source.workflow.id,
        deleteCompensationId: input.deleteCompensationId!,
      };
    const reverse = input.action === "delete"
      ? {
        repository: source.repositoryFullName,
        targetRef: source.targetRef,
        expectedOldSha: null,
        nextSha: source.recordedSha,
        sourceOperationId: source.workflow.id,
      }
      : {
        repository: source.repositoryFullName,
        targetRef: source.targetRef,
        expectedOldSha: source.recordedSha,
        nextSha: null,
        sourceOperationId: source.workflow.id,
      };
    const generatedId = this.#dependencies.idFactory?.();
    return buildOperationWorkflow({
      ...(generatedId === undefined ? {} : { id: generatedId }),
      project: input.project,
      itemId: input.itemId,
      runId: input.runId,
      actorId: input.actorId,
      clientId: input.clientId,
      kind: "github_branch_compensation",
      target: `${source.repositoryFullName}:${source.targetRef}`,
      request,
      idempotencyKey: input.idempotencyKey,
      authorityFence: input.authorityFence,
      steps: [{
        kind: input.action === "delete"
          ? "github_delete_branch_exact_sha"
          : "github_restore_branch_exact_sha",
        command,
        compensation: {
          disposition: "conditionally_reversible",
          kind: input.action === "delete"
            ? "github_restore_branch_exact_sha"
            : "github_delete_branch_exact_sha",
          command: reverse,
        },
      }],
      now: this.#now(),
    });
  }

  async #readbackAfterMutation(
    input: GitHubBranchCompensationInput,
    source: AdmittedSource,
    workflow: OperationWorkflow,
    before: GitHubBranchCompensationObservation,
    mutation: GitHubRunnerGitMutationResult,
  ): Promise<OperationWorkflow> {
    let after: GitHubBranchCompensationObservation;
    try {
      after = admitObservation(
        await this.#dependencies.observeBranch({
          repositoryFullName: source.repositoryFullName,
          targetRef: source.targetRef,
        }),
        source,
      );
    } catch {
      return await this.#hold(
        workflow,
        "github_branch_compensation_readback_unavailable",
        mutation,
      );
    }
    if (postconditionMatches(input.action, after, source.recordedSha)) {
      return await this.#verify(
        workflow,
        before,
        after,
        mutation,
        mutation.outcome === "ambiguous",
      );
    }
    return await this.#hold(
      workflow,
      mutation.outcome === "ambiguous"
        ? "github_branch_compensation_outcome_ambiguous"
        : "github_branch_compensation_readback_mismatch",
      mutation,
    );
  }

  async #reconcileReserved(
    input: GitHubBranchCompensationInput,
    source: AdmittedSource,
    workflow: OperationWorkflow,
  ): Promise<OperationWorkflow> {
    await this.#dependencies.assertAuthority(input);
    let observation: GitHubBranchCompensationObservation;
    try {
      observation = admitObservation(
        await this.#dependencies.observeBranch({
          repositoryFullName: source.repositoryFullName,
          targetRef: source.targetRef,
        }),
        source,
      );
    } catch {
      throw new GitHubBranchCompensationPendingReconciliationError(workflow);
    }
    if (!postconditionMatches(input.action, observation, source.recordedSha)) {
      throw new GitHubBranchCompensationPendingReconciliationError(workflow);
    }
    const step = workflow.steps[0]!;
    const next = settleOperationWorkflowStep(workflow, {
      stepId: step.id,
      outcome: "verified",
      settledAt: this.#now(),
      providerReceiptRef: step.providerReceiptRef
        ?? `runner-git-reconciled:${workflow.id}`,
      before: { state: "unknown_due_to_interrupted_settlement" },
      after: observation,
      verification: {
        state: "reconciled_from_readback",
        sourceRevision: observation.sourceRevision,
      },
    });
    return await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next,
    });
  }

  async #verify(
    workflow: OperationWorkflow,
    before: GitHubBranchCompensationObservation,
    after: GitHubBranchCompensationObservation,
    mutation: GitHubRunnerGitMutationResult,
    reconciled: boolean,
  ): Promise<OperationWorkflow> {
    const next = settleOperationWorkflowStep(workflow, {
      stepId: workflow.steps[0]!.id,
      outcome: "verified",
      settledAt: this.#now(),
      providerReceiptRef: `runner-git:${mutation.attemptId}`,
      before,
      after,
      verification: {
        state: reconciled ? "reconciled_from_readback" : "passed",
        sourceRevision: after.sourceRevision,
      },
    });
    return await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next,
    });
  }

  async #rejectPlanned(
    workflow: OperationWorkflow,
    code: string,
  ): Promise<never> {
    const reserved = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next: reserveOperationWorkflowStep(
        workflow,
        workflow.steps[0]!.id,
        this.#now(),
      ),
    });
    return await this.#reject(reserved, code);
  }

  async #hold(
    workflow: OperationWorkflow,
    code: string,
    mutation?: GitHubRunnerGitMutationResult,
  ): Promise<never> {
    const next = settleOperationWorkflowStep(workflow, {
      stepId: workflow.steps[0]!.id,
      outcome: "pending_reconciliation",
      settledAt: this.#now(),
      ...(mutation === undefined
        ? {}
        : { providerReceiptRef: `runner-git:${mutation.attemptId}` }),
      errorCode: exactCode(code),
    });
    const persisted = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next,
    });
    throw new GitHubBranchCompensationPendingReconciliationError(persisted);
  }

  async #reject(
    workflow: OperationWorkflow,
    code: string,
    mutation?: GitHubRunnerGitMutationResult,
  ): Promise<never> {
    const next = settleOperationWorkflowStep(workflow, {
      stepId: workflow.steps[0]!.id,
      outcome: "rejected",
      settledAt: this.#now(),
      ...(mutation === undefined
        ? {}
        : { providerReceiptRef: `runner-git:${mutation.attemptId}` }),
      errorCode: exactCode(code),
    });
    const persisted = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next,
    });
    throw new GitHubBranchCompensationConflictError(code, persisted);
  }
}

function admittedBranchReceipt(
  receipt: GitHubProviderReceipt | null,
  source: OperationWorkflow,
  repositoryFullName: string,
  targetRef: string,
): AdmittedBranchReceipt {
  if (!receipt
    || receipt.project !== source.project
    || receipt.repositoryFullName !== repositoryFullName
    || receipt.operation !== "github_create_branch"
    || receipt.target !== `${repositoryFullName}:${targetRef}`
    || receipt.idempotencyKey !== source.steps[0]!.providerIdempotencyKey
    || !["succeeded", "reconciled"].includes(receipt.state)
    || receipt.result === null
    || typeof receipt.result !== "object") {
    throw new GitHubBranchCompensationConflictError(
      "github_branch_compensation_source_receipt_conflict",
    );
  }
  const result = receipt.result as unknown as Record<string, unknown>;
  if (result.kind !== "branch"
    || typeof result.name !== "string"
    || typeof result.ref !== "string"
    || result.ref !== targetRef
    || `refs/heads/${result.name}` !== targetRef) {
    throw new GitHubBranchCompensationConflictError(
      "github_branch_compensation_source_receipt_conflict",
    );
  }
  return Object.freeze({
    name: result.name,
    ref: result.ref,
    commitSha: admitGitObjectId(result.commitSha),
  });
}

function admitObservation(
  value: GitHubBranchCompensationObservation,
  source: AdmittedSource,
): GitHubBranchCompensationObservation {
  if (!value || typeof value !== "object") {
    throw new RangeError("GitHub branch compensation observation is invalid");
  }
  const repositoryFullName = admitGitHubRepositoryFullName(value.repositoryFullName);
  const targetRef = exactHeadRef(value.targetRef);
  const defaultBranchRef = exactHeadRef(value.defaultBranchRef);
  if (repositoryFullName !== source.repositoryFullName || targetRef !== source.targetRef) {
    throw new RangeError("GitHub branch compensation observation changed identity");
  }
  if (!["present", "absent"].includes(value.state)
    || !["unprotected", "protected", "unknown"].includes(value.protection)) {
    throw new RangeError("GitHub branch compensation observation state is invalid");
  }
  const commitSha = value.commitSha === null
    ? null
    : admitGitObjectId(value.commitSha);
  if ((value.state === "present") !== (commitSha !== null)) {
    throw new RangeError("GitHub branch compensation observation head is incoherent");
  }
  const sourceRevision = exactIdentifier(
    value.sourceRevision,
    "GitHub branch compensation source revision",
    240,
  );
  return Object.freeze({
    repositoryFullName,
    targetRef,
    defaultBranchRef,
    state: value.state,
    commitSha,
    protection: value.protection,
    sourceRevision,
  });
}

function postconditionMatches(
  action: GitHubBranchCompensationAction,
  observation: GitHubBranchCompensationObservation,
  recordedSha: string,
): boolean {
  return action === "delete"
    ? observation.state === "absent"
    : observation.state === "present" && observation.commitSha === recordedSha;
}

function branchCompensationRequest(input: {
  action: GitHubBranchCompensationAction;
  repositoryFullName: string;
  targetRef: string;
  recordedSha: string;
  sourceOperationId: string;
  sourceOperationIdempotencyKey: string;
  deleteCompensationId: string | null;
  deleteCompensationIdempotencyKey: string | null;
}) {
  return {
    version: 1,
    action: input.action,
    repositoryFullName: input.repositoryFullName,
    targetRef: input.targetRef,
    recordedSha: input.recordedSha,
    sourceOperationId: input.sourceOperationId,
    sourceOperationIdempotencyKey: input.sourceOperationIdempotencyKey,
    deleteCompensationId: input.deleteCompensationId,
    deleteCompensationIdempotencyKey: input.deleteCompensationIdempotencyKey,
  } as const;
}

function branchCompensationRequestSha(
  input: Parameters<typeof branchCompensationRequest>[0],
): string {
  return sha256(stableJson(branchCompensationRequest(input)));
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactCode(value: unknown): string {
  return exactIdentifier(value, "GitHub branch compensation code", 120);
}
