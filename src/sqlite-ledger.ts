import { attachArtifact, listArtifacts } from "./artifacts.ts";
import { getProjectBrief } from "./briefs.ts";
import { expireClaims, renewClaim } from "./leases.ts";
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
} from "./ledger.ts";
import { StensiblyStore } from "./store.ts";
import { blockWork, handoffWork, unblockWork } from "./transitions.ts";

export class SqliteWorkLedger implements WorkLedger {
  constructor(readonly store: StensiblyStore) {}

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
    return attachArtifact(this.store, {
      itemId: input.id,
      actor: input.actor,
      kind: input.kind,
      label: input.label,
      uri: input.uri,
      metadata: input.metadata,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
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
    return this.store.recordEvent({
      itemId: input.id,
      ...(input.actor ? { actor: input.actor } : {}),
      type: input.type,
      payload: input.payload,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
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
}
