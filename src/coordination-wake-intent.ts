import { compareCodeUnits, sha256, stableJson } from "./canonical-json.js";

export const COORDINATION_EVENT_SUBSCRIPTION_V1 = 1 as const;
export const COORDINATION_WAKE_INTENT_V1 = 1 as const;

export const coordinationRoutingLevels = [
  "record",
  "attention",
  "interrupt",
] as const;
export type CoordinationRoutingLevel = typeof coordinationRoutingLevels[number];

export const coordinationWakeDecisionReasons = [
  "matched",
  "project_mismatch",
  "source_item_mismatch",
  "correlation_mismatch",
  "event_type_mismatch",
  "subscription_not_started",
  "subscription_expired",
  "below_routing_threshold",
] as const;
export type CoordinationWakeDecisionReason = typeof coordinationWakeDecisionReasons[number];

export interface CoordinationEventSubscriptionV1 {
  readonly version: typeof COORDINATION_EVENT_SUBSCRIPTION_V1;
  readonly id: string;
  readonly generation: number;
  readonly project: string;
  readonly sourceItemId: string;
  readonly sourceCorrelationId: string;
  readonly eventTypes: readonly string[];
  readonly targetItemId: string;
  readonly targetGeneration: number;
  readonly minimumRoutingLevel: CoordinationRoutingLevel;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface CoordinationEventObservationV1 {
  readonly eventId: string;
  readonly project: string;
  readonly sourceItemId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly routingLevel: CoordinationRoutingLevel;
  readonly sourceRunId: string | null;
  readonly observedAt: string;
  readonly sourceRefs: readonly string[];
}

export interface CoordinationWakeIntentV1 {
  readonly version: typeof COORDINATION_WAKE_INTENT_V1;
  readonly kind: "target_item_wakeup";
  readonly project: string;
  readonly subscriptionId: string;
  readonly subscriptionGeneration: number;
  readonly sourceEventId: string;
  readonly sourceItemId: string;
  readonly sourceCorrelationId: string;
  readonly sourceRunId: string | null;
  readonly targetItemId: string;
  readonly targetGeneration: number;
  readonly routingLevel: CoordinationRoutingLevel;
  readonly observedAt: string;
  readonly sourceRefs: readonly string[];
  readonly grantsAuthority: false;
  readonly authorizesDispatch: false;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

export interface CoordinationWakeDecisionV1 {
  readonly version: typeof COORDINATION_WAKE_INTENT_V1;
  readonly matched: boolean;
  readonly reason: CoordinationWakeDecisionReason;
  readonly subscription: {
    readonly id: string;
    readonly generation: number;
  };
  readonly sourceEventId: string;
  readonly targetItemId: string;
  readonly targetGeneration: number;
  readonly wakeIntent: CoordinationWakeIntentV1 | null;
  readonly decisionFingerprint: string;
}

const MAX_IDENTIFIER = 240;
const MAX_PROJECT = 120;
const MAX_EVENT_TYPES = 32;
const MAX_EVENT_TYPE = 160;
const MAX_SOURCE_REFS = 32;
const MAX_SOURCE_REF = 1_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/u;
const eventTypePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialPattern = /(?:stn\.tok_|github_pat_|gh[pousr]_|sk-(?:proj-)?|Bearer\s+)[A-Za-z0-9._~+\/-]+/iu;

const routingRank: Readonly<Record<CoordinationRoutingLevel, number>> = Object.freeze({
  record: 0,
  attention: 1,
  interrupt: 2,
});

export function parseCoordinationEventSubscriptionV1(
  value: unknown,
): CoordinationEventSubscriptionV1 {
  const input = strictRecord(value, "Coordination event subscription", [
    "version",
    "id",
    "generation",
    "project",
    "sourceItemId",
    "sourceCorrelationId",
    "eventTypes",
    "targetItemId",
    "targetGeneration",
    "minimumRoutingLevel",
    "createdAt",
    "expiresAt",
  ]);
  if (input.version !== COORDINATION_EVENT_SUBSCRIPTION_V1) {
    throw new TypeError(
      `Coordination event subscription version must be ${COORDINATION_EVENT_SUBSCRIPTION_V1}`,
    );
  }
  const sourceItemId = identifier(input.sourceItemId, "Source item ID");
  const targetItemId = identifier(input.targetItemId, "Target item ID");
  if (sourceItemId === targetItemId) {
    throw new RangeError(
      "Cross-item coordination subscriptions require different source and target items",
    );
  }
  const createdAt = timestamp(input.createdAt, "Subscription creation time");
  const expiresAt = input.expiresAt === null
    ? null
    : timestamp(input.expiresAt, "Subscription expiry time");
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new RangeError("Subscription expiry must be later than creation time");
  }
  return deepFreeze({
    version: COORDINATION_EVENT_SUBSCRIPTION_V1,
    id: identifier(input.id, "Subscription ID"),
    generation: positiveInteger(input.generation, "Subscription generation"),
    project: patternText(input.project, "Subscription project", projectPattern, MAX_PROJECT),
    sourceItemId,
    sourceCorrelationId: identifier(input.sourceCorrelationId, "Source correlation ID"),
    eventTypes: uniqueSortedTexts(
      input.eventTypes,
      "Subscription event type",
      MAX_EVENT_TYPES,
      MAX_EVENT_TYPE,
      eventTypePattern,
    ),
    targetItemId,
    targetGeneration: nonNegativeInteger(input.targetGeneration, "Target generation"),
    minimumRoutingLevel: exactEnum(
      input.minimumRoutingLevel,
      coordinationRoutingLevels,
      "Minimum routing level",
    ),
    createdAt,
    expiresAt,
  });
}

export function parseCoordinationEventObservationV1(
  value: unknown,
): CoordinationEventObservationV1 {
  const input = strictRecord(value, "Coordination event observation", [
    "eventId",
    "project",
    "sourceItemId",
    "correlationId",
    "eventType",
    "routingLevel",
    "sourceRunId",
    "observedAt",
    "sourceRefs",
  ]);
  return deepFreeze({
    eventId: identifier(input.eventId, "Event ID"),
    project: patternText(input.project, "Event project", projectPattern, MAX_PROJECT),
    sourceItemId: identifier(input.sourceItemId, "Event source item ID"),
    correlationId: identifier(input.correlationId, "Event correlation ID"),
    eventType: patternText(input.eventType, "Event type", eventTypePattern, MAX_EVENT_TYPE),
    routingLevel: exactEnum(
      input.routingLevel,
      coordinationRoutingLevels,
      "Event routing level",
    ),
    sourceRunId: input.sourceRunId === null
      ? null
      : identifier(input.sourceRunId, "Event source run ID"),
    observedAt: timestamp(input.observedAt, "Event observation time"),
    sourceRefs: uniqueSortedTexts(
      input.sourceRefs,
      "Event source reference",
      MAX_SOURCE_REFS,
      MAX_SOURCE_REF,
    ),
  });
}

/**
 * Compile one descriptive cross-item wake decision.
 *
 * The caller supplies an already-classified routing level. This compiler does
 * not decide materiality, create a continuation, dispatch a runner, or grant
 * authority. A later authoritative boundary must re-read the current
 * subscription and target work generation and require exact equality with
 * targetGeneration before applying any mutation.
 */
export function compileCoordinationWakeIntentV1(
  subscriptionValue: unknown,
  eventValue: unknown,
): CoordinationWakeDecisionV1 {
  const subscription = parseCoordinationEventSubscriptionV1(subscriptionValue);
  const event = parseCoordinationEventObservationV1(eventValue);
  const reason = matchReason(subscription, event);
  const wakeIntent = reason === "matched"
    ? buildWakeIntent(subscription, event)
    : null;
  const withoutFingerprint = {
    version: COORDINATION_WAKE_INTENT_V1,
    matched: reason === "matched",
    reason,
    subscription: Object.freeze({
      id: subscription.id,
      generation: subscription.generation,
    }),
    sourceEventId: event.eventId,
    targetItemId: subscription.targetItemId,
    targetGeneration: subscription.targetGeneration,
    wakeIntent,
  };
  return deepFreeze({
    ...withoutFingerprint,
    decisionFingerprint: sha256(stableJson(withoutFingerprint)),
  });
}

function matchReason(
  subscription: CoordinationEventSubscriptionV1,
  event: CoordinationEventObservationV1,
): CoordinationWakeDecisionReason {
  if (subscription.project !== event.project) return "project_mismatch";
  if (subscription.sourceItemId !== event.sourceItemId) return "source_item_mismatch";
  if (subscription.sourceCorrelationId !== event.correlationId) return "correlation_mismatch";
  if (!subscription.eventTypes.includes(event.eventType)) return "event_type_mismatch";
  const eventMs = Date.parse(event.observedAt);
  if (eventMs < Date.parse(subscription.createdAt)) return "subscription_not_started";
  if (
    subscription.expiresAt !== null
    && eventMs >= Date.parse(subscription.expiresAt)
  ) {
    return "subscription_expired";
  }
  if (routingRank[event.routingLevel] < routingRank[subscription.minimumRoutingLevel]) {
    return "below_routing_threshold";
  }
  return "matched";
}

function buildWakeIntent(
  subscription: CoordinationEventSubscriptionV1,
  event: CoordinationEventObservationV1,
): CoordinationWakeIntentV1 {
  const withoutFingerprint = {
    version: COORDINATION_WAKE_INTENT_V1,
    kind: "target_item_wakeup" as const,
    project: subscription.project,
    subscriptionId: subscription.id,
    subscriptionGeneration: subscription.generation,
    sourceEventId: event.eventId,
    sourceItemId: event.sourceItemId,
    sourceCorrelationId: event.correlationId,
    sourceRunId: event.sourceRunId,
    targetItemId: subscription.targetItemId,
    targetGeneration: subscription.targetGeneration,
    routingLevel: event.routingLevel,
    observedAt: event.observedAt,
    sourceRefs: event.sourceRefs,
    grantsAuthority: false as const,
    authorizesDispatch: false as const,
  };
  const fingerprint = sha256(stableJson(withoutFingerprint));
  return deepFreeze({
    ...withoutFingerprint,
    fingerprint,
    idempotencyKey: `coordination-wake:${fingerprint.slice("sha256:".length)}`,
  });
}

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
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
    if (!allowedKeys.includes(key)) {
      throw new TypeError(`${label} contains unsupported field ${key}`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function uniqueSortedTexts(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
  pattern?: RegExp,
): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} list must be an array`);
  if (value.length < 1 || value.length > maximumEntries) {
    throw new RangeError(
      `${label} list must contain between 1 and ${maximumEntries} entries`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} list must be dense data`);
    }
    const item = pattern
      ? patternText(descriptor.value, `${label} ${index + 1}`, pattern, maximumLength)
      : boundedText(descriptor.value, `${label} ${index + 1}`, maximumLength);
    output.push(item);
  }
  if (new Set(output).size !== output.length) {
    throw new RangeError(`${label} list must not contain duplicates`);
  }
  output.sort(compareCodeUnits);
  return Object.freeze(output);
}

function identifier(value: unknown, label: string): string {
  return patternText(value, label, identifierPattern, MAX_IDENTIFIER);
}

function patternText(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximumLength: number,
): string {
  const text = boundedText(value, label, maximumLength);
  if (!pattern.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const text = value.trim();
  if (!text) throw new TypeError(`${label} is required`);
  if (text.length > maximumLength) {
    throw new RangeError(`${label} exceeds ${maximumLength} characters`);
  }
  if (unsafeTextPattern.test(text)) throw new TypeError(`${label} contains unsafe text`);
  if (credentialPattern.test(text)) {
    throw new TypeError(`${label} must not contain credential-shaped text`);
  }
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

function exactEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Values[number];
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
