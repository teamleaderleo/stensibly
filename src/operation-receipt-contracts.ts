export interface OperationReceiptInput {
  project: string;
  idempotencyKey: string;
}

export type OperationReceiptResultKind = "item" | "event" | "artifact";

export interface RecordedOperationReceipt {
  status: "recorded";
  project: string;
  idempotencyKey: string;
  operation: string;
  eventId: string;
  itemId: string;
  actorId: string | null;
  recordedAt: string;
  result: {
    kind: OperationReceiptResultKind;
    id: string;
  };
  reconciliation: {
    retry: "do_not_retry";
    nextAction: "read_item";
    itemId: string;
  };
}

export interface UnknownOperationReceipt {
  status: "unknown";
  project: string;
  idempotencyKey: string;
  reconciliation: {
    retry: "same_request_same_key";
    nextAction: "retry_same_request_same_key";
  };
}

export type OperationReceipt = RecordedOperationReceipt | UnknownOperationReceipt;

export interface OperationReceiptLedger {
  getOperationReceipt(input: OperationReceiptInput): Promise<OperationReceipt>;
}

export interface ReceiptEventRecord {
  eventId: string;
  itemId: string;
  actorId: string | null;
  operation: string;
  payload: unknown;
  recordedAt: string;
}

const itemResultOperations = new Set([
  "item.created",
  "claim.created",
  "claim.renewed",
  "claim.released",
  "work.handed_off",
  "work.blocked",
  "work.unblocked",
  "item.completed",
]);

export function operationReceiptLedger(value: unknown): OperationReceiptLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<OperationReceiptLedger>;
  return typeof candidate.getOperationReceipt === "function"
    ? value as OperationReceiptLedger
    : null;
}

export function unknownOperationReceipt(
  input: OperationReceiptInput,
): UnknownOperationReceipt {
  return {
    status: "unknown",
    project: input.project,
    idempotencyKey: input.idempotencyKey,
    reconciliation: {
      retry: "same_request_same_key",
      nextAction: "retry_same_request_same_key",
    },
  };
}

export function recordedOperationReceipt(
  input: OperationReceiptInput,
  event: ReceiptEventRecord,
): RecordedOperationReceipt {
  return {
    status: "recorded",
    project: input.project,
    idempotencyKey: input.idempotencyKey,
    operation: event.operation,
    eventId: event.eventId,
    itemId: event.itemId,
    actorId: event.actorId,
    recordedAt: event.recordedAt,
    result: operationResult(event),
    reconciliation: {
      retry: "do_not_retry",
      nextAction: "read_item",
      itemId: event.itemId,
    },
  };
}

function operationResult(event: ReceiptEventRecord): {
  kind: OperationReceiptResultKind;
  id: string;
} {
  if (event.operation === "artifact.attached") {
    const artifactId = record(event.payload)?.artifactId;
    if (typeof artifactId === "string" && artifactId.trim()) {
      return { kind: "artifact", id: artifactId.trim() };
    }
  }
  if (itemResultOperations.has(event.operation)) {
    return { kind: "item", id: event.itemId };
  }
  return { kind: "event", id: event.eventId };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
