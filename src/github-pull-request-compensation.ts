import { sha256, stableJson } from "./canonical-json.js";
import type {
  GitHubProviderReceipt,
  GitHubPullRequestResult,
} from "./github-provider-contracts.js";
import { admitGitHubProviderReceipt } from "./github-provider-receipt-admission.js";
import {
  type GitHubPullRequestCompensationAdapter,
  type GitHubPullRequestCompensationObservation,
  GitHubPullRequestCompensationProviderRejectedError,
} from "./github-pull-request-compensation-contracts.js";
import {
  boundedText,
  normalizeGitHubRepository,
  positiveInteger,
} from "./github-provider-validation.js";
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

export interface GitHubPullRequestCompensationInput {
  project: string;
  itemId: string;
  runId: string;
  actorId: string;
  clientId: string;
  authorityFence: OperationAuthorityFence;
  repository: string;
  sourceOperationId: string;
  sourceOperationIdempotencyKey: string;
  idempotencyKey: string;
}

export interface GitHubPullRequestCompensationDependencies {
  workflows: OperationWorkflowStore;
  assertAuthority(input: GitHubPullRequestCompensationInput): Promise<void>;
  getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null>;
  adapter: GitHubPullRequestCompensationAdapter;
  now?: () => string;
  idFactory?: () => string;
}

interface AdmittedSource {
  workflow: OperationWorkflow;
  repositoryFullName: string;
  pullRequest: GitHubPullRequestResult;
}

export class GitHubPullRequestCompensationConflictError extends Error {
  readonly code: string;
  readonly workflow: OperationWorkflow | null;

  constructor(code: string, workflow: OperationWorkflow | null = null) {
    super("GitHub pull-request compensation conflicts with durable or provider state");
    this.name = "GitHubPullRequestCompensationConflictError";
    this.code = exactCode(code);
    this.workflow = workflow;
  }
}

export class GitHubPullRequestCompensationPendingReconciliationError extends Error {
  readonly code = "github_pull_request_compensation_pending_reconciliation";
  readonly workflow: OperationWorkflow;

  constructor(workflow: OperationWorkflow) {
    super("GitHub pull-request compensation requires exact provider reconciliation");
    this.name = "GitHubPullRequestCompensationPendingReconciliationError";
    this.workflow = workflow;
  }
}

export class GitHubPullRequestCompensationAuthorityUnavailableError extends Error {
  readonly code = "github_pull_request_compensation_authority_unavailable";
  readonly workflow: OperationWorkflow | null;

  constructor(workflow: OperationWorkflow | null) {
    super("GitHub pull-request compensation authority is unavailable");
    this.name = "GitHubPullRequestCompensationAuthorityUnavailableError";
    this.workflow = workflow;
  }
}

/**
 * Closes one exact pull request created by a verified github_publish_change
 * workflow. The original publication workflow and provider receipt are read-only
 * source evidence. Close compensation is a separate durable operation with its
 * own idempotency identity and exact provider readback.
 */
export class GitHubPullRequestCompensationService {
  readonly #dependencies: GitHubPullRequestCompensationDependencies;
  readonly #now: () => string;

  constructor(dependencies: GitHubPullRequestCompensationDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(input: GitHubPullRequestCompensationInput): Promise<OperationWorkflow> {
    const source = await this.#admitSource(input);
    await this.#assertAuthority(input, null);

    const candidate = this.#build(input, source);
    const reservation = await this.#dependencies.workflows.reserveOperationWorkflow(candidate);
    if (reservation.outcome === "conflict") {
      throw new OperationWorkflowConflictError(
        "GitHub pull-request compensation idempotency key was reused by another request",
      );
    }
    let workflow = reservation.workflow;
    if (workflow.state === "succeeded") return workflow;
    const step = workflow.steps[0]!;
    if (workflow.state === "failed") {
      throw new GitHubPullRequestCompensationConflictError(
        step.errorCode ?? "github_pull_request_compensation_failed",
        workflow,
      );
    }
    if (
      workflow.state === "waiting_reconciliation"
      || step.state === "dispatch_reserved"
      || step.state === "pending_reconciliation"
    ) {
      return await this.#reconcileReserved(input, source, workflow);
    }
    if (workflow.state !== "reserved" || step.state !== "planned") {
      throw new GitHubPullRequestCompensationConflictError(
        "github_pull_request_compensation_state_conflict",
        workflow,
      );
    }

    await this.#assertAuthority(input, workflow);
    let before: GitHubPullRequestCompensationObservation;
    try {
      before = admitObservation(
        await this.#dependencies.adapter.getPullRequestForCompensation({
          repositoryFullName: source.repositoryFullName,
          pullRequestNumber: source.pullRequest.number,
        }),
      );
    } catch {
      return await this.#rejectPlanned(
        workflow,
        "github_pull_request_compensation_observation_unavailable",
      );
    }
    if (!samePullRequest(before, source.pullRequest, "open")) {
      return await this.#rejectPlanned(
        workflow,
        before.state === "closed"
          ? "github_pull_request_compensation_source_not_open"
          : "github_pull_request_compensation_identity_drift",
      );
    }

    workflow = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next: reserveOperationWorkflowStep(workflow, step.id, this.#now()),
    });
    try {
      await this.#dependencies.assertAuthority(input);
    } catch {
      return await this.#reject(
        workflow,
        "github_pull_request_compensation_authority_lost_before_dispatch",
      );
    }

    let providerReceiptRef: string | null = null;
    let responseExact = false;
    let ambiguous = false;
    try {
      const mutation = await this.#dependencies.adapter.closePullRequest({
        repositoryFullName: source.repositoryFullName,
        pullRequestNumber: source.pullRequest.number,
        idempotencyKey: workflow.steps[0]!.providerIdempotencyKey,
      });
      providerReceiptRef = `github-pr-close:${exactIdentifier(
        mutation.providerRequestId,
        "GitHub pull-request close request ID",
        240,
      )}`;
      responseExact = samePullRequest(
        admitObservation(mutation.pullRequest),
        source.pullRequest,
        "closed",
      );
      ambiguous = !responseExact;
    } catch (error) {
      if (error instanceof GitHubPullRequestCompensationProviderRejectedError) {
        return await this.#reject(
          workflow,
          error.code,
        );
      }
      ambiguous = true;
    }

    return await this.#readbackAfterMutation(
      source,
      workflow,
      before,
      providerReceiptRef,
      ambiguous,
    );
  }

  async #admitSource(
    input: GitHubPullRequestCompensationInput,
  ): Promise<AdmittedSource> {
    const repositoryFullName = normalizeGitHubRepository(input.repository);
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
    if (
      !source
      || source.id !== sourceOperationId
      || source.kind !== "github_publish_change"
      || source.state !== "succeeded"
      || source.steps.length !== 3
    ) {
      throw new GitHubPullRequestCompensationConflictError(
        "github_pull_request_compensation_source_conflict",
      );
    }
    const pullRequestStep = source.steps[2]!;
    if (
      pullRequestStep.kind !== "github_create_pull_request"
      || pullRequestStep.state !== "verified"
    ) {
      throw new GitHubPullRequestCompensationConflictError(
        "github_pull_request_compensation_source_pr_unverified",
      );
    }

    const rawReceipt = await this.#dependencies.getGitHubProviderReceipt(
      input.project,
      pullRequestStep.providerIdempotencyKey,
    );
    let receipt: GitHubProviderReceipt;
    try {
      if (!rawReceipt) throw new Error("missing receipt");
      receipt = admitGitHubProviderReceipt(rawReceipt);
    } catch {
      throw new GitHubPullRequestCompensationConflictError(
        "github_pull_request_compensation_source_receipt_conflict",
      );
    }
    if (
      receipt.project !== source.project
      || receipt.repositoryFullName !== repositoryFullName
      || receipt.operation !== "github_create_pull_request"
      || receipt.idempotencyKey !== pullRequestStep.providerIdempotencyKey
      || receipt.actorId !== source.actorId
      || receipt.clientId !== source.clientId
      || (receipt.state !== "succeeded" && receipt.state !== "reconciled")
      || receipt.verification.state !== "passed"
      || receipt.result === null
      || !("kind" in receipt.result)
      || receipt.result.kind !== "pull_request"
    ) {
      throw new GitHubPullRequestCompensationConflictError(
        "github_pull_request_compensation_source_receipt_conflict",
      );
    }
    const retained = receipt.result;
    if (
      retained.state !== "open"
      || receipt.target
        !== `${repositoryFullName}:pull:new:${retained.head}->${retained.base}`
      || source.target !== `${repositoryFullName}:refs/heads/${retained.head}`
      || receipt.verification.sourceRevision !== retained.sourceRevision
    ) {
      throw new GitHubPullRequestCompensationConflictError(
        "github_pull_request_compensation_source_receipt_conflict",
      );
    }
    if (
      pullRequestStep.compensation.kind
        !== "github_close_created_pull_request_if_open"
      || pullRequestStep.compensation.commandSha256 !== sha256(stableJson({
        repository: repositoryFullName,
        head: retained.head,
        base: retained.base,
        operationId: source.id,
      }))
    ) {
      throw new GitHubPullRequestCompensationConflictError(
        "github_pull_request_compensation_source_plan_conflict",
      );
    }

    return Object.freeze({
      workflow: source,
      repositoryFullName,
      pullRequest: retained,
    });
  }

  #build(
    input: GitHubPullRequestCompensationInput,
    source: AdmittedSource,
  ): OperationWorkflow {
    const retained = source.pullRequest;
    const request = {
      version: 1,
      action: "close_pull_request" as const,
      repositoryFullName: source.repositoryFullName,
      pullRequestNumber: retained.number,
      providerNodeId: retained.providerNodeId,
      canonicalUrl: retained.canonicalUrl,
      sourcePullRequestRevision: retained.sourceRevision,
      sourceOperationId: source.workflow.id,
      sourceOperationIdempotencyKey: source.workflow.idempotencyKey,
    };
    const identity = pullRequestIdentityEvidence(retained);
    const generatedId = this.#dependencies.idFactory?.();
    return buildOperationWorkflow({
      ...(generatedId === undefined ? {} : { id: generatedId }),
      project: input.project,
      itemId: input.itemId,
      runId: input.runId,
      actorId: input.actorId,
      clientId: input.clientId,
      kind: "github_pull_request_compensation",
      target: `${source.repositoryFullName}:pull:${retained.number}`,
      request,
      idempotencyKey: input.idempotencyKey,
      authorityFence: input.authorityFence,
      steps: [{
        kind: "github_close_pull_request_exact_identity",
        command: {
          ...identity,
          desiredState: "closed",
          sourceOperationId: source.workflow.id,
        },
        compensation: {
          disposition: "conditionally_reversible",
          kind: "github_reopen_pull_request_exact_identity",
          command: {
            ...identity,
            desiredState: "open",
            sourceOperationId: source.workflow.id,
          },
        },
      }],
      now: this.#now(),
    });
  }

  async #readbackAfterMutation(
    source: AdmittedSource,
    workflow: OperationWorkflow,
    before: GitHubPullRequestCompensationObservation,
    providerReceiptRef: string | null,
    ambiguous: boolean,
  ): Promise<OperationWorkflow> {
    let after: GitHubPullRequestCompensationObservation;
    try {
      after = admitObservation(
        await this.#dependencies.adapter.getPullRequestForCompensation({
          repositoryFullName: source.repositoryFullName,
          pullRequestNumber: source.pullRequest.number,
        }),
      );
    } catch {
      return await this.#hold(
        workflow,
        "github_pull_request_compensation_readback_unavailable",
        providerReceiptRef,
      );
    }
    if (samePullRequest(after, source.pullRequest, "closed")) {
      return await this.#verify(
        workflow,
        before,
        after,
        providerReceiptRef,
        ambiguous,
      );
    }
    if (samePullRequest(after, source.pullRequest, "open")) {
      return await this.#hold(
        workflow,
        ambiguous
          ? "github_pull_request_compensation_outcome_ambiguous"
          : "github_pull_request_compensation_readback_open",
        providerReceiptRef,
      );
    }
    return await this.#hold(
      workflow,
      "github_pull_request_compensation_identity_drift_after_dispatch",
      providerReceiptRef,
    );
  }

  async #reconcileReserved(
    input: GitHubPullRequestCompensationInput,
    source: AdmittedSource,
    workflow: OperationWorkflow,
  ): Promise<OperationWorkflow> {
    await this.#assertAuthority(input, workflow);
    let observation: GitHubPullRequestCompensationObservation;
    try {
      observation = admitObservation(
        await this.#dependencies.adapter.getPullRequestForCompensation({
          repositoryFullName: source.repositoryFullName,
          pullRequestNumber: source.pullRequest.number,
        }),
      );
    } catch {
      throw new GitHubPullRequestCompensationPendingReconciliationError(workflow);
    }
    if (samePullRequest(observation, source.pullRequest, "closed")) {
      const step = workflow.steps[0]!;
      const next = settleOperationWorkflowStep(workflow, {
        stepId: step.id,
        outcome: "verified",
        settledAt: this.#now(),
        providerReceiptRef: step.providerReceiptRef
          ?? `github-pr-close-reconciled:${workflow.id}`,
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
    if (samePullRequest(observation, source.pullRequest, "open")) {
      throw new GitHubPullRequestCompensationPendingReconciliationError(workflow);
    }
    throw new GitHubPullRequestCompensationConflictError(
      "github_pull_request_compensation_identity_drift_during_reconciliation",
      workflow,
    );
  }

  async #verify(
    workflow: OperationWorkflow,
    before: GitHubPullRequestCompensationObservation,
    after: GitHubPullRequestCompensationObservation,
    providerReceiptRef: string | null,
    reconciled: boolean,
  ): Promise<OperationWorkflow> {
    const next = settleOperationWorkflowStep(workflow, {
      stepId: workflow.steps[0]!.id,
      outcome: "verified",
      settledAt: this.#now(),
      providerReceiptRef: providerReceiptRef
        ?? `github-pr-close-reconciled:${workflow.id}`,
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
    providerReceiptRef: string | null,
  ): Promise<never> {
    const next = settleOperationWorkflowStep(workflow, {
      stepId: workflow.steps[0]!.id,
      outcome: "pending_reconciliation",
      settledAt: this.#now(),
      ...(providerReceiptRef === null ? {} : { providerReceiptRef }),
      errorCode: exactCode(code),
    });
    const persisted = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next,
    });
    throw new GitHubPullRequestCompensationPendingReconciliationError(persisted);
  }

  async #reject(
    workflow: OperationWorkflow,
    code: string,
  ): Promise<never> {
    const next = settleOperationWorkflowStep(workflow, {
      stepId: workflow.steps[0]!.id,
      outcome: "rejected",
      settledAt: this.#now(),
      errorCode: exactCode(code),
    });
    const persisted = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next,
    });
    throw new GitHubPullRequestCompensationConflictError(code, persisted);
  }

  async #assertAuthority(
    input: GitHubPullRequestCompensationInput,
    workflow: OperationWorkflow | null,
  ): Promise<void> {
    try {
      await this.#dependencies.assertAuthority(input);
    } catch {
      throw new GitHubPullRequestCompensationAuthorityUnavailableError(workflow);
    }
  }
}

function pullRequestIdentityEvidence(result: GitHubPullRequestResult) {
  return {
    repositoryPullRequestNumber: result.number,
    providerNodeId: result.providerNodeId,
    canonicalUrl: result.canonicalUrl,
    title: result.title,
    head: result.head,
    headSha: result.headSha,
    base: result.base,
    baseSha: result.baseSha,
    draft: result.draft,
    bodyRevision: {
      byteLength: result.bodyRevision.byteLength,
      sha256: result.bodyRevision.sha256,
    },
    createdAt: result.createdAt,
    sourcePullRequestRevision: result.sourceRevision,
  } as const;
}

function admitObservation(
  value: GitHubPullRequestCompensationObservation,
): GitHubPullRequestCompensationObservation {
  if (!value || typeof value !== "object") {
    throw new RangeError("GitHub pull-request compensation observation is invalid");
  }
  if (value.kind !== "pull_request") {
    throw new RangeError("GitHub pull-request compensation observation kind is invalid");
  }
  const number = positiveInteger(value.number, "GitHub pull request number");
  const providerNodeId = value.providerNodeId === null
    ? null
    : boundedText(value.providerNodeId, "GitHub pull request node ID", 256);
  const title = boundedText(value.title, "GitHub pull request title", 256);
  const head = boundedText(value.head, "GitHub pull request head", 240);
  const headSha = exactObjectId(value.headSha, "GitHub pull request head SHA");
  const base = boundedText(value.base, "GitHub pull request base", 240);
  const baseSha = exactObjectId(value.baseSha, "GitHub pull request base SHA");
  if (typeof value.draft !== "boolean") {
    throw new RangeError("GitHub pull request draft flag is invalid");
  }
  if (value.state !== "open" && value.state !== "closed") {
    throw new RangeError("GitHub pull request state is invalid");
  }
  const canonicalUrl = boundedText(
    value.canonicalUrl,
    "GitHub pull request canonical URL",
    4_096,
  );
  const createdAt = exactTimestamp(value.createdAt, "GitHub pull request created time");
  const updatedAt = exactTimestamp(value.updatedAt, "GitHub pull request updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new RangeError("GitHub pull request update preceded creation");
  }
  if (
    !value.bodyRevision
    || typeof value.bodyRevision !== "object"
    || !Number.isSafeInteger(value.bodyRevision.byteLength)
    || value.bodyRevision.byteLength < 0
  ) {
    throw new RangeError("GitHub pull request body revision is invalid");
  }
  const bodyRevision = Object.freeze({
    byteLength: value.bodyRevision.byteLength,
    sha256: exactSha256(value.bodyRevision.sha256),
  });
  if (value.containsBody !== false) {
    throw new RangeError("GitHub pull request observation retained provider body");
  }
  const sourceRevision = exactSha256(value.sourceRevision);
  return Object.freeze({
    kind: "pull_request",
    number,
    providerNodeId,
    title,
    head,
    headSha,
    base,
    baseSha,
    draft: value.draft,
    state: value.state,
    canonicalUrl,
    createdAt,
    updatedAt,
    bodyRevision,
    sourceRevision,
    containsBody: false,
  });
}

function samePullRequest(
  observed: GitHubPullRequestCompensationObservation,
  retained: GitHubPullRequestResult,
  expectedState: "open" | "closed",
): boolean {
  return observed.number === retained.number
    && observed.providerNodeId === retained.providerNodeId
    && observed.title === retained.title
    && observed.head === retained.head
    && observed.headSha === retained.headSha
    && observed.base === retained.base
    && observed.baseSha === retained.baseSha
    && observed.draft === retained.draft
    && observed.state === expectedState
    && observed.canonicalUrl === retained.canonicalUrl
    && observed.createdAt === retained.createdAt
    && observed.bodyRevision.byteLength === retained.bodyRevision.byteLength
    && observed.bodyRevision.sha256 === retained.bodyRevision.sha256
    && observed.containsBody === false;
}

function exactObjectId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactSha256(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError("GitHub pull request source digest is invalid");
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new RangeError(`${label} is invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new RangeError(`${label} is invalid`);
  return new Date(time).toISOString();
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
  return exactIdentifier(value, "GitHub pull-request compensation code", 120);
}
