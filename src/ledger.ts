import type { Artifact, ArtifactKind } from "./artifacts.js";
import type { ActorInput } from "./schemas.js";
import type {
  Item,
  ItemEvent,
  ItemKind,
  ItemStatus,
} from "./store.js";

export type DependencyKind =
  | "blocks"
  | "depends_on"
  | "related_to"
  | "duplicates"
  | "supersedes";

export interface ItemDependency {
  id: string;
  direction: "incoming" | "outgoing";
  kind: DependencyKind;
  itemId: string;
  title: string;
  status: ItemStatus;
  createdAt: string;
}

export interface ItemReservation {
  id: string;
  resource: string;
  mode: "exclusive" | "shared";
  capacity: number;
  units: number;
  usedUnits: number;
  availableUnits: number;
  holderActorId: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface ItemRun {
  id: string;
  itemId: string;
  actorId: string;
  harness: string;
  model: string | null;
  externalRunId: string | null;
  repository: string | null;
  branch: string | null;
  worktree: string | null;
  status: RunStatus;
  childAgentCount: number | null;
  toolCallCount: number | null;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  outcome: string | null;
}

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
  runs?: ItemRun[];
  dependencies?: ItemDependency[];
  reservations?: ItemReservation[];
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
