export interface ItemDetailPayload {
  item: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
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
export function safeArtifactHref(value: unknown): string | null;
export function payloadEntries(payload: unknown, maxLength?: number): PayloadEntry[];
export function createRequestGate(): RequestGate;
