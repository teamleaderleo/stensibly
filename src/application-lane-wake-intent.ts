import { compareCodeUnits, sha256, stableJson } from "./canonical-json.js";
import {
  buildApplicationWorkBindingV1,
  elaturaLaneEventTypes,
  matchApplicationLaneEventV1,
  parseElaturaApplicationLaneEventV1,
  type ElaturaLaneEventType,
} from "./application-lane-binding.js";

export const APPLICATION_LANE_WAKE_REGISTRATION_V1 = 1 as const;
export const APPLICATION_LANE_WAKE_INTENT_V1 = 1 as const;

export interface ApplicationLaneWakeRegistrationV1 {
  readonly version: 1;
  readonly id: string;
  readonly generation: number;
  readonly project: string;
  readonly itemId: string;
  readonly claimGeneration: number;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly laneRef: string;
  readonly laneGeneration: number;
  readonly eventTypes: readonly ElaturaLaneEventType[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface ApplicationLaneWakeCurrentAuthorityV1 {
  readonly project: string;
  readonly itemId: string;
  readonly claimGeneration: number;
}

export interface ApplicationLaneWakeIntentV1 {
  readonly version: 1;
  readonly kind: "application_lane_item_wakeup";
  readonly project: string;
  readonly registrationId: string;
  readonly registrationGeneration: number;
  readonly itemId: string;
  readonly claimGeneration: number;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly laneRef: string;
  readonly laneGeneration: number;
  readonly sourceEventId: string;
  readonly eventType: ElaturaLaneEventType;
  readonly confidence: "exact" | "probable" | "unknown";
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly observedAt: string;
  readonly sourceRefs: readonly string[];
  readonly grantsAuthority: false;
  readonly authorizesDispatch: false;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

export const applicationLaneWakeDecisionReasons = [
  "matched",
  "binding_retired",
  "events_capability_missing",
  "project_mismatch",
  "item_mismatch",
  "claim_generation_mismatch",
  "binding_id_mismatch",
  "binding_generation_mismatch",
  "lane_ref_mismatch",
  "lane_generation_mismatch",
  "event_lane_ref_mismatch",
  "event_lane_generation_mismatch",
  "event_before_binding",
  "event_type_mismatch",
  "registration_not_started",
  "registration_expired",
] as const;
export type ApplicationLaneWakeDecisionReason =
  typeof applicationLaneWakeDecisionReasons[number];

export interface ApplicationLaneWakeDecisionV1 {
  readonly version: 1;
  readonly matched: boolean;
  readonly reason: ApplicationLaneWakeDecisionReason;
  readonly registration: Readonly<{ id: string; generation: number }>;
  readonly itemId: string;
  readonly claimGeneration: number;
  readonly sourceEventId: string;
  readonly wakeIntent: ApplicationLaneWakeIntentV1 | null;
  readonly decisionFingerprint: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/u;
const MAX_ID = 240;
const MAX_PROJECT = 80;

export function parseApplicationLaneWakeRegistrationV1(
  value: unknown,
): ApplicationLaneWakeRegistrationV1 {
  const input = strictRecord(value, "Application lane wake registration", [
    "version",
    "id",
    "generation",
    "project",
    "itemId",
    "claimGeneration",
    "bindingId",
    "bindingGeneration",
    "laneRef",
    "laneGeneration",
    "eventTypes",
    "createdAt",
    "expiresAt",
  ]);
  if (input.version !== APPLICATION_LANE_WAKE_REGISTRATION_V1) {
    throw new TypeError("Application lane wake registration version must be 1");
  }
  const createdAt = timestamp(input.createdAt, "Wake registration creation time");
  const expiresAt = input.expiresAt === null
    ? null
    : timestamp(input.expiresAt, "Wake registration expiry time");
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new RangeError("Wake registration expiry must follow creation time");
  }
  return freeze({
    version: 1 as const,
    id: identifier(input.id, "Wake registration ID"),
    generation: positiveInteger(input.generation, "Wake registration generation"),
    project: project(input.project),
    itemId: identifier(input.itemId, "Wake registration item ID"),
    claimGeneration: nonNegativeInteger(input.claimGeneration, "Wake registration claim generation"),
    bindingId: identifier(input.bindingId, "Wake registration binding ID"),
    bindingGeneration: positiveInteger(input.bindingGeneration, "Wake registration binding generation"),
    laneRef: identifier(input.laneRef, "Wake registration lane reference"),
    laneGeneration: positiveInteger(input.laneGeneration, "Wake registration lane generation"),
    eventTypes: eventTypeList(input.eventTypes),
    createdAt,
    expiresAt,
  });
}

export function parseApplicationLaneWakeCurrentAuthorityV1(
  value: unknown,
): ApplicationLaneWakeCurrentAuthorityV1 {
  const input = strictRecord(value, "Application lane wake current authority", [
    "project", "itemId", "claimGeneration",
  ]);
  return freeze({
    project: project(input.project),
    itemId: identifier(input.itemId, "Current authority item ID"),
    claimGeneration: nonNegativeInteger(input.claimGeneration, "Current authority claim generation"),
  });
}

export function parseApplicationLaneWakeIntentV1(value: unknown): ApplicationLaneWakeIntentV1 {
  const input = strictRecord(value, "Application lane wake intent", [
    "version",
    "kind",
    "project",
    "registrationId",
    "registrationGeneration",
    "itemId",
    "claimGeneration",
    "bindingId",
    "bindingGeneration",
    "laneRef",
    "laneGeneration",
    "sourceEventId",
    "eventType",
    "confidence",
    "freshness",
    "observedAt",
    "sourceRefs",
    "grantsAuthority",
    "authorizesDispatch",
    "fingerprint",
    "idempotencyKey",
  ]);
  if (input.version !== APPLICATION_LANE_WAKE_INTENT_V1) {
    throw new TypeError("Application lane wake intent version must be 1");
  }
  if (input.kind !== "application_lane_item_wakeup") {
    throw new TypeError("Application lane wake intent kind is invalid");
  }
  if (input.grantsAuthority !== false) {
    throw new TypeError("Application lane wake intent must grant zero authority");
  }
  if (input.authorizesDispatch !== false) {
    throw new TypeError("Application lane wake intent must authorize zero dispatch");
  }

  const event = parseElaturaApplicationLaneEventV1({
    version: 1,
    eventId: input.sourceEventId,
    laneRef: input.laneRef,
    laneGeneration: input.laneGeneration,
    eventType: input.eventType,
    observedAt: input.observedAt,
    confidence: input.confidence,
    freshness: input.freshness,
    sourceRefs: input.sourceRefs,
    grantsWorkAuthority: false,
    authorizesWorkDispatch: false,
  });
  const core = {
    version: 1 as const,
    kind: "application_lane_item_wakeup" as const,
    project: project(input.project),
    registrationId: identifier(input.registrationId, "Wake registration ID"),
    registrationGeneration: positiveInteger(input.registrationGeneration, "Wake registration generation"),
    itemId: identifier(input.itemId, "Wake item ID"),
    claimGeneration: nonNegativeInteger(input.claimGeneration, "Wake claim generation"),
    bindingId: identifier(input.bindingId, "Wake binding ID"),
    bindingGeneration: positiveInteger(input.bindingGeneration, "Wake binding generation"),
    laneRef: event.laneRef,
    laneGeneration: event.laneGeneration,
    sourceEventId: event.eventId,
    eventType: event.eventType,
    confidence: event.confidence,
    freshness: event.freshness,
    observedAt: event.observedAt,
    sourceRefs: event.sourceRefs,
    grantsAuthority: false as const,
    authorizesDispatch: false as const,
  };
  const fingerprint = sha256(stableJson(core));
  const idempotencyKey = `application-lane-wake:${fingerprint.slice("sha256:".length)}`;
  if (input.fingerprint !== fingerprint) {
    throw new TypeError("Application lane wake intent fingerprint is invalid");
  }
  if (input.idempotencyKey !== idempotencyKey) {
    throw new TypeError("Application lane wake intent idempotency key is invalid");
  }
  return freeze({ ...core, fingerprint, idempotencyKey });
}

/**
 * Compile one exact same-item application-lane wake decision.
 *
 * The caller supplies the current durable binding and the current claim
 * generation read from Stensibly's existing item-control/dispatch owner. This
 * function performs zero persistence, responsibility acceptance, claim, run
 * creation, application action, or authority grant.
 */
export function compileApplicationLaneWakeIntentV1(
  registrationValue: unknown,
  currentBindingValue: unknown,
  currentAuthorityValue: unknown,
  eventValue: unknown,
): ApplicationLaneWakeDecisionV1 {
  const registration = parseApplicationLaneWakeRegistrationV1(registrationValue);
  const binding = buildApplicationWorkBindingV1(currentBindingValue);
  const authority = parseApplicationLaneWakeCurrentAuthorityV1(currentAuthorityValue);
  const event = parseElaturaApplicationLaneEventV1(eventValue);

  let reason: ApplicationLaneWakeDecisionReason = "matched";
  if (binding.retiredAt !== null) reason = "binding_retired";
  else if (!binding.capabilities.includes("events")) reason = "events_capability_missing";
  else if (registration.project !== binding.project || registration.project !== authority.project) {
    reason = "project_mismatch";
  } else if (registration.itemId !== binding.itemId || registration.itemId !== authority.itemId) {
    reason = "item_mismatch";
  } else if (registration.claimGeneration !== authority.claimGeneration) {
    reason = "claim_generation_mismatch";
  } else if (registration.bindingId !== binding.id) reason = "binding_id_mismatch";
  else if (registration.bindingGeneration !== binding.generation) reason = "binding_generation_mismatch";
  else if (registration.laneRef !== binding.laneRef) reason = "lane_ref_mismatch";
  else if (registration.laneGeneration !== binding.laneGeneration) reason = "lane_generation_mismatch";
  else {
    // Reuse #1730's raw-input admission path. The canonical binding above adds
    // derived fields (fingerprint and zero-authority flags) that intentionally
    // do not belong to the strict ApplicationWorkBindingV1 creation input.
    const admitted = matchApplicationLaneEventV1(currentBindingValue, eventValue);
    if (!admitted.matched) {
      reason = admitted.reason === "lane_ref_mismatch"
        ? "event_lane_ref_mismatch"
        : admitted.reason === "lane_generation_mismatch"
          ? "event_lane_generation_mismatch"
          : "event_before_binding";
    } else if (!registration.eventTypes.includes(event.eventType)) {
      reason = "event_type_mismatch";
    } else if (Date.parse(event.observedAt) < Date.parse(registration.createdAt)) {
      reason = "registration_not_started";
    } else if (
      registration.expiresAt !== null
      && Date.parse(event.observedAt) >= Date.parse(registration.expiresAt)
    ) {
      reason = "registration_expired";
    }
  }

  const wakeIntent = reason === "matched"
    ? buildWakeIntent(registration, event)
    : null;
  const core = {
    version: 1 as const,
    matched: reason === "matched",
    reason,
    registration: { id: registration.id, generation: registration.generation },
    itemId: registration.itemId,
    claimGeneration: registration.claimGeneration,
    sourceEventId: event.eventId,
    wakeIntent,
  };
  return freeze({
    ...core,
    decisionFingerprint: sha256(stableJson(core)),
  });
}

function buildWakeIntent(
  registration: ApplicationLaneWakeRegistrationV1,
  event: ReturnType<typeof parseElaturaApplicationLaneEventV1>,
): ApplicationLaneWakeIntentV1 {
  const core = {
    version: 1 as const,
    kind: "application_lane_item_wakeup" as const,
    project: registration.project,
    registrationId: registration.id,
    registrationGeneration: registration.generation,
    itemId: registration.itemId,
    claimGeneration: registration.claimGeneration,
    bindingId: registration.bindingId,
    bindingGeneration: registration.bindingGeneration,
    laneRef: registration.laneRef,
    laneGeneration: registration.laneGeneration,
    sourceEventId: event.eventId,
    eventType: event.eventType,
    confidence: event.confidence,
    freshness: event.freshness,
    observedAt: event.observedAt,
    sourceRefs: event.sourceRefs,
    grantsAuthority: false as const,
    authorizesDispatch: false as const,
  };
  const fingerprint = sha256(stableJson(core));
  return freeze({
    ...core,
    fingerprint,
    idempotencyKey: `application-lane-wake:${fingerprint.slice("sha256:".length)}`,
  });
}

function eventTypeList(value: unknown): readonly ElaturaLaneEventType[] {
  if (!Array.isArray(value)) throw new TypeError("Wake registration event types must be an array");
  if (value.length < 1 || value.length > elaturaLaneEventTypes.length) {
    throw new RangeError("Wake registration event types have invalid cardinality");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: ElaturaLaneEventType[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Wake registration event types must be dense data");
    }
    const eventType = descriptor.value;
    if (typeof eventType !== "string" || !elaturaLaneEventTypes.includes(eventType as ElaturaLaneEventType)) {
      throw new TypeError(`Wake registration event type ${index + 1} is invalid`);
    }
    output.push(eventType as ElaturaLaneEventType);
  }
  if (new Set(output).size !== output.length) {
    throw new RangeError("Wake registration event types must not contain duplicates");
  }
  output.sort(compareCodeUnits);
  return Object.freeze(output);
}

function strictRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} contains symbol decoration`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain enumerable data properties`);
    }
    if (!keys.includes(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
    output[key] = descriptor.value;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) {
      throw new TypeError(`${label} is missing required field ${key}`);
    }
  }
  return output;
}

function project(value: unknown): string {
  const text = boundedText(value, "Project", MAX_PROJECT);
  if (!PROJECT.test(text)) throw new TypeError("Project is invalid");
  return text;
}

function identifier(value: unknown, label: string): string {
  const text = boundedText(value, label, MAX_ID);
  if (!IDENTIFIER.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new RangeError(`${label} is invalid`);
  return text;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 80);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen);
  return Object.freeze(value);
}
