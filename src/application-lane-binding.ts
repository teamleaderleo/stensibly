import { compareCodeUnits, sha256, stableJson } from "./canonical-json.js";

export const applicationLaneBindingCapabilities = [
  "events",
  "observe",
  "activate",
  "screenshot",
] as const;
export type ApplicationLaneBindingCapability = typeof applicationLaneBindingCapabilities[number];

export const elaturaLaneEventTypes = [
  "changed",
  "generating",
  "idle",
  "possible_completion",
  "error",
  "drifted",
  "discarded_or_unavailable",
  "recovery_needed",
  "available",
] as const;
export type ElaturaLaneEventType = typeof elaturaLaneEventTypes[number];

export interface ApplicationWorkBindingV1 {
  version: 1;
  id: string;
  generation: number;
  project: string;
  itemId: string;
  itemGeneration: number;
  provider: "elatura";
  laneRef: string;
  laneGeneration: number;
  capabilities: readonly ApplicationLaneBindingCapability[];
  createdAt: string;
  retiredAt: string | null;
  grantsWorkAuthority: false;
  grantsApplicationAuthority: false;
  fingerprint: string;
}

export interface ElaturaApplicationLaneEventV1 {
  version: 1;
  eventId: string;
  laneRef: string;
  laneGeneration: number;
  eventType: ElaturaLaneEventType;
  observedAt: string;
  confidence: "exact" | "probable" | "unknown";
  freshness: "fresh" | "stale" | "unknown";
  sourceRefs: readonly string[];
  grantsWorkAuthority: false;
  authorizesWorkDispatch: false;
}

export interface ApplicationLaneBoundObservationV1 {
  version: 1;
  kind: "provider_observation";
  project: string;
  provider: "elatura";
  eventId: string;
  sourceObjectRef: string;
  sourceObjectGeneration: number;
  eventType: `lane.${ElaturaLaneEventType}`;
  itemId: string;
  itemGeneration: number;
  observedAt: string;
  confidence: "exact" | "probable" | "unknown";
  freshness: "fresh" | "stale" | "unknown";
  sourceRefs: readonly string[];
  binding: Readonly<{ id: string; generation: number }>;
  grantsWorkAuthority: false;
  authorizesDispatch: false;
  fingerprint: string;
  idempotencyKey: string;
}

export type ApplicationLaneEventMatchReason =
  | "matched"
  | "lane_ref_mismatch"
  | "lane_generation_mismatch"
  | "event_before_binding"
  | "binding_retired";

export interface ApplicationLaneEventMatchDecisionV1 {
  version: 1;
  matched: boolean;
  reason: ApplicationLaneEventMatchReason;
  binding: Readonly<{ id: string; generation: number }>;
  sourceEventId: string;
  observation: ApplicationLaneBoundObservationV1 | null;
  decisionFingerprint: string;
}

const MAX_ID = 240;
const MAX_PROJECT = 80;
const MAX_SOURCE_REFS = 32;
const MAX_SOURCE_REF = 2_048;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialPattern = /(?:github_pat_|gh[pousr]_|sk-(?:proj-)?|Bearer\s+)[A-Za-z0-9._~+\/-]+/iu;

export function buildApplicationWorkBindingV1(value: unknown): ApplicationWorkBindingV1 {
  const input = strictRecord(value, "Application work binding", [
    "version",
    "id",
    "generation",
    "project",
    "itemId",
    "itemGeneration",
    "provider",
    "laneRef",
    "laneGeneration",
    "capabilities",
    "createdAt",
    "retiredAt",
  ]);
  if (input.version !== 1) throw new TypeError("Application work binding version must be 1");
  if (input.provider !== "elatura") throw new TypeError("Application work binding provider must be elatura");
  const createdAt = timestamp(input.createdAt, "Binding creation time");
  const retiredAt = input.retiredAt === null
    ? null
    : timestamp(input.retiredAt, "Binding retirement time");
  if (retiredAt !== null && Date.parse(retiredAt) <= Date.parse(createdAt)) {
    throw new RangeError("Binding retirement must follow creation time");
  }
  const core = {
    version: 1 as const,
    id: identifier(input.id, "Binding ID"),
    generation: positiveInteger(input.generation, "Binding generation"),
    project: project(input.project),
    itemId: identifier(input.itemId, "Item ID"),
    itemGeneration: positiveInteger(input.itemGeneration, "Item generation"),
    provider: "elatura" as const,
    laneRef: identifier(input.laneRef, "Elatura lane reference"),
    laneGeneration: positiveInteger(input.laneGeneration, "Elatura lane generation"),
    capabilities: capabilityList(input.capabilities),
    createdAt,
    retiredAt,
    grantsWorkAuthority: false as const,
    grantsApplicationAuthority: false as const,
  };
  return deepFreeze({
    ...core,
    fingerprint: sha256(stableJson(core)),
  });
}

export function parseElaturaApplicationLaneEventV1(value: unknown): ElaturaApplicationLaneEventV1 {
  const input = strictRecord(value, "Elatura application lane event", [
    "version",
    "eventId",
    "laneRef",
    "laneGeneration",
    "eventType",
    "observedAt",
    "confidence",
    "freshness",
    "sourceRefs",
    "grantsWorkAuthority",
    "authorizesWorkDispatch",
  ]);
  if (input.version !== 1) throw new TypeError("Elatura application lane event version must be 1");
  if (input.grantsWorkAuthority !== false) {
    throw new TypeError("Elatura application lane event must grant zero work authority");
  }
  if (input.authorizesWorkDispatch !== false) {
    throw new TypeError("Elatura application lane event must authorize zero work dispatch");
  }
  return deepFreeze({
    version: 1,
    eventId: identifier(input.eventId, "Lane event ID"),
    laneRef: identifier(input.laneRef, "Elatura lane reference"),
    laneGeneration: positiveInteger(input.laneGeneration, "Elatura lane generation"),
    eventType: exactEnum(input.eventType, elaturaLaneEventTypes, "Elatura lane event type"),
    observedAt: timestamp(input.observedAt, "Lane event observation time"),
    confidence: exactEnum(input.confidence, ["exact", "probable", "unknown"] as const, "Lane event confidence"),
    freshness: exactEnum(input.freshness, ["fresh", "stale", "unknown"] as const, "Lane event freshness"),
    sourceRefs: sourceReferenceList(input.sourceRefs),
    grantsWorkAuthority: false,
    authorizesWorkDispatch: false,
  });
}

/**
 * Admits one Elatura event against one exact work/lane binding and projects it
 * into a provider observation for Stensibly's existing wake/materiality owners.
 * This function performs no work mutation, materiality classification,
 * continuation creation, dispatch, application command, or authority grant.
 */
export function matchApplicationLaneEventV1(
  rawBinding: unknown,
  rawEvent: unknown,
): ApplicationLaneEventMatchDecisionV1 {
  const binding = buildApplicationWorkBindingV1(rawBinding);
  const event = parseElaturaApplicationLaneEventV1(rawEvent);
  let reason: ApplicationLaneEventMatchReason = "matched";
  if (event.laneRef !== binding.laneRef) {
    reason = "lane_ref_mismatch";
  } else if (event.laneGeneration !== binding.laneGeneration) {
    reason = "lane_generation_mismatch";
  } else if (Date.parse(event.observedAt) < Date.parse(binding.createdAt)) {
    reason = "event_before_binding";
  } else if (binding.retiredAt !== null && Date.parse(event.observedAt) >= Date.parse(binding.retiredAt)) {
    reason = "binding_retired";
  }

  const observation = reason === "matched"
    ? buildBoundObservation(binding, event)
    : null;
  const decisionCore = {
    version: 1 as const,
    matched: reason === "matched",
    reason,
    binding: { id: binding.id, generation: binding.generation },
    sourceEventId: event.eventId,
    observationFingerprint: observation?.fingerprint ?? null,
  };
  return deepFreeze({
    version: 1,
    matched: reason === "matched",
    reason,
    binding: decisionCore.binding,
    sourceEventId: event.eventId,
    observation,
    decisionFingerprint: sha256(stableJson(decisionCore)),
  });
}

function buildBoundObservation(
  binding: ApplicationWorkBindingV1,
  event: ElaturaApplicationLaneEventV1,
): ApplicationLaneBoundObservationV1 {
  const core = {
    version: 1 as const,
    kind: "provider_observation" as const,
    project: binding.project,
    provider: "elatura" as const,
    eventId: event.eventId,
    sourceObjectRef: binding.laneRef,
    sourceObjectGeneration: binding.laneGeneration,
    eventType: `lane.${event.eventType}` as const,
    itemId: binding.itemId,
    itemGeneration: binding.itemGeneration,
    observedAt: event.observedAt,
    confidence: event.confidence,
    freshness: event.freshness,
    sourceRefs: event.sourceRefs,
    binding: { id: binding.id, generation: binding.generation },
    grantsWorkAuthority: false as const,
    authorizesDispatch: false as const,
  };
  const fingerprint = sha256(stableJson(core));
  return deepFreeze({
    ...core,
    fingerprint,
    idempotencyKey: `application-lane-observation:${fingerprint.slice("sha256:".length)}`,
  });
}

function capabilityList(value: unknown): readonly ApplicationLaneBindingCapability[] {
  if (!Array.isArray(value)) throw new TypeError("Application lane capabilities must be an array");
  if (value.length < 1 || value.length > applicationLaneBindingCapabilities.length) {
    throw new RangeError(
      `Application lane capabilities must contain between 1 and ${applicationLaneBindingCapabilities.length} entries`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: ApplicationLaneBindingCapability[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Application lane capabilities must be dense data");
    }
    output.push(exactEnum(
      descriptor.value,
      applicationLaneBindingCapabilities,
      `Application lane capability ${index + 1}`,
    ));
  }
  if (new Set(output).size !== output.length) {
    throw new RangeError("Application lane capabilities must not contain duplicates");
  }
  output.sort(compareCodeUnits);
  return Object.freeze(output);
}

function sourceReferenceList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("Lane event source references must be an array");
  if (value.length > MAX_SOURCE_REFS) {
    throw new RangeError(`Lane event source references exceed ${MAX_SOURCE_REFS} entries`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Lane event source references must be dense data");
    }
    output.push(identifier(
      descriptor.value,
      `Lane event source reference ${index + 1}`,
      MAX_SOURCE_REF,
    ));
  }
  if (new Set(output).size !== output.length) {
    throw new RangeError("Lane event source references must not contain duplicates");
  }
  output.sort(compareCodeUnits);
  return Object.freeze(output);
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
  for (const key of allowedKeys) {
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

function identifier(value: unknown, label: string, maximum = MAX_ID): string {
  const text = boundedText(value, label, maximum);
  if (!IDENTIFIER.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const text = value.trim();
  if (!text) throw new TypeError(`${label} is required`);
  if (text.length > maximum) throw new RangeError(`${label} exceeds ${maximum} characters`);
  if (unsafeTextPattern.test(text)) throw new TypeError(`${label} contains unsafe text`);
  if (credentialPattern.test(text)) throw new TypeError(`${label} must not contain credential-shaped text`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 80);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
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
