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
import { hasRecordedIdempotencyKey, touchItemActivity } from "./item-activity.js";
import { buildItemControlView } from "./item-control.js";
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
import { StensiblyStore } from "./store.js";
import { blockWork, handoffWork, unblockWork } from "./transitions.js";

export class SqliteWorkLedger implements
  WorkLedger,
  CompletionContinuationLedger,
  ContinuationSupervisorLedger,
  RunnerLedger,
  ProjectAttachmentLedger
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
    reconcileStaleRunItems(this.store, now);
    expireClaims(this.store, now);
    const detail = {
      item: this.store.getItem(id),
      events: this.store.listEvents(id),
      artifacts: listArtifacts(this.store, id),
      runs: listWorkRuns(this.store, { itemId: id }),
      dependencies: [],
      reservations: [],
    };
    return {
      ...detail,
      control: buildItemControlView(detail, { now }),
    };
  }

  async listArtifacts(id: string) {
    return listArtifacts(this.store, id);
  }

  async attachArtifact(input: AttachWorkArtifactInput) {
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
    return this.store.createItem(item, idempotencyKey);
  }

  async claimWork(input: ClaimWorkInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    return this.store.claimItem(
      input.id,
      input.actor,
      input.leaseSeconds,
      input.idempotencyKey,
    );
  }

  async renewClaim(input: RenewClaimInput) {
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
    return handoffWork(this.store, input);
  }

  async blockWork(input: BlockWorkInput) {
    return blockWork(this.store, input);
  }

  async unblockWork(input: UnblockWorkInput) {
    return unblockWork(this.store, input);
  }

  async releaseWork(input: ClaimActionInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    return this.store.releaseItem(
      input.id,
      input.actor,
      input.expectedClaimGeneration,
      input.idempotencyKey,
    );
  }

  async recordEvent(input: RecordWorkEventInput) {
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
