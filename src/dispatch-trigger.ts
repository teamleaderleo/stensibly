import { compareCodeUnits, sha256, stableJson } from "./canonical-json.js";
import { elaturaLaneEventTypes, type ElaturaLaneEventType } from "./application-lane-binding.js";

export const DISPATCH_TRIGGER_V1 = 1 as const;
export const dispatchTriggerClasses = ["explicit_current", "wake_intent"] as const;
export type DispatchTriggerClass = typeof dispatchTriggerClasses[number];

export interface DispatchTriggerInputV1 {
  readonly triggerClass: DispatchTriggerClass;
  readonly project: string;
  readonly itemId: string;
  readonly expectedClaimGeneration: number;
  readonly sourceRef: string;
  readonly sourceFingerprint: string;
}

export interface DispatchTriggerV1 {
  readonly version: 1;
  readonly kind: "dispatch_trigger";
  readonly triggerClass: DispatchTriggerClass;
  readonly project: string;
  readonly itemId: string;
  readonly expectedClaimGeneration: number;
  readonly sourceRef: string;
  readonly sourceFingerprint: string;
  readonly grantsAuthority: false;
  readonly authorizesDispatch: false;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

interface ApplicationLaneWakeIntentForDispatchV1 {
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

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const MAX_ID = 240;
const MAX_PROJECT = 80;
const MAX_SOURCE_REFS = 32;
const MAX_SOURCE_REF = 2_048;

/**
 * Normalize one exact eligibility fact into the provider-neutral input consumed
 * by #47. The trigger is still evidence only: current source state, target
 * generation, capacity, runner policy, and authority must be re-read before any
 * claim or queued-run mutation.
 */
export function buildDispatchTriggerV1(value: unknown): DispatchTriggerV1 {
  const input = strictRecord(value, "Dispatch trigger input", [
    "triggerClass",
    "project",
    "itemId",
    "expectedClaimGeneration",
    "sourceRef",
    "sourceFingerprint",
  ]);
  const core = {
    version: 1 as const,
    kind: "dispatch_trigger" as const,
    triggerClass: exactEnum(input.triggerClass, dispatchTriggerClasses, "Dispatch trigger class"),
    project: project(input.project),
    itemId: identifier(input.itemId, "Dispatch trigger item ID"),
    expectedClaimGeneration: nonNegativeInteger(
      input.expectedClaimGeneration,
      "Dispatch trigger expected claim generation",
    ),
    sourceRef: identifier(input.sourceRef, "Dispatch trigger source reference"),
    sourceFingerprint: fingerprint(input.sourceFingerprint, "Dispatch trigger source fingerprint"),
    grantsAuthority: false as const,
    authorizesDispatch: false as const,
  };
  const triggerFingerprint = sha256(stableJson(core));
  return freeze({
    ...core,
    fingerprint: triggerFingerprint,
    idempotencyKey: `dispatch-trigger:${triggerFingerprint.slice("sha256:".length)}`,
  });
}

export function parseDispatchTriggerV1(value: unknown): DispatchTriggerV1 {
  const input = strictRecord(value, "Dispatch trigger", [
    "version",
    "kind",
    "triggerClass",
    "project",
    "itemId",
    "expectedClaimGeneration",
    "sourceRef",
    "sourceFingerprint",
    "grantsAuthority",
    "authorizesDispatch",
    "fingerprint",
    "idempotencyKey",
  ]);
  if (input.version !== DISPATCH_TRIGGER_V1) throw new TypeError("Dispatch trigger version must be 1");
  if (input.kind !== "dispatch_trigger") throw new TypeError("Dispatch trigger kind is invalid");
  if (input.grantsAuthority !== false) throw new TypeError("Dispatch trigger must grant zero authority");
  if (input.authorizesDispatch !== false) throw new TypeError("Dispatch trigger must authorize zero dispatch");

  const expected = buildDispatchTriggerV1({
    triggerClass: input.triggerClass,
    project: input.project,
    itemId: input.itemId,
    expectedClaimGeneration: input.expectedClaimGeneration,
    sourceRef: input.sourceRef,
    sourceFingerprint: input.sourceFingerprint,
  });
  if (input.fingerprint !== expected.fingerprint) throw new TypeError("Dispatch trigger fingerprint is invalid");
  if (input.idempotencyKey !== expected.idempotencyKey) throw new TypeError("Dispatch trigger idempotency key is invalid");
  return expected;
}

/**
 * Adapt #1736 same-item application wake eligibility into the generic #47
 * trigger contract. Application/lane details stay behind the opaque source
 * reference and exact source fingerprint; the dispatcher receives no browser
 * or Elatura-specific routing semantics.
 */
export function applicationLaneWakeToDispatchTriggerV1(value: unknown): DispatchTriggerV1 {
  const wake = parseApplicationLaneWakeIntentForDispatchV1(value);
  return buildDispatchTriggerV1({
    triggerClass: "wake_intent",
    project: wake.project,
    itemId: wake.itemId,
    expectedClaimGeneration: wake.claimGeneration,
    sourceRef: wake.idempotencyKey,
    sourceFingerprint: wake.fingerprint,
  });
}

function parseApplicationLaneWakeIntentForDispatchV1(
  value: unknown,
): ApplicationLaneWakeIntentForDispatchV1 {
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
  if (input.version !== 1) throw new TypeError("Application lane wake intent version must be 1");
  if (input.kind !== "application_lane_item_wakeup") {
    throw new TypeError("Application lane wake intent kind is invalid");
  }
  if (input.grantsAuthority !== false) {
    throw new TypeError("Application lane wake intent must grant zero authority");
  }
  if (input.authorizesDispatch !== false) {
    throw new TypeError("Application lane wake intent must authorize zero dispatch");
  }

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
    laneRef: identifier(input.laneRef, "Wake lane reference"),
    laneGeneration: positiveInteger(input.laneGeneration, "Wake lane generation"),
    sourceEventId: identifier(input.sourceEventId, "Wake source event ID"),
    eventType: exactEnum(input.eventType, elaturaLaneEventTypes, "Wake event type"),
    confidence: exactEnum(input.confidence, ["exact", "probable", "unknown"] as const, "Wake confidence"),
    freshness: exactEnum(input.freshness, ["fresh", "stale", "unknown"] as const, "Wake freshness"),
    observedAt: timestamp(input.observedAt, "Wake observation time"),
    sourceRefs: stringList(input.sourceRefs, "Wake source references", MAX_SOURCE_REFS, MAX_SOURCE_REF),
    grantsAuthority: false as const,
    authorizesDispatch: false as const,
  };
  const expectedFingerprint = sha256(stableJson(core));
  const expectedIdempotencyKey = `application-lane-wake:${expectedFingerprint.slice("sha256:".length)}`;
  if (input.fingerprint !== expectedFingerprint) {
    throw new TypeError("Application lane wake intent fingerprint is invalid");
  }
  if (input.idempotencyKey !== expectedIdempotencyKey) {
    throw new TypeError("Application lane wake intent idempotency key is invalid");
  }
  return freeze({
    ...core,
    fingerprint: expectedFingerprint,
    idempotencyKey: expectedIdempotencyKey,
  });
}

function strictRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new TypeError(`${label} must be an object`);
  let isArray: boolean;
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(`${label} inspection failed`);
  }
  if (isArray) throw new TypeError(`${label} must be an object`);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    throw new TypeError(`${label} contains symbol decoration`);
  }

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

function stringList(value: unknown, label: string, maxItems: number, maxLength: number): readonly string[] {
  let isArray: boolean;
  let descriptors: PropertyDescriptorMap;
  try {
    isArray = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(`${label} inspection failed`);
  }
  if (!isArray) throw new TypeError(`${label} must be an array`);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    throw new TypeError(`${label} length is invalid`);
  }
  const length = lengthDescriptor.value as number;
  if (length < 0 || length > maxItems) throw new RangeError(`${label} has invalid cardinality`);
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} must be dense data`);
    }
    output.push(identifier(descriptor.value, `${label} ${index + 1}`, maxLength));
  }
  if (new Set(output).size !== output.length) throw new RangeError(`${label} must not contain duplicates`);
  const sorted = [...output].sort(compareCodeUnits);
  if (sorted.some((entry, index) => entry !== output[index])) {
    throw new TypeError(`${label} must use canonical code-unit order`);
  }
  return Object.freeze(output);
}

function exactEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value as Values[number])) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Values[number];
}

function project(value: unknown): string {
  const text = boundedText(value, "Project", MAX_PROJECT);
  if (!PROJECT.test(text)) throw new TypeError("Project is invalid");
  return text;
}

function identifier(value: unknown, label: string, maximum = MAX_ID): string {
  const text = boundedText(value, label, maximum);
  if (!IDENTIFIER.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  if (!value || value.length > maximum || value.trim() !== value) throw new RangeError(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 80);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  const canonical = new Date(millis).toISOString();
  if (canonical !== text) throw new TypeError(`${label} must use canonical millisecond UTC`);
  return canonical;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
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
