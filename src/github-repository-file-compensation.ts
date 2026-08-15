import { createHash } from "node:crypto";
import { sha256, stableJson } from "./canonical-json.js";
import {
  admitGitHubRepositoryWriteReceipt,
  fingerprintGitHubRepositoryWriteReceipt,
} from "./github-repository-write-receipt-admission.js";
import {
  fingerprintGitHubRepositoryWritePayload,
  type GitHubRepositoryWriteAuthorityProvider,
  type GitHubRepositoryWriteCommand,
  type GitHubRepositoryWritePayload,
  type GitHubRepositoryWriteReceipt,
} from "./github-repository-write-provider-service.js";
import {
  admitGitHubBranchRef,
  admitGitHubRepositoryFullName,
  admitGitHubRepositoryPath,
  admitGitObjectId,
  sameGitObjectFormat,
} from "./github-repository-write-admission.js";
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
import {
  prepareRepositoryWrite,
  type PreparedRepositoryWrite,
  type RepositoryWriteCommitTreeSnapshot,
  type RepositoryWriteIntent,
  type RepositoryWriteOperation,
  type RepositoryWriteTreeEntry,
} from "./repository-write-fence.js";

export const MAX_REPOSITORY_FILE_COMPENSATION_PREIMAGE_BYTES = 10 * 1024 * 1024;

export type RepositoryFileCompensationPathState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{
    kind: "blob";
    mode: "100644" | "100755";
    blobSha: string;
  }>;

export interface RepositoryFileCompensationBlob {
  readonly repositoryFullName: string;
  readonly blobSha: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly bytes: Uint8Array;
}

export interface RepositoryFileCompensationMutationResult {
  readonly commitSha: string;
  readonly targetRef: string;
  readonly parentSha: string;
  readonly restoredTreeSha: string;
  readonly providerRequestId?: string;
}

export interface GitHubRepositoryFileCompensationAdapter {
  getRefHead(input: {
    repositoryFullName: string;
    targetRef: string;
  }): Promise<string | null>;
  getCommitTreeSnapshot(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<unknown>;
  getBlobBytes(input: {
    repositoryFullName: string;
    blobSha: string;
    maximumBytes: number;
  }): Promise<RepositoryFileCompensationBlob>;
  dispatchRepositoryFileCompensation(input: {
    repositoryFullName: string;
    path: string;
    targetRef: string;
    expectedParentSha: string;
    expectedCurrent: RepositoryFileCompensationPathState;
    restored: RepositoryFileCompensationPathState;
    expectedRestoredTreeSha: string;
    message: string;
    idempotencyKey: string;
  }): Promise<RepositoryFileCompensationMutationResult>;
}

export interface GitHubRepositoryFileCompensationInput {
  readonly project: string;
  readonly itemId: string;
  readonly runId: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly authorityFence: OperationAuthorityFence;
  readonly sourceReceiptId: string;
  readonly sourceReceiptSha256: string;
  readonly sourceWrite: unknown;
  readonly idempotencyKey: string;
}

export interface GitHubRepositoryFileCompensationDependencies {
  readonly workflows: OperationWorkflowStore;
  readonly repositoryWrites: {
    getRepositoryWriteReceipt(
      project: string,
      idempotencyKey: string,
    ): Promise<GitHubRepositoryWriteReceipt | null>;
  };
  readonly repositoryWriteAuthority: GitHubRepositoryWriteAuthorityProvider;
  readonly assertAuthority: (
    input: GitHubRepositoryFileCompensationInput,
  ) => Promise<void>;
  readonly adapter: GitHubRepositoryFileCompensationAdapter;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

interface AdmittedSource {
  readonly receipt: GitHubRepositoryWriteReceipt;
  readonly receiptFingerprint: string;
  readonly command: Readonly<GitHubRepositoryWriteCommand>;
  readonly intent: Readonly<RepositoryWriteIntent>;
  readonly payload: GitHubRepositoryWritePayload;
  readonly compensationOperation: RepositoryWriteOperation;
  readonly sourcePostBlobSha: string | null;
}

interface PreimageEvidence {
  readonly parentSnapshot: RepositoryWriteCommitTreeSnapshot;
  readonly preimageState: RepositoryFileCompensationPathState;
  readonly preimageContentSha256: string | null;
  readonly preimageByteLength: number;
}

class PreimageConflictError extends Error {
  constructor() {
    super("Immutable repository-file preimage disagrees with admitted source write");
    this.name = "PreimageConflictError";
  }
}

class ProviderObservationUnavailableError extends Error {
  constructor() {
    super("Repository-file compensation provider observation is unavailable");
    this.name = "ProviderObservationUnavailableError";
  }
}

export class GitHubRepositoryFileCompensationConflictError extends Error {
  readonly code: string;
  readonly workflow: OperationWorkflow | null;

  constructor(code: string, workflow: OperationWorkflow | null = null) {
    super("GitHub repository-file compensation conflicts with durable or provider state");
    this.name = "GitHubRepositoryFileCompensationConflictError";
    this.code = identifier(code, "Repository-file compensation error code", 160);
    this.workflow = workflow;
  }
}

export class GitHubRepositoryFileCompensationPendingReconciliationError extends Error {
  readonly code: string;
  readonly workflow: OperationWorkflow;

  constructor(code: string, workflow: OperationWorkflow) {
    super("GitHub repository-file compensation requires explicit reconciliation");
    this.name = "GitHubRepositoryFileCompensationPendingReconciliationError";
    this.code = identifier(code, "Repository-file compensation pending code", 160);
    this.workflow = workflow;
  }
}

/**
 * Forward-compensate one exact, already-verified repository-file write.
 *
 * Raw preimage bytes are transient. Durable workflow evidence retains only exact
 * source/provider identities, object/content hashes, byte counts, authority,
 * idempotency, request evidence, and settlement state.
 */
export class GitHubRepositoryFileCompensationService {
  readonly #deps: GitHubRepositoryFileCompensationDependencies;
  readonly #now: () => string;

  constructor(dependencies: GitHubRepositoryFileCompensationDependencies) {
    this.#deps = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(input: GitHubRepositoryFileCompensationInput): Promise<OperationWorkflow> {
    const source = await this.#admitSource(input);
    const idempotencyKey = identifier(
      input.idempotencyKey,
      "Repository-file compensation idempotency key",
      240,
    );
    const existing = await this.#deps.workflows.getOperationWorkflow(source.receipt.project, idempotencyKey);
    if (existing?.state === "succeeded") {
      this.#assertReplayIdentity(existing, input, source, idempotencyKey);
      return existing;
    }

    const initialPrepared = await this.#prepareCompensation(input, source, existing);
    const candidate = this.#build(input, source, initialPrepared, idempotencyKey);
    const reservation = await this.#deps.workflows.reserveOperationWorkflow(candidate);
    if (reservation.outcome === "conflict") {
      throw new OperationWorkflowConflictError(
        "GitHub repository-file compensation idempotency key was reused by another request",
      );
    }
    let workflow = reservation.workflow;
    if (workflow.state === "succeeded") return workflow;
    if (workflow.state === "failed" || workflow.state === "partially_completed") {
      const failed = workflow.steps.find((step) => step.state === "rejected");
      throw new GitHubRepositoryFileCompensationConflictError(
        failed?.errorCode ?? "github_repository_file_compensation_failed",
        workflow,
      );
    }

    const mutation = workflow.steps[1]!;
    if (mutation.state === "pending_reconciliation") {
      return await this.#reconcileMutation(input, source, initialPrepared, workflow);
    }
    if (mutation.state === "dispatch_reserved") {
      workflow = await this.#hold(
        workflow,
        mutation.id,
        "github_repository_file_compensation_dispatch_outcome_ambiguous",
      );
      throw new GitHubRepositoryFileCompensationPendingReconciliationError(
        "github_repository_file_compensation_dispatch_outcome_ambiguous",
        workflow,
      );
    }

    const inspection = workflow.steps[0]!;
    let preimage: PreimageEvidence;
    if (inspection.state === "verified") {
      preimage = await this.#readPreimageOrWait(source, workflow);
    } else if (inspection.state === "planned" || inspection.state === "pending_reconciliation") {
      if (inspection.state === "planned") {
        workflow = await this.#reserve(workflow, inspection.id);
      }
      await this.#assertAuthorityOrWait(input, workflow);
      try {
        preimage = await this.#readPreimage(source);
      } catch (error) {
        if (error instanceof PreimageConflictError) {
          workflow = await this.#reject(
            workflow,
            workflow.steps[0]!.id,
            "github_repository_file_compensation_preimage_conflict",
          );
          throw new GitHubRepositoryFileCompensationConflictError(
            "github_repository_file_compensation_preimage_conflict",
            workflow,
          );
        }
        workflow = await this.#hold(
          workflow,
          workflow.steps[0]!.id,
          "github_repository_file_compensation_preimage_unavailable",
        );
        throw new GitHubRepositoryFileCompensationPendingReconciliationError(
          "github_repository_file_compensation_preimage_unavailable",
          workflow,
        );
      }

      const post = await this.#currentPostimageOrSettleFailure(source, preimage, workflow, 0);
      workflow = await this.#verifyInspection(workflow, source, preimage, post);
    } else {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_inspection_state_conflict",
        workflow,
      );
    }

    if (workflow.steps[1]!.state !== "planned") {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_mutation_state_conflict",
        workflow,
      );
    }

    await this.#assertAuthorityOrWait(input, workflow);
    const freshPrepared = await this.#prepareCompensation(input, source, workflow);
    if (freshPrepared.requestSha256 !== initialPrepared.requestSha256) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_authority_changed",
        workflow,
      );
    }
    await this.#currentPostimageOrSettleFailure(source, preimage, workflow, null);

    workflow = await this.#reserve(workflow, workflow.steps[1]!.id);
    let result: RepositoryFileCompensationMutationResult;
    try {
      result = admitMutationResult(
        await this.#deps.adapter.dispatchRepositoryFileCompensation({
          repositoryFullName: source.receipt.repositoryFullName,
          path: source.receipt.path,
          targetRef: source.receipt.targetRef,
          expectedParentSha: source.receipt.verified!.commitSha,
          expectedCurrent: sourcePostState(source, preimage),
          restored: preimage.preimageState,
          expectedRestoredTreeSha: preimage.parentSnapshot.treeSha,
          message: compensationMessage(workflow.id),
          idempotencyKey: workflow.steps[1]!.providerIdempotencyKey,
        }),
        source,
        preimage,
      );
    } catch {
      workflow = await this.#hold(
        workflow,
        workflow.steps[1]!.id,
        "github_repository_file_compensation_dispatch_outcome_ambiguous",
      );
      throw new GitHubRepositoryFileCompensationPendingReconciliationError(
        "github_repository_file_compensation_dispatch_outcome_ambiguous",
        workflow,
      );
    }

    try {
      await this.#deps.assertAuthority(input);
    } catch {
      workflow = await this.#hold(
        workflow,
        workflow.steps[1]!.id,
        "github_repository_file_compensation_authority_unavailable_after_dispatch",
        mutationReceiptRef(result),
      );
      throw new GitHubRepositoryFileCompensationPendingReconciliationError(
        "github_repository_file_compensation_authority_unavailable_after_dispatch",
        workflow,
      );
    }

    const readback = await this.#readback(source, preimage, workflow, result.commitSha);
    if (!readback) {
      workflow = await this.#hold(
        workflow,
        workflow.steps[1]!.id,
        "github_repository_file_compensation_readback_unresolved",
        mutationReceiptRef(result),
      );
      throw new GitHubRepositoryFileCompensationPendingReconciliationError(
        "github_repository_file_compensation_readback_unresolved",
        workflow,
      );
    }
    return await this.#verifyMutation(
      workflow,
      source,
      preimage,
      readback,
      mutationReceiptRef(result),
    );
  }

  #assertReplayIdentity(
    workflow: OperationWorkflow,
    input: GitHubRepositoryFileCompensationInput,
    source: AdmittedSource,
    idempotencyKey: string,
  ): void {
    if (
      workflow.kind !== "github_repository_file_compensation"
      || workflow.project !== source.receipt.project
      || workflow.itemId !== identifier(input.itemId, "Compensation item ID", 160)
      || workflow.runId !== identifier(input.runId, "Compensation run ID", 160)
      || workflow.actorId !== identifier(input.actorId, "Compensation actor ID", 160)
      || workflow.clientId !== identifier(input.clientId, "Compensation client ID", 240)
      || workflow.idempotencyKey !== idempotencyKey
      || workflow.target !== compensationTarget(source.receipt)
    ) {
      throw new OperationWorkflowConflictError(
        "GitHub repository-file compensation replay identity changed",
      );
    }
  }

  async #reconcileMutation(
    input: GitHubRepositoryFileCompensationInput,
    source: AdmittedSource,
    initialPrepared: PreparedRepositoryWrite,
    workflow: OperationWorkflow,
  ): Promise<OperationWorkflow> {
    await this.#assertAuthorityOrWait(input, workflow);
    const fresh = await this.#prepareCompensation(input, source, workflow);
    if (fresh.requestSha256 !== initialPrepared.requestSha256) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_authority_changed",
        workflow,
      );
    }
    const preimage = await this.#readPreimageOrWait(source, workflow);
    const expectedCommit = mutationCommitFromReceiptRef(workflow.steps[1]!.providerReceiptRef);
    const readback = await this.#readback(source, preimage, workflow, expectedCommit);
    if (!readback) {
      throw new GitHubRepositoryFileCompensationPendingReconciliationError(
        "github_repository_file_compensation_readback_unresolved",
        workflow,
      );
    }
    return await this.#verifyMutation(
      workflow,
      source,
      preimage,
      readback,
      workflow.steps[1]!.providerReceiptRef ?? `ghrf-comp:${readback.commitSha}:reconciled`,
    );
  }

  async #admitSource(input: GitHubRepositoryFileCompensationInput): Promise<AdmittedSource> {
    const command = admitSourceCommand(input.sourceWrite);
    if (command.project !== identifier(input.project, "Compensation project", 120)) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_source_project_conflict",
      );
    }
    const stored = await this.#deps.repositoryWrites.getRepositoryWriteReceipt(
      command.project,
      command.idempotencyKey,
    );
    if (!stored) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_source_receipt_missing",
      );
    }
    const receipt = admitGitHubRepositoryWriteReceipt(stored);
    const fingerprint = sha256Value(input.sourceReceiptSha256);
    if (
      receipt.id !== identifier(input.sourceReceiptId, "Source repository-write receipt ID", 240)
      || fingerprintGitHubRepositoryWriteReceipt(receipt) !== fingerprint
      || receipt.state !== "succeeded"
      || receipt.dispatchCount !== 1
      || receipt.verified === null
      || receipt.error !== null
      || receipt.project !== command.project
      || receipt.actorId !== command.actorId
      || receipt.clientId !== command.clientId
      || receipt.idempotencyKey !== command.idempotencyKey
    ) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_source_receipt_conflict",
      );
    }

    const intent = admitSourceIntent(command.intent);
    const payload = admitSourcePayload(command.payload);
    const prepared = prepareRepositoryWrite(intent, {
      version: 1,
      repositoryFullName: receipt.verified.repositoryFullName,
      targetRef: receipt.verified.targetRef,
      defaultBranch: receipt.verified.defaultBranch,
      authorityId: receipt.verified.authorityId,
      authorityGeneration: receipt.verified.authorityGeneration,
      defaultBranchApprovalId: receipt.verified.defaultBranchApprovalId,
    });
    if (
      payload.operation !== intent.operation
      || prepared.repositoryFullName !== receipt.repositoryFullName
      || prepared.targetRef !== receipt.targetRef
      || prepared.path !== receipt.path
      || prepared.operation !== receipt.operation
      || prepared.expectedParentSha !== receipt.expectedParentSha
      || prepared.requestSha256 !== receipt.requestSha256
      || receipt.verified.requestSha256 !== receipt.requestSha256
      || fingerprintGitHubRepositoryWritePayload(payload) !== receipt.payloadSha256
      || receipt.verified.commitSha !== receipt.verified.nextExpectedParentSha
    ) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_source_request_conflict",
      );
    }
    return Object.freeze({
      receipt,
      receiptFingerprint: fingerprint,
      command,
      intent,
      payload,
      compensationOperation: inverseOperation(receipt.operation),
      sourcePostBlobSha: payload.operation === "delete_file"
        ? null
        : gitBlobObjectId(Buffer.from(payload.content, "utf8"), receipt.expectedParentSha.length),
    });
  }

  async #prepareCompensation(
    input: GitHubRepositoryFileCompensationInput,
    source: AdmittedSource,
    workflow: OperationWorkflow | null,
  ): Promise<PreparedRepositoryWrite> {
    try {
      const authority = await this.#deps.repositoryWriteAuthority.getRepositoryWriteAuthority({
        project: source.receipt.project,
        repositoryFullName: source.receipt.repositoryFullName,
        targetRef: source.receipt.targetRef,
        operation: source.compensationOperation,
        actorId: identifier(input.actorId, "Compensation actor ID", 160),
        clientId: identifier(input.clientId, "Compensation client ID", 240),
      });
      return prepareRepositoryWrite({
        version: 1,
        repositoryFullName: source.receipt.repositoryFullName,
        path: source.receipt.path,
        operation: source.compensationOperation,
        targetRef: source.receipt.targetRef,
        expectedParentSha: source.receipt.verified!.commitSha,
      }, authority);
    } catch {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_authority_unavailable",
        workflow,
      );
    }
  }

  #build(
    input: GitHubRepositoryFileCompensationInput,
    source: AdmittedSource,
    prepared: PreparedRepositoryWrite,
    idempotencyKey: string,
  ): OperationWorkflow {
    const request = {
      sourceReceiptId: source.receipt.id,
      sourceReceiptSha256: source.receiptFingerprint,
      sourceRequestSha256: source.receipt.requestSha256,
      sourcePayloadSha256: source.receipt.payloadSha256,
      repositoryFullName: source.receipt.repositoryFullName,
      targetRef: source.receipt.targetRef,
      path: source.receipt.path,
      sourceOperation: source.receipt.operation,
      sourceExpectedParentSha: source.receipt.expectedParentSha,
      sourceVerifiedCommitSha: source.receipt.verified!.commitSha,
      expectedPreimageBlobSha: source.payload.operation === "create_file"
        ? null
        : source.payload.contentSha,
      expectedSourcePostBlobSha: source.sourcePostBlobSha,
      compensationOperation: source.compensationOperation,
      compensationRequestSha256: prepared.requestSha256,
      compensationAuthorityId: prepared.authorityId,
      compensationAuthorityGeneration: prepared.authorityGeneration,
      compensationDefaultBranchApprovalId: prepared.defaultBranchApprovalId,
    };
    return buildOperationWorkflow({
      ...(this.#deps.idFactory ? { id: this.#deps.idFactory() } : {}),
      project: source.receipt.project,
      itemId: identifier(input.itemId, "Compensation item ID", 160),
      runId: identifier(input.runId, "Compensation run ID", 160),
      actorId: identifier(input.actorId, "Compensation actor ID", 160),
      clientId: identifier(input.clientId, "Compensation client ID", 240),
      kind: "github_repository_file_compensation",
      target: compensationTarget(source.receipt),
      request,
      idempotencyKey,
      authorityFence: authorityFence(input.authorityFence),
      steps: [
        {
          kind: "github_verify_repository_file_preimage",
          command: {
            ...request,
            immutablePreimageCommitSha: source.receipt.expectedParentSha,
            maximumPreimageBytes: MAX_REPOSITORY_FILE_COMPENSATION_PREIMAGE_BYTES,
          },
          compensation: { disposition: "irreversible" },
        },
        {
          kind: "github_compensate_repository_file_exact_preimage",
          command: {
            ...request,
            expectedMutationParentSha: source.receipt.verified!.commitSha,
          },
          compensation: { disposition: "conditionally_reversible" },
        },
      ],
      now: timestamp(this.#now()),
    });
  }

  async #readPreimageOrWait(
    source: AdmittedSource,
    workflow: OperationWorkflow,
  ): Promise<PreimageEvidence> {
    try {
      return await this.#readPreimage(source);
    } catch (error) {
      if (error instanceof PreimageConflictError) {
        throw new GitHubRepositoryFileCompensationConflictError(
          "github_repository_file_compensation_preimage_conflict",
          workflow,
        );
      }
      throw new GitHubRepositoryFileCompensationPendingReconciliationError(
        "github_repository_file_compensation_preimage_unavailable",
        workflow,
      );
    }
  }

  async #readPreimage(source: AdmittedSource): Promise<PreimageEvidence> {
    let rawParent: unknown;
    try {
      rawParent = await this.#deps.adapter.getCommitTreeSnapshot({
        repositoryFullName: source.receipt.repositoryFullName,
        commitSha: source.receipt.expectedParentSha,
      });
    } catch {
      throw new ProviderObservationUnavailableError();
    }
    let parent: RepositoryWriteCommitTreeSnapshot;
    try {
      parent = admitSnapshot(
        rawParent,
        source.receipt.repositoryFullName,
        source.receipt.expectedParentSha,
      );
    } catch {
      throw new ProviderObservationUnavailableError();
    }
    const state = pathState(parent, source.receipt.path);
    if (source.payload.operation === "create_file") {
      if (state.kind !== "absent") throw new PreimageConflictError();
      return { parentSnapshot: parent, preimageState: state, preimageContentSha256: null, preimageByteLength: 0 };
    }
    if (state.kind !== "blob" || state.blobSha !== source.payload.contentSha) {
      throw new PreimageConflictError();
    }

    let rawBlob: RepositoryFileCompensationBlob;
    try {
      rawBlob = await this.#deps.adapter.getBlobBytes({
        repositoryFullName: source.receipt.repositoryFullName,
        blobSha: state.blobSha,
        maximumBytes: MAX_REPOSITORY_FILE_COMPENSATION_PREIMAGE_BYTES,
      });
    } catch {
      throw new ProviderObservationUnavailableError();
    }
    let blob: RepositoryFileCompensationBlob;
    try {
      blob = admitBlob(rawBlob, source.receipt.repositoryFullName, state.blobSha);
    } catch {
      throw new PreimageConflictError();
    }
    if (
      gitBlobObjectId(blob.bytes, state.blobSha.length) !== state.blobSha
      || bytesSha256(blob.bytes) !== blob.contentSha256
    ) throw new PreimageConflictError();
    return {
      parentSnapshot: parent,
      preimageState: state,
      preimageContentSha256: blob.contentSha256,
      preimageByteLength: blob.byteLength,
    };
  }

  async #currentPostimageOrSettleFailure(
    source: AdmittedSource,
    preimage: PreimageEvidence,
    workflow: OperationWorkflow,
    rejectStepIndex: number | null,
  ): Promise<RepositoryWriteCommitTreeSnapshot> {
    try {
      return await this.#requireCurrentPostimage(source, preimage);
    } catch (error) {
      if (error instanceof ProviderObservationUnavailableError) {
        throw new GitHubRepositoryFileCompensationPendingReconciliationError(
          "github_repository_file_compensation_current_state_unavailable",
          workflow,
        );
      }
      if (rejectStepIndex !== null) {
        const currentStep = workflow.steps[rejectStepIndex]!;
        const rejecting = currentStep.state === "dispatch_reserved"
          ? workflow
          : await this.#reserve(workflow, currentStep.id);
        const failed = await this.#reject(
          rejecting,
          rejecting.steps[rejectStepIndex]!.id,
          "github_repository_file_compensation_current_state_conflict",
        );
        throw new GitHubRepositoryFileCompensationConflictError(
          "github_repository_file_compensation_current_state_conflict",
          failed,
        );
      }
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_current_state_conflict",
        workflow,
      );
    }
  }

  async #requireCurrentPostimage(
    source: AdmittedSource,
    preimage: PreimageEvidence,
  ): Promise<RepositoryWriteCommitTreeSnapshot> {
    let head: string | null;
    try {
      head = await this.#deps.adapter.getRefHead({
        repositoryFullName: source.receipt.repositoryFullName,
        targetRef: source.receipt.targetRef,
      });
    } catch {
      throw new ProviderObservationUnavailableError();
    }
    if (head === null) throw new ProviderObservationUnavailableError();
    let admittedHead: string;
    try {
      admittedHead = admitGitObjectId(head);
    } catch {
      throw new ProviderObservationUnavailableError();
    }
    if (admittedHead !== source.receipt.verified!.commitSha) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_ref_drift",
      );
    }

    let raw: unknown;
    try {
      raw = await this.#deps.adapter.getCommitTreeSnapshot({
        repositoryFullName: source.receipt.repositoryFullName,
        commitSha: admittedHead,
      });
    } catch {
      throw new ProviderObservationUnavailableError();
    }
    let snapshot: RepositoryWriteCommitTreeSnapshot;
    try {
      snapshot = admitSnapshot(raw, source.receipt.repositoryFullName, admittedHead);
    } catch {
      throw new ProviderObservationUnavailableError();
    }
    if (
      snapshot.parentShas.length !== 1
      || snapshot.parentShas[0] !== source.receipt.expectedParentSha
      || !sameTreeExceptPath(
        preimage.parentSnapshot,
        snapshot,
        source.receipt.path,
        sourcePostState(source, preimage),
      )
    ) {
      throw new GitHubRepositoryFileCompensationConflictError(
        "github_repository_file_compensation_source_postimage_drift",
      );
    }
    return snapshot;
  }

  async #readback(
    source: AdmittedSource,
    preimage: PreimageEvidence,
    workflow: OperationWorkflow,
    expectedCommitSha: string | null,
  ): Promise<RepositoryWriteCommitTreeSnapshot | null> {
    let head: string | null;
    try {
      head = await this.#deps.adapter.getRefHead({
        repositoryFullName: source.receipt.repositoryFullName,
        targetRef: source.receipt.targetRef,
      });
    } catch {
      return null;
    }
    if (head === null) return null;
    let admittedHead: string;
    try {
      admittedHead = admitGitObjectId(head);
    } catch {
      return null;
    }
    if (admittedHead === source.receipt.verified!.commitSha) return null;
    if (expectedCommitSha !== null && admittedHead !== expectedCommitSha) return null;

    let raw: unknown;
    try {
      raw = await this.#deps.adapter.getCommitTreeSnapshot({
        repositoryFullName: source.receipt.repositoryFullName,
        commitSha: admittedHead,
      });
    } catch {
      return null;
    }
    let snapshot: RepositoryWriteCommitTreeSnapshot;
    try {
      snapshot = admitSnapshot(raw, source.receipt.repositoryFullName, admittedHead);
    } catch {
      return null;
    }
    return snapshot.parentShas.length === 1
      && snapshot.parentShas[0] === source.receipt.verified!.commitSha
      && snapshot.treeSha === preimage.parentSnapshot.treeSha
      && snapshot.messageSha256 === sha256(compensationMessage(workflow.id))
      && samePathState(pathState(snapshot, source.receipt.path), preimage.preimageState)
      ? snapshot
      : null;
  }

  async #assertAuthorityOrWait(
    input: GitHubRepositoryFileCompensationInput,
    workflow: OperationWorkflow,
  ): Promise<void> {
    try {
      await this.#deps.assertAuthority(input);
    } catch {
      throw new GitHubRepositoryFileCompensationPendingReconciliationError(
        "github_repository_file_compensation_authority_unavailable",
        workflow,
      );
    }
  }

  async #reserve(workflow: OperationWorkflow, stepId: string): Promise<OperationWorkflow> {
    return await this.#deps.workflows.transitionOperationWorkflow({
      current: workflow,
      next: reserveOperationWorkflowStep(workflow, stepId, timestamp(this.#now())),
    });
  }

  async #verifyInspection(
    workflow: OperationWorkflow,
    source: AdmittedSource,
    preimage: PreimageEvidence,
    post: RepositoryWriteCommitTreeSnapshot,
  ): Promise<OperationWorkflow> {
    return await this.#deps.workflows.transitionOperationWorkflow({
      current: workflow,
      next: settleOperationWorkflowStep(workflow, {
        stepId: workflow.steps[0]!.id,
        outcome: "verified",
        settledAt: timestamp(this.#now()),
        providerReceiptRef: preimageReceiptRef(preimage),
        before: sourceEvidence(source),
        after: preimageEvidence(preimage),
        verification: {
          sourceVerifiedCommitSha: post.commitSha,
          sourceParentSha: source.receipt.expectedParentSha,
          sourceTreeSha: post.treeSha,
          sourcePathState: sourcePostState(source, preimage),
        },
      }),
    });
  }

  async #verifyMutation(
    workflow: OperationWorkflow,
    source: AdmittedSource,
    preimage: PreimageEvidence,
    readback: RepositoryWriteCommitTreeSnapshot,
    providerReceiptRef: string,
  ): Promise<OperationWorkflow> {
    return await this.#deps.workflows.transitionOperationWorkflow({
      current: workflow,
      next: settleOperationWorkflowStep(workflow, {
        stepId: workflow.steps[1]!.id,
        outcome: "verified",
        settledAt: timestamp(this.#now()),
        providerReceiptRef,
        before: {
          commitSha: source.receipt.verified!.commitSha,
          pathState: sourcePostState(source, preimage),
        },
        after: {
          commitSha: readback.commitSha,
          treeSha: readback.treeSha,
          pathState: preimage.preimageState,
        },
        verification: {
          parentSha: source.receipt.verified!.commitSha,
          restoredTreeSha: preimage.parentSnapshot.treeSha,
          preimageObjectSha: preimage.preimageState.kind === "blob"
            ? preimage.preimageState.blobSha
            : null,
          preimageContentSha256: preimage.preimageContentSha256,
          preimageByteLength: preimage.preimageByteLength,
        },
      }),
    });
  }

  async #hold(
    workflow: OperationWorkflow,
    stepId: string,
    code: string,
    providerReceiptRef?: string,
  ): Promise<OperationWorkflow> {
    const step = workflow.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.state === "pending_reconciliation") return workflow;
    return await this.#deps.workflows.transitionOperationWorkflow({
      current: workflow,
      next: settleOperationWorkflowStep(workflow, {
        stepId,
        outcome: "pending_reconciliation",
        settledAt: timestamp(this.#now()),
        ...(providerReceiptRef ? { providerReceiptRef } : {}),
        errorCode: identifier(code, "Repository-file compensation pending code", 160),
      }),
    });
  }

  async #reject(workflow: OperationWorkflow, stepId: string, code: string): Promise<OperationWorkflow> {
    return await this.#deps.workflows.transitionOperationWorkflow({
      current: workflow,
      next: settleOperationWorkflowStep(workflow, {
        stepId,
        outcome: "rejected",
        settledAt: timestamp(this.#now()),
        errorCode: identifier(code, "Repository-file compensation rejection code", 160),
      }),
    });
  }
}

function admitSourceCommand(value: unknown): Readonly<GitHubRepositoryWriteCommand> {
  const record = exactRecord(value, ["project", "actorId", "clientId", "idempotencyKey", "intent", "payload"]);
  return Object.freeze({
    project: identifier(record.project, "Source write project", 120),
    actorId: identifier(record.actorId, "Source write actor ID", 120),
    clientId: identifier(record.clientId, "Source write client ID", 240),
    idempotencyKey: identifier(record.idempotencyKey, "Source write idempotency key", 240),
    intent: record.intent,
    payload: record.payload,
  });
}

function admitSourceIntent(value: unknown): Readonly<RepositoryWriteIntent> {
  const record = exactRecord(value, ["version", "repositoryFullName", "path", "operation", "targetRef", "expectedParentSha"]);
  if (record.version !== 1) throw new TypeError("Source repository-write intent version is invalid");
  return Object.freeze({
    version: 1,
    repositoryFullName: admitGitHubRepositoryFullName(record.repositoryFullName),
    path: admitGitHubRepositoryPath(record.path),
    operation: operation(record.operation),
    targetRef: admitGitHubBranchRef(record.targetRef),
    expectedParentSha: admitGitObjectId(record.expectedParentSha),
  });
}

function admitSourcePayload(value: unknown): GitHubRepositoryWritePayload {
  const record = exactRecord(value, ["operation"], ["content", "contentSha", "message"]);
  if (record.operation === "create_file") {
    exactKeys(record, ["operation", "content", "message"]);
    return Object.freeze({ operation: "create_file", content: content(record.content), message: message(record.message) });
  }
  if (record.operation === "update_file") {
    exactKeys(record, ["operation", "content", "contentSha", "message"]);
    return Object.freeze({
      operation: "update_file",
      content: content(record.content),
      contentSha: admitGitObjectId(record.contentSha),
      message: message(record.message),
    });
  }
  if (record.operation === "delete_file") {
    exactKeys(record, ["operation", "contentSha", "message"]);
    return Object.freeze({
      operation: "delete_file",
      contentSha: admitGitObjectId(record.contentSha),
      message: message(record.message),
    });
  }
  throw new TypeError("Source repository-write payload operation is invalid");
}

function sourcePostState(source: AdmittedSource, preimage: PreimageEvidence): RepositoryFileCompensationPathState {
  if (source.sourcePostBlobSha === null) return ABSENT;
  const mode = source.payload.operation === "create_file"
    ? "100644"
    : preimage.preimageState.kind === "blob"
      ? preimage.preimageState.mode
      : null;
  if (mode === null) throw new PreimageConflictError();
  return Object.freeze({ kind: "blob", mode, blobSha: source.sourcePostBlobSha });
}

function inverseOperation(value: RepositoryWriteOperation): RepositoryWriteOperation {
  if (value === "create_file") return "delete_file";
  if (value === "update_file") return "update_file";
  return "create_file";
}

function pathState(snapshot: RepositoryWriteCommitTreeSnapshot, path: string): RepositoryFileCompensationPathState {
  const matches = snapshot.entries.filter((entry) => entry.path === path);
  if (matches.length === 0) return ABSENT;
  if (matches.length !== 1) throw new PreimageConflictError();
  const entry = matches[0]!;
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    throw new PreimageConflictError();
  }
  return Object.freeze({ kind: "blob", mode: entry.mode, blobSha: entry.sha });
}

function sameTreeExceptPath(
  parent: RepositoryWriteCommitTreeSnapshot,
  current: RepositoryWriteCommitTreeSnapshot,
  path: string,
  expectedPath: RepositoryFileCompensationPathState,
): boolean {
  const expected = new Map(parent.entries.map((entry) => [entry.path, entry]));
  if (expectedPath.kind === "absent") expected.delete(path);
  else expected.set(path, { path, mode: expectedPath.mode, type: "blob", sha: expectedPath.blobSha });
  const actual = new Map(current.entries.map((entry) => [entry.path, entry]));
  if (expected.size !== actual.size) return false;
  for (const [entryPath, entry] of expected) {
    const observed = actual.get(entryPath);
    if (!observed || observed.mode !== entry.mode || observed.type !== entry.type || observed.sha !== entry.sha) {
      return false;
    }
  }
  return true;
}

function samePathState(left: RepositoryFileCompensationPathState, right: RepositoryFileCompensationPathState): boolean {
  return left.kind === "absent"
    ? right.kind === "absent"
    : right.kind === "blob" && left.mode === right.mode && left.blobSha === right.blobSha;
}

function admitSnapshot(
  value: unknown,
  repositoryFullName: string,
  commitSha: string,
): RepositoryWriteCommitTreeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Repository-file compensation snapshot is invalid");
  }
  const source = value as RepositoryWriteCommitTreeSnapshot;
  if (
    source.version !== 1
    || source.repositoryFullName !== repositoryFullName
    || source.commitSha !== commitSha
    || !Array.isArray(source.parentShas)
    || !Array.isArray(source.entries)
    || typeof source.messageSha256 !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(source.messageSha256)
  ) throw new RangeError("Repository-file compensation snapshot identity is invalid");
  const treeSha = admitGitObjectId(source.treeSha);
  const parentShas = source.parentShas.map((value) => admitGitObjectId(value));
  if (!sameGitObjectFormat(commitSha, treeSha, ...parentShas)) {
    throw new RangeError("Repository-file compensation snapshot object format changed");
  }
  const seen = new Set<string>();
  const entries: RepositoryWriteTreeEntry[] = source.entries.map((entry) => {
    const entryPath = admitGitHubRepositoryPath(entry.path);
    if (seen.has(entryPath)) throw new RangeError("Repository-file compensation snapshot path is duplicated");
    seen.add(entryPath);
    if (
      (entry.type !== "blob" && entry.type !== "commit")
      || (entry.type === "blob"
        ? !["100644", "100755", "120000"].includes(entry.mode)
        : entry.mode !== "160000")
    ) throw new RangeError("Repository-file compensation snapshot entry is invalid");
    const objectSha = admitGitObjectId(entry.sha);
    if (!sameGitObjectFormat(commitSha, objectSha)) {
      throw new RangeError("Repository-file compensation snapshot entry format changed");
    }
    return { path: entryPath, mode: entry.mode, type: entry.type, sha: objectSha };
  });
  return {
    version: 1,
    repositoryFullName,
    commitSha,
    parentShas: [...parentShas],
    messageSha256: source.messageSha256,
    treeSha,
    entries: [...entries],
  };
}

function admitBlob(
  value: RepositoryFileCompensationBlob,
  repositoryFullName: string,
  blobSha: string,
): RepositoryFileCompensationBlob {
  if (
    value.repositoryFullName !== repositoryFullName
    || value.blobSha !== blobSha
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 0
    || value.byteLength > MAX_REPOSITORY_FILE_COMPENSATION_PREIMAGE_BYTES
    || !/^sha256:[a-f0-9]{64}$/u.test(value.contentSha256)
    || !(value.bytes instanceof Uint8Array)
    || value.bytes.byteLength !== value.byteLength
  ) throw new RangeError("Repository-file compensation blob is invalid");
  const bytes = new Uint8Array(value.bytes.byteLength);
  bytes.set(value.bytes);
  return {
    repositoryFullName,
    blobSha,
    byteLength: value.byteLength,
    contentSha256: value.contentSha256,
    bytes,
  };
}

function admitMutationResult(
  value: RepositoryFileCompensationMutationResult,
  source: AdmittedSource,
  preimage: PreimageEvidence,
): RepositoryFileCompensationMutationResult {
  const commitSha = admitGitObjectId(value.commitSha);
  const parentSha = admitGitObjectId(value.parentSha);
  const restoredTreeSha = admitGitObjectId(value.restoredTreeSha);
  if (
    value.targetRef !== source.receipt.targetRef
    || parentSha !== source.receipt.verified!.commitSha
    || restoredTreeSha !== preimage.parentSnapshot.treeSha
    || !sameGitObjectFormat(commitSha, parentSha, restoredTreeSha)
  ) throw new RangeError("Repository-file compensation mutation result is invalid");
  return Object.freeze({
    commitSha,
    targetRef: source.receipt.targetRef,
    parentSha,
    restoredTreeSha,
    ...(value.providerRequestId === undefined
      ? {}
      : { providerRequestId: identifier(value.providerRequestId, "GitHub provider request ID", 128) }),
  });
}

function sourceEvidence(source: AdmittedSource): Record<string, unknown> {
  return {
    sourceReceiptId: source.receipt.id,
    sourceReceiptSha256: source.receiptFingerprint,
    sourceRequestSha256: source.receipt.requestSha256,
    sourcePayloadSha256: source.receipt.payloadSha256,
    sourceVerifiedCommitSha: source.receipt.verified!.commitSha,
  };
}

function preimageEvidence(preimage: PreimageEvidence): Record<string, unknown> {
  return {
    parentCommitSha: preimage.parentSnapshot.commitSha,
    parentTreeSha: preimage.parentSnapshot.treeSha,
    preimageObjectSha: preimage.preimageState.kind === "blob" ? preimage.preimageState.blobSha : null,
    preimageMode: preimage.preimageState.kind === "blob" ? preimage.preimageState.mode : null,
    preimageContentSha256: preimage.preimageContentSha256,
    preimageByteLength: preimage.preimageByteLength,
  };
}

function preimageReceiptRef(preimage: PreimageEvidence): string {
  return preimage.preimageState.kind === "absent"
    ? `ghrf-preimage:absent:${preimage.parentSnapshot.treeSha}:0`
    : `ghrf-preimage:${preimage.preimageState.blobSha}:${preimage.preimageState.mode}:${preimage.preimageByteLength}:${preimage.preimageContentSha256}`;
}

function mutationReceiptRef(result: RepositoryFileCompensationMutationResult): string {
  return `ghrf-comp:${result.commitSha}:${result.providerRequestId ?? "none"}`;
}

function mutationCommitFromReceiptRef(value: string | null): string | null {
  if (value === null || !value.startsWith("ghrf-comp:")) return null;
  const commitSha = value.split(":")[1];
  if (!commitSha) return null;
  try { return admitGitObjectId(commitSha); } catch { return null; }
}

function compensationTarget(receipt: GitHubRepositoryWriteReceipt): string {
  return `repo-file:${receipt.id}`;
}

function compensationMessage(workflowId: string): string {
  return `Stensibly repository-file compensation ${workflowId}`;
}

function gitBlobObjectId(bytes: Uint8Array, length: number): string {
  const algorithm = length === 40 ? "sha1" : length === 64 ? "sha256" : null;
  if (!algorithm) throw new RangeError("Repository-file compensation Git object format is invalid");
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function bytesSha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Repository-file compensation input record is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Repository-file compensation input contains an unsupported field");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors, key)) throw new TypeError("Repository-file compensation input omitted a required field");
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError("Repository-file compensation payload fields are invalid");
  }
}

function operation(value: unknown): RepositoryWriteOperation {
  if (value !== "create_file" && value !== "update_file" && value !== "delete_file") {
    throw new TypeError("Repository-file compensation operation is invalid");
  }
  return value;
}

function content(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 10 * 1024 * 1024) {
    throw new TypeError("Repository-file compensation source content is invalid");
  }
  return value;
}

function message(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value !== value.trim()
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) throw new TypeError("Repository-file compensation source message is invalid");
  return value;
}

const credentialPattern = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/|bearer\s+[A-Za-z0-9._~+\/-]{12,})/iu;

function identifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
    || credentialPattern.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function sha256Value(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Repository-file compensation SHA-256 is invalid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
  ) throw new TypeError("Repository-file compensation timestamp is invalid");
  return new Date(value).toISOString();
}

function authorityFence(value: OperationAuthorityFence): OperationAuthorityFence {
  if (!value || typeof value !== "object") throw new TypeError("Compensation authority fence is invalid");
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new TypeError("Compensation authority generation is invalid");
  }
  return Object.freeze({
    resource: identifier(value.resource, "Compensation authority resource", 240),
    holderId: identifier(value.holderId, "Compensation authority holder", 160),
    generation: value.generation,
    expiresAt: timestamp(value.expiresAt),
  });
}

const ABSENT = Object.freeze({ kind: "absent" as const });
