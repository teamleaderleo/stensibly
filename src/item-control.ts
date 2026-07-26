import type { Item, ItemEvent, ItemKind, ItemStatus } from "./store.js";

export const itemControlOperations = [
  "claim",
  "renew",
  "release",
  "complete",
  "handoff",
  "block",
  "unblock",
] as const;

export type ItemControlOperation = typeof itemControlOperations[number];
export type ItemAuthorityState =
  | "unclaimed"
  | "live"
  | "expiring"
  | "expired"
  | "superseded";
export type ItemAuthoritySource = "claim" | "dispatcher" | "none";
export type ItemEscalationState = "none" | "decision_required" | "blocked";

export interface ItemControlView {
  version: 1;
  authority: {
    state: ItemAuthorityState;
    holderActorId: string | null;
    generation: number;
    expiresAt: string | null;
    source: ItemAuthoritySource;
    allowedOperations: ItemControlOperation[];
    approvalRequiredOperations: ItemControlOperation[];
  };
  responsibility: {
    actorId: string | null;
    summary: string | null;
    nextAction: string | null;
    heartbeatExpectedAt: string | null;
    evidenceRequired: string[];
    escalationState: ItemEscalationState;
  };
}

export interface ItemControlInput {
  item: Item;
  events: ItemEvent[];
  runs?: unknown[];
}

export interface ItemControlOptions {
  now?: Date;
  expiringWithinSeconds?: number;
}

const readyOperations: ItemControlOperation[] = ["claim", "complete", "handoff", "block"];
const liveOperations: ItemControlOperation[] = ["renew", "release", "complete", "handoff", "block"];
const blockedOperations: ItemControlOperation[] = ["complete", "handoff", "unblock"];
const itemStatuses = new Set<ItemStatus>(["ready", "active", "blocked", "done", "archived"]);
const itemKinds = new Set<ItemKind>([
  "task",
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
]);
const sensitiveValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:ghp|github_pat|sk|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bstn\.tok_[A-Za-z0-9._-]+\b/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

export function buildItemControlView(
  input: ItemControlInput,
  rawOptions: ItemControlOptions = {},
): ItemControlView {
  const now = validDate(rawOptions.now ?? new Date());
  const expiringWithinSeconds = boundedInteger(
    rawOptions.expiringWithinSeconds,
    300,
    0,
    86_400,
    "Expiring authority window",
  );
  const item = input.item as Item & Record<string, unknown>;
  const generation = safeGeneration(item.claimGeneration);
  const status = safeStatus(item.status);
  const kind = safeKind(item.kind);
  const responsibility = {
    actorId: responsibilityActor(input, status),
    summary: safeOptionalPresentationText(item.summary, 10_000),
    nextAction: safeOptionalPresentationText(item.nextAction, 2_000),
    heartbeatExpectedAt: null,
    evidenceRequired: [] as string[],
    escalationState: escalationState(status, kind),
  };

  if (generation === null || status === null) {
    return failClosed(generation ?? 0, responsibility);
  }

  const holder = safeAuthorityActorId(item.claimedBy);
  const expiry = safeTimestamp(item.claimExpiresAt);
  const carriesClaim = item.claimedBy !== null || item.claimExpiresAt !== null;
  if (holder.invalid || expiry.invalid) {
    return failClosed(generation, { ...responsibility, actorId: null });
  }

  if (status === "active") {
    if (!holder.value || !expiry.value) {
      return failClosed(generation, { ...responsibility, actorId: null });
    }
    const source = authoritySource(input.events, generation);
    if (expiry.millis <= now.getTime()) {
      if (generation >= Number.MAX_SAFE_INTEGER) {
        return failClosed(generation, { ...responsibility, actorId: null });
      }
      return controlView({
        state: "expired",
        holderActorId: null,
        generation: generation + 1,
        expiresAt: expiry.value,
        source,
        allowedOperations: readyOperations,
        responsibility: { ...responsibility, actorId: holder.value },
      });
    }
    const expiring = expiry.millis - now.getTime() <= expiringWithinSeconds * 1000;
    return controlView({
      state: expiring ? "expiring" : "live",
      holderActorId: holder.value,
      generation,
      expiresAt: expiry.value,
      source,
      allowedOperations: liveOperations,
      responsibility: { ...responsibility, actorId: holder.value },
    });
  }

  if (carriesClaim) {
    return failClosed(generation, { ...responsibility, actorId: null });
  }

  if (status === "done" || status === "archived") {
    return controlView({
      state: "superseded",
      holderActorId: null,
      generation,
      expiresAt: null,
      source: "none",
      allowedOperations: [],
      responsibility: { ...responsibility, actorId: null },
    });
  }

  if (status === "blocked") {
    return controlView({
      state: "superseded",
      holderActorId: null,
      generation,
      expiresAt: null,
      source: "none",
      allowedOperations: blockedOperations,
      responsibility,
    });
  }

  const expired = latestEventMatchesGeneration(input.events, "claim.expired", generation);
  return controlView({
    state: expired ? "expired" : generation === 0 ? "unclaimed" : "superseded",
    holderActorId: null,
    generation,
    expiresAt: expired ? expiredTimestamp(input.events, generation) : null,
    source: expired ? authoritySource(input.events, generation - 1) : "none",
    allowedOperations: readyOperations,
    responsibility,
  });
}

function controlView(input: {
  state: ItemAuthorityState;
  holderActorId: string | null;
  generation: number;
  expiresAt: string | null;
  source: ItemAuthoritySource;
  allowedOperations: readonly ItemControlOperation[];
  responsibility: ItemControlView["responsibility"];
}): ItemControlView {
  return {
    version: 1,
    authority: {
      state: input.state,
      holderActorId: input.holderActorId,
      generation: input.generation,
      expiresAt: input.expiresAt,
      source: input.source,
      allowedOperations: [...input.allowedOperations],
      approvalRequiredOperations: [],
    },
    responsibility: input.responsibility,
  };
}

function failClosed(
  generation: number,
  responsibility: ItemControlView["responsibility"],
): ItemControlView {
  return controlView({
    state: "superseded",
    holderActorId: null,
    generation,
    expiresAt: null,
    source: "none",
    allowedOperations: [],
    responsibility,
  });
}

function authoritySource(events: ItemEvent[], generation: number): ItemAuthoritySource {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "claim.created") continue;
    if (numberField(event.payload, "generation") !== generation) continue;
    return textField(event.payload, "source") === "supervisor_dispatch"
      ? "dispatcher"
      : "claim";
  }
  return "claim";
}

function responsibilityActor(
  input: ItemControlInput,
  status: ItemStatus | null,
): string | null {
  if (status === "done" || status === "archived") return null;
  const current = safeAuthorityActorId(input.item.claimedBy);
  if (!current.invalid && current.value) return current.value;

  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index];
    if (!event) continue;
    if (event.type === "item.completed") return null;
    if (event.type === "claim.expired") {
      const previous = safeAuthorityActorId(textField(event.payload, "previousClaimant"));
      if (!previous.invalid && previous.value) return previous.value;
      continue;
    }
    if (event.type === "work.handed_off") {
      const target = safeAuthorityActorId(textField(event.payload, "toActorId"));
      if (!target.invalid && target.value) return target.value;
    }
    if ([
      "work.handed_off",
      "work.blocked",
      "work.unblocked",
      "claim.created",
      "claim.renewed",
      "claim.released",
      "item.created",
    ].includes(event.type)) {
      const actor = safeAuthorityActorId(event.actorId);
      if (!actor.invalid && actor.value) return actor.value;
    }
  }
  return null;
}

function latestEventMatchesGeneration(
  events: ItemEvent[],
  type: string,
  generation: number,
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== type) continue;
    return numberField(event.payload, "nextGeneration") === generation;
  }
  return false;
}

function expiredTimestamp(events: ItemEvent[], generation: number): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "claim.expired") continue;
    if (numberField(event.payload, "nextGeneration") !== generation) continue;
    const timestamp = safeTimestamp(textField(event.payload, "expiredAt"));
    return timestamp.invalid ? null : timestamp.value;
  }
  return null;
}

function escalationState(
  status: ItemStatus | null,
  kind: ItemKind | null,
): ItemEscalationState {
  if (status === "blocked") return "blocked";
  if (status !== "done" && status !== "archived" && kind === "decision") {
    return "decision_required";
  }
  return "none";
}

function safeGeneration(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function safeStatus(value: unknown): ItemStatus | null {
  return typeof value === "string" && itemStatuses.has(value as ItemStatus)
    ? value as ItemStatus
    : null;
}

function safeKind(value: unknown): ItemKind | null {
  return typeof value === "string" && itemKinds.has(value as ItemKind)
    ? value as ItemKind
    : null;
}

function safeAuthorityActorId(value: unknown): { value: string | null; invalid: boolean } {
  if (value === null || value === undefined) return { value: null, invalid: false };
  if (typeof value !== "string") return { value: null, invalid: true };
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) return { value: null, invalid: true };
  return redactText(normalized) === normalized
    ? { value: normalized, invalid: false }
    : { value: null, invalid: true };
}

function safeTimestamp(value: unknown): {
  value: string | null;
  millis: number;
  invalid: boolean;
} {
  if (value === null || value === undefined) {
    return { value: null, millis: 0, invalid: false };
  }
  if (typeof value !== "string" || value.length > 64) {
    return { value: null, millis: 0, invalid: true };
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis < 0 || millis > 8.64e15) {
    return { value: null, millis: 0, invalid: true };
  }
  return { value: new Date(millis).toISOString(), millis, invalid: false };
}

function safeOptionalPresentationText(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  return redactText(clip(value, maximum));
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function redactText(value: string): string {
  let redacted = value.replace(/:\/\/([^/@:\s]+):([^/@\s]+)@/g, "://[REDACTED]@");
  for (const pattern of sensitiveValuePatterns) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new RangeError("Control view time must be valid");
  return value;
}
