export const ITEM_CONTROL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_AUTHORITY_EXPIRING_WINDOW_MS = 5 * 60_000;

export const itemAuthorityOperations = [
  "claim",
  "renew",
  "release",
  "complete",
  "handoff",
  "block",
  "unblock",
] as const;

export type ItemAuthorityOperation = (typeof itemAuthorityOperations)[number];
export type ItemAuthorityState =
  | "unclaimed"
  | "live"
  | "expiring"
  | "expired"
  | "superseded";
export type ItemAuthoritySource = "claim" | "dispatcher" | "none";
export type ItemEscalationState = "none" | "decision_required" | "blocked";

export interface ItemControlItemInput {
  kind: unknown;
  status: unknown;
  summary: unknown;
  nextAction: unknown;
  claimedBy: unknown;
  claimExpiresAt: unknown;
  claimGeneration: unknown;
}

export interface ItemControlRunInput {
  actorId: unknown;
  leaseOwnerId?: unknown;
  status: unknown;
  leaseExpiresAt?: unknown;
  lastHeartbeatAt?: unknown;
}

export interface ItemControlEventInput {
  actorId: unknown;
  type: unknown;
  payload: unknown;
  createdAt?: unknown;
}

export interface ItemControlView {
  schemaVersion: typeof ITEM_CONTROL_SCHEMA_VERSION;
  authority: {
    state: ItemAuthorityState;
    holderActorId: string | null;
    generation: number;
    expiresAt: string | null;
    source: ItemAuthoritySource;
    allowedOperations: ItemAuthorityOperation[];
    approvalRequiredOperations: ItemAuthorityOperation[];
    unavailableReasons: Partial<Record<ItemAuthorityOperation, string>>;
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

export interface ProjectItemControlInput {
  item: ItemControlItemInput;
  runs?: ItemControlRunInput[];
  events?: ItemControlEventInput[];
  now?: Date | string | number;
  expiringWindowMs?: number;
}

const itemStatuses = new Set(["ready", "active", "blocked", "done", "archived"]);
const liveRunStatuses = new Set(["queued", "starting", "running", "waiting"]);
const credentialShape = /stn\.tok_/i;

export function projectItemControl(input: ProjectItemControlInput): ItemControlView {
  const now = timestamp(input.now ?? Date.now(), "Current time");
  const expiringWindowMs = boundedWindow(input.expiringWindowMs);
  const generationResult = generation(input.item.claimGeneration);
  const generationValue = generationResult ?? 0;
  const status = text(input.item.status);
  const kind = text(input.item.kind);
  const holder = nullableActorId(input.item.claimedBy);
  const expiry = nullableTimestamp(input.item.claimExpiresAt);
  const runs = Array.isArray(input.runs) ? input.runs.slice(0, 16) : [];
  const events = Array.isArray(input.events) ? input.events.slice(0, 16) : [];

  let state: ItemAuthorityState = "superseded";
  let source: ItemAuthoritySource = "none";
  let holderActorId: string | null = null;
  let expiresAt: string | null = null;
  let allowedOperations: ItemAuthorityOperation[] = [];
  let heartbeatExpectedAt: string | null = null;

  const coherentGeneration = generationResult !== null;
  const coherentStatus = itemStatuses.has(status);
  const coherentHolder = holder.valid;
  const coherentExpiry = expiry.valid;
  const terminal = status === "done" || status === "archived";
  const unclaimedFields = holder.value === null && expiry.value === null;

  if (coherentGeneration && coherentStatus && !terminal) {
    if ((status === "ready" || status === "blocked") && unclaimedFields) {
      state = "unclaimed";
      allowedOperations = status === "ready"
        ? ["claim", "complete", "handoff", "block"]
        : ["complete", "handoff", "unblock"];
    } else if (
      status === "active"
      && coherentHolder
      && coherentExpiry
      && holder.value !== null
      && expiry.value !== null
    ) {
      holderActorId = holder.value;
      expiresAt = expiry.value;
      const runAuthority = activeRunAuthority(runs, holderActorId, now);
      const claimSource = latestClaimSource(events, holderActorId, generationValue);
      source = runAuthority.kind === "matching" || claimSource === "dispatcher"
        ? "dispatcher"
        : "claim";

      if (runAuthority.kind === "conflict") {
        state = "superseded";
      } else if (expiry.millis <= now) {
        state = "expired";
        heartbeatExpectedAt = source === "dispatcher" ? expiresAt : null;
      } else {
        state = expiry.millis - now <= expiringWindowMs ? "expiring" : "live";
        allowedOperations = ["renew", "release", "complete", "handoff", "block"];
        heartbeatExpectedAt = source === "dispatcher"
          ? runAuthority.heartbeatExpectedAt ?? expiresAt
          : null;
      }
    }
  }

  if (terminal || state === "unclaimed" || state === "superseded") {
    source = "none";
    holderActorId = null;
    expiresAt = null;
    heartbeatExpectedAt = null;
  }

  const responsibilityActorId = responsibilityActor({
    status,
    state,
    holderActorId,
    generation: generationValue,
    events,
  });

  return {
    schemaVersion: ITEM_CONTROL_SCHEMA_VERSION,
    authority: {
      state,
      holderActorId,
      generation: generationValue,
      expiresAt,
      source,
      allowedOperations,
      approvalRequiredOperations: [],
      unavailableReasons: unavailableReasons(status, state, allowedOperations),
    },
    responsibility: {
      actorId: responsibilityActorId,
      summary: safeNullableText(input.item.summary, 10_000),
      nextAction: safeNullableText(input.item.nextAction, 2_000),
      heartbeatExpectedAt,
      evidenceRequired: [],
      escalationState: status === "blocked"
        ? "blocked"
        : kind === "decision" && !terminal
        ? "decision_required"
        : "none",
    },
  };
}

function activeRunAuthority(
  runs: ItemControlRunInput[],
  holderActorId: string,
  now: number,
):
  | { kind: "none"; heartbeatExpectedAt: null }
  | { kind: "matching"; heartbeatExpectedAt: string | null }
  | { kind: "conflict"; heartbeatExpectedAt: null } {
  const live = runs.flatMap((run) => {
    const status = text(run.status);
    if (!liveRunStatuses.has(status)) return [];
    const owner = nullableActorId(run.leaseOwnerId ?? run.actorId);
    if (!owner.valid || owner.value === null) return [{ owner: null, heartbeatExpectedAt: null }];
    const expiry = nullableTimestamp(run.leaseExpiresAt);
    if (!expiry.valid) return [{ owner: null, heartbeatExpectedAt: null }];
    if (expiry.value !== null && expiry.millis <= now) return [];
    return [{
      owner: owner.value,
      heartbeatExpectedAt: expiry.value,
    }];
  });

  if (live.some((run) => run.owner === null || run.owner !== holderActorId)) {
    return { kind: "conflict", heartbeatExpectedAt: null };
  }
  if (live.length > 1) return { kind: "conflict", heartbeatExpectedAt: null };
  if (live.length === 1) {
    return { kind: "matching", heartbeatExpectedAt: live[0]!.heartbeatExpectedAt };
  }
  return { kind: "none", heartbeatExpectedAt: null };
}

function latestClaimSource(
  events: ItemControlEventInput[],
  holderActorId: string,
  currentGeneration: number,
): ItemAuthoritySource {
  for (const event of events) {
    if (text(event.type) !== "claim.created") continue;
    const actor = nullableActorId(event.actorId);
    if (!actor.valid || actor.value !== holderActorId) return "claim";
    const payload = record(event.payload);
    const eventGeneration = generation(payload?.generation);
    if (eventGeneration !== null && eventGeneration !== currentGeneration) return "claim";
    return text(payload?.source) === "supervisor_dispatch" ? "dispatcher" : "claim";
  }
  return "claim";
}

function responsibilityActor(input: {
  status: string;
  state: ItemAuthorityState;
  holderActorId: string | null;
  generation: number;
  events: ItemControlEventInput[];
}): string | null {
  if (input.status === "active" && input.state !== "superseded") {
    return input.holderActorId;
  }
  if (input.status !== "ready") return null;
  for (const event of input.events) {
    if (text(event.type) !== "work.handed_off") continue;
    const payload = record(event.payload);
    if (generation(payload?.nextGeneration) !== input.generation) return null;
    const target = nullableActorId(payload?.toActorId);
    return target.valid ? target.value : null;
  }
  return null;
}

function unavailableReasons(
  status: string,
  state: ItemAuthorityState,
  allowed: ItemAuthorityOperation[],
): Partial<Record<ItemAuthorityOperation, string>> {
  const allowedSet = new Set(allowed);
  const output: Partial<Record<ItemAuthorityOperation, string>> = {};
  for (const operation of itemAuthorityOperations) {
    if (allowedSet.has(operation)) continue;
    output[operation] = unavailableReason(status, state, operation);
  }
  return output;
}

function unavailableReason(
  status: string,
  state: ItemAuthorityState,
  operation: ItemAuthorityOperation,
): string {
  if (state === "expired") {
    return "Authority expired; refresh to reconcile the current server generation.";
  }
  if (state === "superseded") {
    return status === "done" || status === "archived"
      ? `Item is ${status}; authority-changing operations are closed.`
      : "Authority is inconsistent or superseded; refresh before acting.";
  }
  if (status === "ready") {
    if (operation === "renew" || operation === "release") {
      return "No live claim exists for this item.";
    }
    if (operation === "unblock") return "Only blocked work can be unblocked.";
  }
  if (status === "blocked") {
    if (operation === "claim" || operation === "renew" || operation === "release") {
      return "Blocked work has no live claim authority.";
    }
    if (operation === "block") return "Item is already blocked.";
  }
  if (status === "active") {
    if (operation === "claim") return "Item already has live authority.";
    if (operation === "unblock") return "Only blocked work can be unblocked.";
  }
  return "Operation is unavailable for the current item state.";
}

function boundedWindow(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUTHORITY_EXPIRING_WINDOW_MS;
  if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60_000) {
    throw new RangeError("Expiring authority window must be between 0 and 86400000 milliseconds");
  }
  return value;
}

function timestamp(value: Date | string | number, label: string): number {
  const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return millis;
}

function generation(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function nullableActorId(value: unknown): { valid: boolean; value: string | null } {
  if (value === null || value === undefined) return { valid: true, value: null };
  if (typeof value !== "string") return { valid: false, value: null };
  const output = value.trim();
  if (
    !output
    || output.length > 120
    || credentialShape.test(output)
    || /[\u0000-\u001f\u007f]/.test(output)
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value: output };
}

function nullableTimestamp(value: unknown): {
  valid: boolean;
  value: string | null;
  millis: number;
} {
  if (value === null || value === undefined) {
    return { valid: true, value: null, millis: Number.NaN };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { valid: false, value: null, millis: Number.NaN };
  }
  const output = value.trim();
  const millis = Date.parse(output);
  if (!Number.isFinite(millis)) return { valid: false, value: null, millis: Number.NaN };
  return { valid: true, value: new Date(millis).toISOString(), millis };
}

function safeNullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const output = value.trim().slice(0, maxLength);
  if (!output) return null;
  return credentialShape.test(output) ? "[REDACTED]" : output;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
