import { attachArtifact, listArtifacts } from "./artifacts.js";
import type {
  CompleteWithContinuationsInput,
  CompletionContinuationLedger,
} from "./completion-continuation-contracts.js";
import {
  completeWorkWithContinuations,
  ensureCompletionContinuationSchema,
} from "./completion-continuations.js";
import { installSqliteCompletionParity } from "./completion-parity.js";
import { getProjectBrief } from "./briefs.js";
import {
  editContinuation,
  type EditContinuationInput,
} from "./continuation-edit.js";
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
import { expireClaims, renewClaim } from "./leases.js";
import type {
  ActorActionInput,
  AttachWorkArtifactInput,
  BlockWorkInput,
  ClaimWorkInput,
  CompleteWorkInput,
  CreateWorkInput,
  HandoffWorkInput,
  ListWorkInput,
  RecordWorkEventInput,
  UnblockWorkInput,
  WorkLedger,
} from "./ledger.js";
import { StensiblyStore } from "./store.js";
import { blockWork, handoffWork, unblockWork } from "./transitions.js";

export class SqliteWorkLedger implements WorkLedger, CompletionContinuationLedger {
  constructor(readonly store: StensiblyStore) {
    installSqliteCompletionParity(store);
    ensureContinuationSchema(store);
    ensureCompletionContinuationSchema(store);
  }

  async getBrief(project: string, limit: number) {
    return getProjectBrief(this.store, project, limit);
  }

  async listWork(input: ListWorkInput = {}) {
    expireClaims(this.store);
    return this.store.listItems(input);
  }

  async getItem(id: string) {
    expireClaims(this.store);
    return {
      item: this.store.getItem(id),
      events: this.store.listEvents(id),
      artifacts: listArtifacts(this.store, id),
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
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (!replay) touchItemActivity(this.store, input.id, artifact.createdAt);
    return artifact;
  }

  async createItem(input: CreateWorkInput) {
    const { idempotencyKey, ...item } = input;
    return this.store.createItem(item, idempotencyKey);
  }

  async claimWork(input: ClaimWorkInput) {
    expireClaims(this.store);
    return this.store.claimItem(
      input.id,
      input.actor,
      input.leaseSeconds,
      input.idempotencyKey,
    );
  }

  async renewClaim(input: ClaimWorkInput) {
    return renewClaim(
      this.store,
      input.id,
      input.actor,
      input.leaseSeconds,
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

  async releaseWork(input: ActorActionInput) {
    expireClaims(this.store);
    return this.store.releaseItem(input.id, input.actor, input.idempotencyKey);
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
    expireClaims(this.store);
    return this.store.completeItem(
      input.id,
      input.actor,
      input.summary,
      input.idempotencyKey,
    );
  }

  async completeWorkWithContinuations(input: CompleteWithContinuationsInput) {
    expireClaims(this.store);
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
}
