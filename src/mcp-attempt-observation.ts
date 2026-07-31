import { createHash } from "node:crypto";
import type { McpFailureStage } from "./mcp-diagnostics.js";

export const mcpAttemptSessionClassifications = [
  "streamable_http_stateless",
  "streamable_http_stateful",
  "unknown",
] as const;
export type McpAttemptSessionClassification =
  typeof mcpAttemptSessionClassifications[number];

export const mcpAttemptTransitionKinds = [
  "request_accepted",
  "authentication_completed",
  "authorization_completed",
  "server_constructed",
  "transport_connected",
  "execution_started",
  "execution_settled",
  "response_serialized",
  "boundary_returned",
  "client_acknowledged",
  "reconciled",
  "failed",
] as const;
export type McpAttemptTransitionKind =
  typeof mcpAttemptTransitionKinds[number];

export const mcpAttemptSettlementKnowledge = [
  "unsettled",
  "settled",
  "ambiguous",
  "reconciled",
] as const;
export type McpAttemptSettlementKnowledge =
  typeof mcpAttemptSettlementKnowledge[number];

export const mcpAttemptDeliveryKnowledge = [
  "unknown",
  "boundary_returned",
  "client_acknowledged",
] as const;
export type McpAttemptDeliveryKnowledge =
  typeof mcpAttemptDeliveryKnowledge[number];

export interface McpAttemptObservationInput {
  readonly attemptId: string;
  readonly requestId: string;
  readonly operationIdentityDigest?: string;
  readonly sessionClassification: McpAttemptSessionClassification;
  readonly manifestFingerprint: string;
  readonly transition: McpAttemptTransitionKind;
  readonly occurredAt: string;
  readonly failureStage?: McpFailureStage;
  readonly settlement: McpAttemptSettlementKnowledge;
  readonly delivery: McpAttemptDeliveryKnowledge;
}

export interface McpAttemptObservationV1 {
  readonly version: 1;
  readonly observationId: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly operationIdentityDigest?: string;
  readonly sessionClassification: McpAttemptSessionClassification;
  readonly manifestFingerprint: string;
  readonly transition: McpAttemptTransitionKind;
  readonly occurredAt: string;
  readonly failureStage?: McpFailureStage;
  readonly settlement: McpAttemptSettlementKnowledge;
  readonly delivery: McpAttemptDeliveryKnowledge;
  readonly containsPrivateContent: false;
}

export interface McpAttemptProjectionV1 {
  readonly version: 1;
  readonly projectionFingerprint: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly operationIdentityDigest?: string;
  readonly sessionClassification: McpAttemptSessionClassification;
  readonly manifestFingerprint: string;
  readonly eventCount: number;
  readonly acceptedAt: string;
  readonly lastObservedAt: string;
  readonly latestTransition: McpAttemptTransitionKind;
  readonly settlement: McpAttemptSettlementKnowledge;
  readonly delivery: McpAttemptDeliveryKnowledge;
  readonly executionStartedAt: string | null;
  readonly settledAt: string | null;
  readonly responseSerializedAt: string | null;
  readonly boundaryReturnedAt: string | null;
  readonly clientAcknowledgedAt: string | null;
  readonly reconciledAt: string | null;
  readonly lastFailureStage: McpFailureStage | null;
  readonly observationIds: readonly string[];
  readonly containsPrivateContent: false;
}

const inputKeys = [
  "attemptId",
  "requestId",
  "operationIdentityDigest",
  "sessionClassification",
  "manifestFingerprint",
  "transition",
  "occurredAt",
  "failureStage",
  "settlement",
  "delivery",
] as const;
const requiredInputKeys = [
  "attemptId",
  "requestId",
  "sessionClassification",
  "manifestFingerprint",
  "transition",
  "occurredAt",
  "settlement",
  "delivery",
] as const;
const observationKeys = [
  "version",
  "observationId",
  ...inputKeys,
  "containsPrivateContent",
] as const;
const requiredObservationKeys = [
  "version",
  "observationId",
  ...requiredInputKeys,
  "containsPrivateContent",
] as const;
const orderedTransitionRanks: Partial<Record<McpAttemptTransitionKind, number>> = {
  request_accepted: 0,
  authentication_completed: 1,
  authorization_completed: 2,
  server_constructed: 3,
  transport_connected: 4,
  execution_started: 5,
  execution_settled: 6,
  response_serialized: 7,
  boundary_returned: 8,
  client_acknowledged: 9,
};
interface McpFailureStageWindow {
  readonly earliestTransitionRank: number;
  readonly latestTransitionRank: number;
}
const failureStageWindows = {
  method_validation: { earliestTransitionRank: 0, latestTransitionRank: 0 },
  origin_validation: { earliestTransitionRank: 0, latestTransitionRank: 0 },
  host_validation: { earliestTransitionRank: 0, latestTransitionRank: 0 },
  token_authority: { earliestTransitionRank: 0, latestTransitionRank: 0 },
  authentication: { earliestTransitionRank: 0, latestTransitionRank: 0 },
  payload_parse: { earliestTransitionRank: 1, latestTransitionRank: 1 },
  authorization: { earliestTransitionRank: 1, latestTransitionRank: 1 },
  request_validation: { earliestTransitionRank: 1, latestTransitionRank: 2 },
  server_construction: { earliestTransitionRank: 2, latestTransitionRank: 2 },
  transport_connection: { earliestTransitionRank: 3, latestTransitionRank: 3 },
  request_execution: { earliestTransitionRank: 5, latestTransitionRank: 5 },
} as const satisfies Record<McpFailureStage, McpFailureStageWindow>;
const failureStages = Object.freeze(
  Object.keys(failureStageWindows) as McpFailureStage[],
);
const singletonTransitions = new Set<McpAttemptTransitionKind>(
  mcpAttemptTransitionKinds,
);
const postFailureTransitions = new Set<McpAttemptTransitionKind>([
  "response_serialized",
  "boundary_returned",
  "client_acknowledged",
  "reconciled",
]);
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const credentialPattern = /(?:^|[._:/-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/iu;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const maximumObservations = 128;

export function createMcpAttemptObservation(
  input: McpAttemptObservationInput,
): McpAttemptObservationV1 {
  const record = exactRecord(
    input,
    "MCP attempt observation input",
    inputKeys,
    requiredInputKeys,
  );
  const canonical = {
    version: 1 as const,
    attemptId: identity(record.attemptId, "MCP attempt ID"),
    requestId: identity(record.requestId, "MCP request ID"),
    ...optionalField(
      "operationIdentityDigest",
      optionalDigest(
        record.operationIdentityDigest,
        "MCP operation identity digest",
      ),
    ),
    sessionClassification: enumValue(
      record.sessionClassification,
      "MCP attempt session classification",
      mcpAttemptSessionClassifications,
    ),
    manifestFingerprint: digest(
      record.manifestFingerprint,
      "MCP manifest fingerprint",
    ),
    transition: enumValue(
      record.transition,
      "MCP attempt transition",
      mcpAttemptTransitionKinds,
    ),
    occurredAt: canonicalTimestamp(
      record.occurredAt,
      "MCP attempt observation time",
    ),
    ...optionalField(
      "failureStage",
      optionalEnumValue(record.failureStage, "MCP failure stage", failureStages),
    ),
    settlement: enumValue(
      record.settlement,
      "MCP settlement knowledge",
      mcpAttemptSettlementKnowledge,
    ),
    delivery: enumValue(
      record.delivery,
      "MCP delivery knowledge",
      mcpAttemptDeliveryKnowledge,
    ),
    containsPrivateContent: false as const,
  };
  validateObservationEvidence(canonical);
  return Object.freeze({
    ...canonical,
    observationId: fingerprint(canonical),
  });
}

export function projectMcpAttemptObservations(
  input: readonly McpAttemptObservationV1[],
): McpAttemptProjectionV1 {
  const raw = exactDenseArray(
    input,
    "MCP attempt observations",
    maximumObservations,
  );
  if (raw.length === 0) {
    throw new RangeError("MCP attempt projection requires at least one observation");
  }

  const observations = raw.map(admitObservation);
  const first = observations[0]!;
  if (first.transition !== "request_accepted") {
    throw new RangeError("MCP attempt projection must begin with request_accepted");
  }

  const observationIds = new Set<string>();
  const seenTransitions = new Set<McpAttemptTransitionKind>();
  let previous = first;
  let highestTransitionRank = orderedTransitionRanks.request_accepted!;
  let executionStartedAt: string | null = null;
  let settledAt: string | null = null;
  let responseSerializedAt: string | null = null;
  let boundaryReturnedAt: string | null = null;
  let clientAcknowledgedAt: string | null = null;
  let reconciledAt: string | null = null;
  let lastFailureStage: McpFailureStage | null = null;

  for (const [index, observation] of observations.entries()) {
    if (observationIds.has(observation.observationId)) {
      throw new RangeError("MCP attempt projection contains a duplicate observation");
    }
    observationIds.add(observation.observationId);
    if (
      singletonTransitions.has(observation.transition)
      && seenTransitions.has(observation.transition)
    ) {
      throw new RangeError(
        `MCP attempt projection repeats ${observation.transition}`,
      );
    }
    if (
      seenTransitions.has("failed")
      && !postFailureTransitions.has(observation.transition)
    ) {
      throw new RangeError(
        "MCP attempt cannot resume ordinary lifecycle progress after failure",
      );
    }

    if (index > 0) {
      requireSameAttempt(first, observation);
      if (observation.occurredAt < previous.occurredAt) {
        throw new RangeError("MCP attempt observation time moved backwards");
      }
      validateKnowledgeAdvance(previous, observation);
    }
    validateFailureStageChronology(observation, highestTransitionRank);
    seenTransitions.add(observation.transition);

    const transitionRank = orderedTransitionRanks[observation.transition];
    if (transitionRank !== undefined) {
      if (transitionRank < highestTransitionRank) {
        throw new RangeError("MCP attempt transition moved backwards");
      }
      highestTransitionRank = transitionRank;
    }

    if (observation.transition === "execution_started") {
      executionStartedAt = observation.occurredAt;
    }
    if (observation.transition === "execution_settled" && !executionStartedAt) {
      throw new RangeError("MCP execution settled before execution started");
    }
    if (observation.settlement === "settled" && !settledAt) {
      settledAt = observation.occurredAt;
    }
    if (observation.transition === "response_serialized") {
      responseSerializedAt = observation.occurredAt;
    }
    if (observation.transition === "boundary_returned") {
      boundaryReturnedAt = observation.occurredAt;
    }
    if (observation.transition === "client_acknowledged") {
      clientAcknowledgedAt = observation.occurredAt;
    }
    if (observation.transition === "reconciled") {
      reconciledAt = observation.occurredAt;
    }
    if (observation.failureStage) {
      lastFailureStage = observation.failureStage;
    }
    previous = observation;
  }

  const latest = observations.at(-1)!;
  const ids = Object.freeze(
    observations.map((observation) => observation.observationId),
  );
  const canonical = {
    version: 1 as const,
    attemptId: first.attemptId,
    requestId: first.requestId,
    ...optionalField(
      "operationIdentityDigest",
      first.operationIdentityDigest,
    ),
    sessionClassification: first.sessionClassification,
    manifestFingerprint: first.manifestFingerprint,
    eventCount: observations.length,
    acceptedAt: first.occurredAt,
    lastObservedAt: latest.occurredAt,
    latestTransition: latest.transition,
    settlement: latest.settlement,
    delivery: latest.delivery,
    executionStartedAt,
    settledAt,
    responseSerializedAt,
    boundaryReturnedAt,
    clientAcknowledgedAt,
    reconciledAt,
    lastFailureStage,
    observationIds: ids,
    containsPrivateContent: false as const,
  };
  return Object.freeze({
    ...canonical,
    projectionFingerprint: fingerprint(canonical),
  });
}

function admitObservation(value: unknown): McpAttemptObservationV1 {
  const record = exactRecord(
    value,
    "MCP attempt observation",
    observationKeys,
    requiredObservationKeys,
  );
  if (record.version !== 1) {
    throw new RangeError("MCP attempt observation version is unsupported");
  }
  if (record.containsPrivateContent !== false) {
    throw new RangeError("MCP attempt observation must exclude private content");
  }
  const expectedId = digest(
    record.observationId,
    "MCP attempt observation ID",
  );
  const observation = createMcpAttemptObservation({
    attemptId: record.attemptId as string,
    requestId: record.requestId as string,
    ...optionalField(
      "operationIdentityDigest",
      record.operationIdentityDigest as string | undefined,
    ),
    sessionClassification:
      record.sessionClassification as McpAttemptSessionClassification,
    manifestFingerprint: record.manifestFingerprint as string,
    transition: record.transition as McpAttemptTransitionKind,
    occurredAt: record.occurredAt as string,
    ...optionalField(
      "failureStage",
      record.failureStage as McpFailureStage | undefined,
    ),
    settlement: record.settlement as McpAttemptSettlementKnowledge,
    delivery: record.delivery as McpAttemptDeliveryKnowledge,
  });
  if (observation.observationId !== expectedId) {
    throw new RangeError("MCP attempt observation fingerprint does not match content");
  }
  return observation;
}

function validateObservationEvidence(input: {
  transition: McpAttemptTransitionKind;
  failureStage?: McpFailureStage;
  settlement: McpAttemptSettlementKnowledge;
  delivery: McpAttemptDeliveryKnowledge;
}): void {
  if (input.transition === "failed" && !input.failureStage) {
    throw new RangeError("Failed MCP attempt observation requires a failure stage");
  }
  if (input.transition !== "failed" && input.failureStage) {
    throw new RangeError("MCP failure stage is allowed only on failed observations");
  }
  if (input.transition === "failed" && input.settlement === "unsettled") {
    throw new RangeError(
      "Failed MCP attempt observation requires settled or ambiguous knowledge",
    );
  }
  if (input.transition === "failed" && input.settlement === "reconciled") {
    throw new RangeError("MCP reconciled knowledge requires a reconciled transition");
  }
  if (
    input.transition === "failed"
    && input.failureStage !== "request_execution"
    && input.settlement !== "settled"
  ) {
    throw new RangeError(
      "Pre-execution MCP failure requires settled knowledge",
    );
  }
  if (input.transition === "failed" && input.delivery === "boundary_returned") {
    throw new RangeError(
      "MCP boundary-returned knowledge requires a boundary-returned transition",
    );
  }
  if (input.transition === "failed" && input.delivery === "client_acknowledged") {
    throw new RangeError(
      "MCP client-acknowledged knowledge requires a client-acknowledged transition",
    );
  }
  if (
    input.transition === "request_accepted"
    && (input.settlement !== "unsettled" || input.delivery !== "unknown")
  ) {
    throw new RangeError(
      "Accepted MCP request must begin with unsettled and unknown delivery knowledge",
    );
  }
  if (
    input.transition === "execution_settled"
    && input.settlement !== "settled"
  ) {
    throw new RangeError("Settled MCP execution requires settled knowledge");
  }
  if (
    input.transition === "response_serialized"
    && input.delivery !== "unknown"
  ) {
    throw new RangeError("Serialized MCP response cannot claim delivery");
  }
  if (
    input.transition === "boundary_returned"
    && input.delivery !== "boundary_returned"
  ) {
    throw new RangeError("Returned MCP boundary requires boundary-returned knowledge");
  }
  if (
    input.transition === "client_acknowledged"
    && input.delivery !== "client_acknowledged"
  ) {
    throw new RangeError(
      "Acknowledged MCP client delivery requires client-acknowledged knowledge",
    );
  }
  if (
    input.transition === "reconciled"
    && input.settlement !== "reconciled"
  ) {
    throw new RangeError("Reconciled MCP attempt requires reconciled knowledge");
  }
}

function validateFailureStageChronology(
  observation: McpAttemptObservationV1,
  highestTransitionRank: number,
): void {
  if (observation.transition !== "failed" || !observation.failureStage) return;
  const window = failureStageWindows[observation.failureStage];
  if (highestTransitionRank < window.earliestTransitionRank) {
    throw new RangeError(
      `MCP failure stage ${observation.failureStage} is not yet reachable`,
    );
  }
  if (highestTransitionRank > window.latestTransitionRank) {
    throw new RangeError(
      `MCP failure stage ${observation.failureStage} occurred after its lifecycle interval`,
    );
  }
}

function validateKnowledgeAdvance(
  previous: McpAttemptObservationV1,
  current: McpAttemptObservationV1,
): void {
  if (current.transition === "request_accepted") {
    throw new RangeError("MCP attempt projection contains a second request_accepted event");
  }
  if (!settlementCanAdvance(previous.settlement, current.settlement)) {
    throw new RangeError("MCP settlement knowledge regressed");
  }
  if (!deliveryCanAdvance(previous.delivery, current.delivery)) {
    throw new RangeError("MCP delivery knowledge regressed");
  }
  if (
    previous.settlement === "reconciled"
    && current.transition !== "reconciled"
    && current.transition !== "client_acknowledged"
  ) {
    throw new RangeError("MCP attempt continued after reconciliation");
  }
  if (
    previous.settlement !== "ambiguous"
    && current.settlement === "ambiguous"
    && current.transition !== "failed"
  ) {
    throw new RangeError("MCP ambiguous settlement requires a failed transition");
  }
  if (
    previous.settlement !== "settled"
    && current.settlement === "settled"
    && current.transition !== "execution_settled"
    && current.transition !== "failed"
  ) {
    throw new RangeError("MCP settled knowledge requires settlement evidence");
  }
  if (
    previous.settlement !== "reconciled"
    && current.settlement === "reconciled"
    && current.transition !== "reconciled"
  ) {
    throw new RangeError("MCP reconciled knowledge requires a reconciled transition");
  }
  if (
    previous.delivery === "unknown"
    && current.delivery === "boundary_returned"
    && current.transition !== "boundary_returned"
  ) {
    throw new RangeError(
      "MCP boundary-returned knowledge requires a boundary-returned transition",
    );
  }
  if (
    previous.delivery !== "client_acknowledged"
    && current.delivery === "client_acknowledged"
    && current.transition !== "client_acknowledged"
  ) {
    throw new RangeError(
      "MCP client-acknowledged knowledge requires a client-acknowledged transition",
    );
  }
  if (
    current.transition === "client_acknowledged"
    && previous.delivery !== "boundary_returned"
  ) {
    throw new RangeError(
      "MCP client acknowledgement requires prior boundary-returned evidence",
    );
  }
}

function requireSameAttempt(
  first: McpAttemptObservationV1,
  current: McpAttemptObservationV1,
): void {
  if (
    current.attemptId !== first.attemptId
    || current.requestId !== first.requestId
    || current.operationIdentityDigest !== first.operationIdentityDigest
    || current.sessionClassification !== first.sessionClassification
    || current.manifestFingerprint !== first.manifestFingerprint
  ) {
    throw new RangeError("MCP attempt projection mixes observation identities");
  }
}

function settlementCanAdvance(
  previous: McpAttemptSettlementKnowledge,
  current: McpAttemptSettlementKnowledge,
): boolean {
  if (previous === "reconciled") return current === "reconciled";
  if (previous === "settled") {
    return current === "settled" || current === "reconciled";
  }
  if (previous === "ambiguous") {
    return current === "ambiguous"
      || current === "settled"
      || current === "reconciled";
  }
  return true;
}

function deliveryCanAdvance(
  previous: McpAttemptDeliveryKnowledge,
  current: McpAttemptDeliveryKnowledge,
): boolean {
  if (previous === "client_acknowledged") {
    return current === "client_acknowledged";
  }
  if (previous === "boundary_returned") {
    return current === "boundary_returned" || current === "client_acknowledged";
  }
  return true;
}

function exactDenseArray(
  value: unknown,
  label: string,
  maximumLength: number,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new TypeError(`${label} has an invalid length descriptor`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${label} has an invalid length`);
  }
  if (length > maximumLength) {
    throw new RangeError(`${label} exceeds ${maximumLength} observations`);
  }
  const allowedKeys = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) {
    allowedKeys.add(String(index));
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol fields`);
    }
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unsupported fields`);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must be a dense data array`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function exactRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol fields`);
    }
    if (!allowedKeys.includes(key)) {
      throw new TypeError(`${label} contains unknown fields`);
    }
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    record[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`${label} is missing ${key}`);
    }
  }
  return record;
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !identityPattern.test(value)
    || credentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function optionalDigest(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : digest(value, label);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function optionalEnumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] | undefined {
  return value === undefined ? undefined : enumValue(value, label, values);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new RangeError(`${label} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    throw new RangeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}
