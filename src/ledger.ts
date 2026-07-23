import type { Artifact, ArtifactKind } from "./artifacts.js";
import type { ActorInput } from "./schemas.js";
import type {
  Item,
  ItemEvent,
  ItemKind,
  ItemStatus,
} from "./store.js";

export interface ListWorkInput {
  project?: string;
  status?: ItemStatus;
}

export interface CreateWorkInput {
  project: string;
  kind: ItemKind;
  title: string;
  summary?: string;
  nextAction?: string;
  priority: number;
  actor?: ActorInput;
  idempotencyKey?: string;
}

export interface ClaimWorkInput {
  id: string;
  actor: ActorInput;
  leaseSeconds: number;
  idempotencyKey?: string;
}

export interface ActorActionInput {
  id: string;
  actor: ActorInput;
  idempotencyKey?: string;
}

export interface CompleteWorkInput extends ActorActionInput {
  summary?: string;
}

export interface HandoffWorkInput extends ActorActionInput {
  summary: string;
  nextAction: string;
  toActorId?: string;
}

export interface BlockWorkInput extends ActorActionInput {
  reason: string;
  nextAction?: string;
}

export interface UnblockWorkInput extends ActorActionInput {
  nextAction?: string;
}

export interface RecordWorkEventInput {
  id: string;
  actor?: ActorInput;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface AttachWorkArtifactInput {
  id: string;
  actor: ActorInput;
  kind: ArtifactKind;
  label: string;
  uri: string;
  mimeType?: string;
  metadata: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ItemDetail {
  item: Item;
  events: ItemEvent[];
  artifacts: Artifact[];
  runs?: unknown[];
  dependencies?: unknown[];
}

export interface WorkLedger {
  getBrief(project: string, limit: number): Promise<unknown>;
  listWork(input?: ListWorkInput): Promise<Item[]>;
  getItem(id: string): Promise<ItemDetail>;
  listArtifacts(id: string): Promise<Artifact[]>;
  attachArtifact(input: AttachWorkArtifactInput): Promise<Artifact>;
  createItem(input: CreateWorkInput): Promise<Item>;
  claimWork(input: ClaimWorkInput): Promise<Item>;
  renewClaim(input: ClaimWorkInput): Promise<Item>;
  handoffWork(input: HandoffWorkInput): Promise<Item>;
  blockWork(input: BlockWorkInput): Promise<Item>;
  unblockWork(input: UnblockWorkInput): Promise<Item>;
  releaseWork(input: ActorActionInput): Promise<Item>;
  recordEvent(input: RecordWorkEventInput): Promise<ItemEvent>;
  completeWork(input: CompleteWorkInput): Promise<Item>;
}
