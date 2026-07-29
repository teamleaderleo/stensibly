import { attachArtifact, listArtifacts } from "./artifacts.js";
import type {
  CompleteWithContinuationsInput,
  CompletionContinuationLedger,
} from "./completion-continuation-contracts.js";
import {
  completeWorkWithContinuations,
  ensureCompletionContinuationSchema,
} from "./completion-continuations.js";
import { completeWork as completeFencedWork } from "./completion.js";
import { installSqliteCompletionParity } from "./completion-parity.js";
import { getProjectBrief } from "./briefs.js";
import {
  editContinuation,
  type EditContinuationInput,
} from "./continuation-edit.js";
import type { ContinuationSupervisorLedger } from "./continuation-supervisor-contracts.js";
import {
  ensureContinuationSupervisorSchema,
  queueContinuationForSupervisor,
  runContinuationSupervisorPolicy,
  type QueueContinuationForSupervisorInput,
  type RunContinuationSupervisorPolicyInput,
} from "./continuation-supervisor.js";
import {
  ensureContinuationSchema,
  getContinuation,
  listContinuations,
  proposeContinuation,
  resolveContinuation,
  type ListContinuationsInput,
  type ProposeContinuationInput,
  type ResolveContinuationInput,
} from "./continuations.js";
import {
  readBoundedItemArtifacts,
  readBoundedItemEvents,
  readBoundedItemRuns,
  readLatestItemEvent,
} from "./item-detail-sqlite.js";
import { assertPublicRecordableItemEventType } from "./item-control-events.js";
import { readItemControlRuns } from "./item-control-sqlite.js";
import { projectItemControl } from "./item-control.js";
import { hasRecordedIdempotencyKey, touchItemActivity } from "./item-activity.js";
import { expireClaims, renewClaim } from "./leases.js";
import type {
  AttachWorkArtifactInput,
  BlockWorkInput,
  ClaimActionInput,
  ClaimWorkInput,
  CompleteWorkInput,
  CreateWorkInput,
  HandoffWorkInput,
  ListWorkInput,
  RecordWorkEventInput,
  RenewClaimInput,
  UnblockWorkInput,
  WorkLedger,
} from "./ledger.js";
import type {
  OperationReceiptInput,
  OperationReceiptLedger,
} from "./operation-receipt-contracts.js";
import { getSqliteOperationReceipt } from "./operation-receipts-sqlite.js";
import type {
  AcceptProjectAttachmentInput,
  ProjectAttachmentLedger,
} from "./project-attachment-ledger.js";
import {
  acceptSqliteProjectAttachment,
  ensureProjectAttachmentSchema,
  getSqliteProjectAttachment,
} from "./project-attachments-sqlite.js";
import {
  reconcileStaleRunItems,
  syncItemLeaseFromRun,
} from "./run-item-recovery.js";
import { transitionWorkRunWithItemProjection } from "./run-item-projection.js";
import type { ClaimRunnerWorkInput, RunnerLedger } from "./runner-contracts.js";
import { claimRunnerWork } from "./runner-queue.js";
import {
  getWorkRun,
  heartbeatWorkRun,
  listWorkRuns,
  type HeartbeatWorkRunInput,
  type ListWorkRunsInput,
  type TransitionWorkRunInput,
} from "./runs.js";
import { requireMatchingSqliteIdempotency } from "./sqlite-idempotency-scope.js";
import { StensiblyStore } from "./store.js";
import { blockWork, handoffWork, unblockWork } from "./transitions.js";

export class SqliteWorkLedger implements
  WorkLedger,
  CompletionContinuationLedger,
  ContinuationSupervisorLedger,
  RunnerLedger,
  ProjectAttachmentLedger,
  OperationReceiptLedger
{
  constructor(readonly store: StensiblyStore) {
    installSqliteCompletionParity(store);
    ensureContinuationSchema(store);
    ensureCompletionContinuationSchema(store);
    ensureContinuationSupervisorSchema(store);
    ensureProjectAttachmentSchema(store);
  }

  async getBrief(project: string, limit: number) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    return getProjectBrief(this.store, project, limit);
  }

  async getOperationReceipt(input: OperationReceiptInput) {
    return getSqliteOperationReceipt(this.store, input);
  }

  async getProjectAttachment(project: string) {
    return getSqliteProjectAttachment(this.store, project);
  }

  async acceptProjectAttachment(input: AcceptProjectAttachmentInput) {
    return acceptSqliteProjectAttachment(this.store, input);
  }

  async listWork(input: ListWorkInput = {}) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    return this.store.listItems(input);
  }

  async getItem(id: string) {
    const now = new Date();
    const item = this.store.getItem(id);
    const events = readBoundedItemEvents(this.store, id);
    const artifacts = readBoundedItemArtifacts(this.store, id);
    const runs = readBoundedItemRuns(this.store, id);
    const controlRuns = readItemControlRuns(this.store, id);
    const controlEvents = [
      readLatestItemEvent(this.store, id, "claim.created"),
      readLatestItemEvent(this.store, id, "run.queued"),
      readLatestItemEvent(this.store, id, "work.handed_off"),
    ].filter((event) => event !== null);
    return {
      item,
      control: projectItemControl({ item, runs: controlRuns, events: controlEvents, now }),
      events,
      artifacts,
      runs,
      dependencies: [],
      reservations: [],
    };
  }

  async listArtifacts(id: string) {
    return listArtifacts(this.store, id);
  }

  async attachArtifact(input: AttachWorkArtifactInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "artifact.attached",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: {
        kind: input.kind,
        label: input.label,
        uri: input.uri,
      },
    });
    const replay = hasRecordedIdempotencyKey(this.store, input.idempotencyKey);
    const artifact = attachArtifact(this.store, {
      itemId: input.id,
      actor: input.actor,
      kind: input.kind,
      label: input.label,
      uri: input.uri,
      metadata: input.metadata,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    });
    if (!replay) touchItemActivity(this.store, input.id, artifact.createdAt);
    return artifact;
  }

  async createItem(input: CreateWorkInput) {
    const { idempotencyKey, ...item } = input;
    requireMatchingSqliteIdempotency(this.store, idempotencyKey, {
      project: item.project,
      operation: "item.created",
      payloadSubset: {
        project: item.project,
        kind: item.kind,
        title: item.title,
      },
    });
    return this.store.createItem(item, idempotencyKey);
  }

  async claimWork(input: ClaimWorkInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "claim.created",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: { leaseSeconds: input.leaseSeconds },
    });
    return this.store.claimItem(
      input.id,
      input.actor,
      input.leaseSeconds,
      input.idempotencyKey,
    );
  }

  async renewClaim(input: RenewClaimInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "claim.renewed",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: {
        leaseSeconds: input.leaseSeconds,
        generation: input.expectedClaimGeneration,
      },
    });
    return renewClaim(
      this.store,
      input.id,
      input.actor,
      input.leaseSeconds,
      input.expectedClaimGeneration,
      input.idempotencyKey,
    );
  }

  async handoffWork(input: HandoffWorkInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "work.handed_off",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return handoffWork(this.store, input);
  }

  async blockWork(input: BlockWorkInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "work.blocked",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return blockWork(this.store, input);
  }

  async unblockWork(input: UnblockWorkInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "work.unblocked",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return unblockWork(this.store, input);
  }

  async releaseWork(input: ClaimActionInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "claim.released",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: { generation: input.expectedClaimGeneration },
    });
    return this.store.releaseItem(
      input.id,
      input.actor,
      input.expectedClaimGeneration,
      input.idempotencyKey,
    );
  }

  async recordEvent(input: RecordWorkEventInput) {
    assertPublicRecordableItemEventType(input.type);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: input.type,
      itemId: input.id,
      actorId: input.actor?.id ?? null,
      payload: input.payload,
    });
    const replay = hasRecordedIdempotencyKey(this.store, input.idempotencyKey);
    const event = this.store.recordEvent({
      itemId: input.id,
      ...(input.actor ? { actor: input.actor } : {}),
      type: input.type,
      payload: input.payload,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (!replay) touchItemActivity(this.store, input.id, event.createdAt);
    return event;
  }

  async completeWork(input: CompleteWorkInput) {
    reconcileStaleRunItems(this.store);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "item.completed",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return completeFencedWork(this.store, input);
  }

  async completeWorkWithContinuations(input: CompleteWithContinuationsInput) {
    reconcileStaleRunItems(this.store);
    return completeWorkWithContinuations(this.store, input);
  }

  async proposeContinuation(input: ProposeContinuationInput) {
    return proposeContinuation(this.store, input);
  }

  async getContinuation(id: string) {
    return getContinuation(this.store, id);
  }

  async listContinuations(input: ListContinuationsInput = {}) {
    return listContinuations(this.store, input);
  }

  async resolveContinuation(input: ResolveContinuationInput) {
    return resolveContinuation(this.store, input);
  }

  async editContinuation(input: EditContinuationInput) {
    return editContinuation(this.store, input);
  }

  async queueContinuationForSupervisor(input: QueueContinuationForSupervisorInput) {
    reconcileStaleRunItems(this.store);
    return queueContinuationForSupervisor(this.store, input);
  }

  async runContinuationSupervisorPolicy(input: RunContinuationSupervisorPolicyInput) {
    reconcileStaleRunItems(this.store);
    return runContinuationSupervisorPolicy(this.store, input);
  }

  async claimRunnerWork(input: ClaimRunnerWorkInput) {
    reconcileStaleRunItems(this.store);
    return claimRunnerWork(this.store, input);
  }

  async getRun(id: string) {
    reconcileStaleRunItems(this.store);
    return getWorkRun(this.store, id);
  }

  async listRuns(input: ListWorkRunsInput = {}) {
    reconcileStaleRunItems(this.store);
    return listWorkRuns(this.store, input);
  }

  async heartbeatRun(input: HeartbeatWorkRunInput) {
    reconcileStaleRunItems(this.store);
    const run = heartbeatWorkRun(this.store, input);
    syncItemLeaseFromRun(this.store, run, new Date(run.updatedAt), input.actor.id);
    return run;
  }

  async transitionRun(input: TransitionWorkRunInput) {
    reconcileStaleRunItems(this.store);
    return transitionWorkRunWithItemProjection(this.store, input);
  }
}
