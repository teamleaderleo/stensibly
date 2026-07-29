export interface IdempotencyActorInput {
  id: string;
  name: string;
  kind: string;
  capabilities?: readonly string[];
}

export interface CreateItemIdempotencyRequestInput {
  project: string;
  kind: string;
  title: string;
  summary?: string;
  nextAction?: string;
  priority: number;
  actor?: IdempotencyActorInput;
}

export interface AttachArtifactIdempotencyRequestInput {
  itemId: string;
  actor: IdempotencyActorInput;
  kind: string;
  label: string;
  uri: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export function canonicalCreateItemIdempotencyRequest(
  input: CreateItemIdempotencyRequestInput,
): unknown {
  return {
    schemaVersion: 1,
    operation: "item.created",
    project: input.project,
    kind: input.kind,
    title: input.title,
    summary: input.summary ?? null,
    nextAction: input.nextAction ?? null,
    priority: input.priority,
    actor: canonicalActor(input.actor),
  };
}

export function canonicalAttachArtifactIdempotencyRequest(
  input: AttachArtifactIdempotencyRequestInput,
): unknown {
  return {
    schemaVersion: 1,
    operation: "artifact.attached",
    itemId: input.itemId,
    actor: canonicalActor(input.actor),
    kind: input.kind,
    label: input.label,
    uri: input.uri,
    mimeType: input.mimeType ?? null,
    metadata: input.metadata ?? {},
  };
}

export function canonicalIdempotencyRequestText(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalActor(actor: IdempotencyActorInput | undefined): unknown {
  if (!actor) return null;
  return {
    id: actor.id,
    name: actor.name,
    kind: actor.kind,
    capabilities: actor.capabilities ? [...actor.capabilities] : null,
  };
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry === undefined ? null : canonicalJson(entry));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  throw new TypeError("Idempotency request must contain only JSON-compatible values");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
