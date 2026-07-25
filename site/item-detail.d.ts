export interface ItemDependencyPayload {
  id: string;
  direction: "incoming" | "outgoing";
  kind: "blocks" | "depends_on" | "related_to" | "duplicates" | "supersedes";
  itemId: string;
  title: string;
  status: string;
  createdAt: string;
}

export interface ItemDetailPayload {
  item: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  dependencies: ItemDependencyPayload[];
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
export function dependencyRelationship(dependency: Partial<ItemDependencyPayload>): string;
export function dependencyBlocksCurrent(dependency: Partial<ItemDependencyPayload>): boolean;
export function safeArtifactHref(value: unknown): string | null;
export function payloadEntries(payload: unknown, maxLength?: number, maxEntries?: number): PayloadEntry[];
export function safeRequestId(value: unknown, activeToken?: string): string | null;
export function redactCredentialText(value: unknown, activeToken?: string): string;
export function createRequestGate(): RequestGate;
