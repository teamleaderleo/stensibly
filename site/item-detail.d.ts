export interface PublicItemEventPayload {
  id: string;
  itemId: string;
  actorId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ItemDependencyPayload {
  id: string;
  direction: "incoming" | "outgoing";
  kind: "blocks" | "depends_on" | "related_to" | "duplicates" | "supersedes";
  itemId: string;
  title: string;
  status: string;
  createdAt: string;
}

export interface ItemReservationPayload {
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

export interface ItemRunPayload {
  id: string;
  itemId: string;
  actorId: string;
  harness: string;
  model: string | null;
  externalRunId: string | null;
  repository: string | null;
  branch: string | null;
  worktree: string | null;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  childAgentCount: number | null;
  toolCallCount: number | null;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  outcome: string | null;
}

export interface ItemDetailPayload {
  historyContractVersion: 1 | null;
  eventsTruncated: boolean | null;
  item: Record<string, unknown>;
  events: PublicItemEventPayload[];
  artifacts: Array<Record<string, unknown>>;
  dependencies: ItemDependencyPayload[];
  reservations: ItemReservationPayload[];
  runs: ItemRunPayload[];
}

export interface PayloadEntry {
  key: string;
  value: string;
}

export interface RequestGate {
  begin(): number;
  invalidate(): void;
  isCurrent(requestId: number): boolean;
}

export function readItemDetail(payload: unknown, expectedItemId?: string): ItemDetailPayload;
export function readPublicEvent(value: unknown, expectedItemId?: string): PublicItemEventPayload | null;
export function dependencyRelationship(dependency: Partial<ItemDependencyPayload>): string;
export function dependencyBlocksCurrent(dependency: Partial<ItemDependencyPayload>): boolean;
export function reservationCapacityLabel(reservation: Partial<ItemReservationPayload>): string;
export function reservationIsFull(reservation: Partial<ItemReservationPayload>): boolean;
export function runIsActive(run: Partial<ItemRunPayload>): boolean;
export function runStatusLabel(run: Partial<ItemRunPayload>): string;
export function safeArtifactHref(value: unknown): string | null;
export function payloadEntries(payload: unknown, maxLength?: number, maxEntries?: number): PayloadEntry[];
export function safeRequestId(value: unknown, activeToken?: string): string | null;
export function redactCredentialText(value: unknown, activeToken?: string): string;
export function createRequestGate(): RequestGate;
