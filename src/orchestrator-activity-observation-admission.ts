import { stableJson } from "./canonical-json.js";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservation,
  type OrchestratorActivityObservationInput,
} from "./orchestrator-activity-observation.js";

const observationFields = [
  "schemaVersion",
  "observationId",
  "observationFingerprint",
  "workspace",
  "project",
  "actorId",
  "sourceClass",
  "sourceId",
  "sourceFingerprint",
  "observedAt",
  "activityClass",
  "activityState",
  "workItemId",
  "attemptId",
  "runId",
  "responsibilityGeneration",
  "causalPredecessorId",
  "relatedEvidenceIds",
  "provider",
  "providerLifecycle",
  "attention",
  "disclosure",
] as const;
const attentionFields = ["level", "reasonCode", "nextAction"] as const;
const disclosureFields = [
  "containsPrivateReasoning",
  "containsRawPrompt",
  "containsProviderBody",
  "containsCredentialMaterial",
  "containsUnboundedLogText",
] as const;
const maximumRelatedEvidence = 32;
type OptionalStringInputKey =
  | "workItemId"
  | "attemptId"
  | "runId"
  | "causalPredecessorId"
  | "provider"
  | "attentionReasonCode"
  | "nextAction";

/**
 * Re-admits one canonical activity observation emitted by the compiler.
 * Durable/provider boundaries use this instead of treating canonical output as
 * producer input, whose optional-field grammar intentionally uses omission.
 */
export function admitOrchestratorActivityObservation(
  value: unknown,
): OrchestratorActivityObservation {
  const record = exactRecord(value, observationFields, "Orchestrator activity observation");
  const attention = exactRecord(
    record.attention,
    attentionFields,
    "Orchestrator activity attention",
  );
  const disclosure = exactRecord(
    record.disclosure,
    disclosureFields,
    "Orchestrator activity disclosure",
  );
  const relatedEvidenceIds = exactArray(
    record.relatedEvidenceIds,
    "Orchestrator activity related evidence",
  );

  const input: OrchestratorActivityObservationInput = {
    workspace: requiredString(record.workspace, "workspace"),
    project: requiredString(record.project, "project"),
    actorId: requiredString(record.actorId, "actor ID"),
    sourceClass: requiredString(record.sourceClass, "source class") as OrchestratorActivityObservationInput["sourceClass"],
    sourceId: requiredString(record.sourceId, "source ID"),
    sourceFingerprint: requiredString(record.sourceFingerprint, "source fingerprint"),
    observedAt: requiredString(record.observedAt, "observed time"),
    activityClass: requiredString(record.activityClass, "activity class") as OrchestratorActivityObservationInput["activityClass"],
    activityState: requiredString(record.activityState, "activity state") as OrchestratorActivityObservationInput["activityState"],
    relatedEvidenceIds,
    attentionLevel: requiredString(attention.level, "attention level") as OrchestratorActivityObservationInput["attentionLevel"],
  };
  assignOptionalString(input, "workItemId", record.workItemId, "work item ID");
  assignOptionalString(input, "attemptId", record.attemptId, "attempt ID");
  assignOptionalString(input, "runId", record.runId, "run ID");
  if (record.responsibilityGeneration !== null) {
    if (typeof record.responsibilityGeneration !== "number") {
      throw new Error("Orchestrator activity responsibility generation is invalid");
    }
    input.responsibilityGeneration = record.responsibilityGeneration;
  }
  assignOptionalString(
    input,
    "causalPredecessorId",
    record.causalPredecessorId,
    "causal predecessor ID",
  );
  assignOptionalString(input, "provider", record.provider, "provider");
  if (record.providerLifecycle !== null) {
    input.providerLifecycle = requiredString(
      record.providerLifecycle,
      "provider lifecycle",
    ) as OrchestratorActivityObservationInput["providerLifecycle"];
  }
  assignOptionalString(
    input,
    "attentionReasonCode",
    attention.reasonCode,
    "attention reason code",
  );
  assignOptionalString(input, "nextAction", attention.nextAction, "next action");

  for (const field of disclosureFields) {
    if (disclosure[field] !== false) {
      throw new Error("Orchestrator activity disclosure is invalid");
    }
  }
  if (record.schemaVersion !== 1) {
    throw new Error("Orchestrator activity observation version is invalid");
  }

  const admitted = compileOrchestratorActivityObservation(input);
  const snapshot = {
    schemaVersion: record.schemaVersion,
    observationId: record.observationId,
    observationFingerprint: record.observationFingerprint,
    workspace: record.workspace,
    project: record.project,
    actorId: record.actorId,
    sourceClass: record.sourceClass,
    sourceId: record.sourceId,
    sourceFingerprint: record.sourceFingerprint,
    observedAt: record.observedAt,
    activityClass: record.activityClass,
    activityState: record.activityState,
    workItemId: canonicalNullable(record.workItemId, "work item ID"),
    attemptId: canonicalNullable(record.attemptId, "attempt ID"),
    runId: canonicalNullable(record.runId, "run ID"),
    responsibilityGeneration: canonicalNullable(
      record.responsibilityGeneration,
      "responsibility generation",
    ),
    causalPredecessorId: canonicalNullable(
      record.causalPredecessorId,
      "causal predecessor ID",
    ),
    relatedEvidenceIds,
    provider: canonicalNullable(record.provider, "provider"),
    providerLifecycle: canonicalNullable(record.providerLifecycle, "provider lifecycle"),
    attention: {
      level: attention.level,
      reasonCode: canonicalNullable(attention.reasonCode, "attention reason code"),
      nextAction: canonicalNullable(attention.nextAction, "next action"),
    },
    disclosure: {
      containsPrivateReasoning: disclosure.containsPrivateReasoning,
      containsRawPrompt: disclosure.containsRawPrompt,
      containsProviderBody: disclosure.containsProviderBody,
      containsCredentialMaterial: disclosure.containsCredentialMaterial,
      containsUnboundedLogText: disclosure.containsUnboundedLogText,
    },
  };
  if (stableJson(admitted) !== stableJson(snapshot)) {
    throw new Error("Orchestrator activity canonical observation is inconsistent");
  }
  return admitted;
}

/** Converts trusted canonical output back to the producer-input spelling. */
export function orchestratorActivityObservationInput(
  observation: OrchestratorActivityObservation,
): OrchestratorActivityObservationInput {
  const input: OrchestratorActivityObservationInput = {
    workspace: observation.workspace,
    project: observation.project,
    actorId: observation.actorId,
    sourceClass: observation.sourceClass,
    sourceId: observation.sourceId,
    sourceFingerprint: observation.sourceFingerprint,
    observedAt: observation.observedAt,
    activityClass: observation.activityClass,
    activityState: observation.activityState,
    relatedEvidenceIds: [...observation.relatedEvidenceIds],
    attentionLevel: observation.attention.level,
  };
  if (observation.workItemId !== null) input.workItemId = observation.workItemId;
  if (observation.attemptId !== null) input.attemptId = observation.attemptId;
  if (observation.runId !== null) input.runId = observation.runId;
  if (observation.responsibilityGeneration !== null) {
    input.responsibilityGeneration = observation.responsibilityGeneration;
  }
  if (observation.causalPredecessorId !== null) {
    input.causalPredecessorId = observation.causalPredecessorId;
  }
  if (observation.provider !== null) input.provider = observation.provider;
  if (observation.providerLifecycle !== null) {
    input.providerLifecycle = observation.providerLifecycle;
  }
  if (observation.attention.reasonCode !== null) {
    input.attentionReasonCode = observation.attention.reasonCode;
  }
  if (observation.attention.nextAction !== null) {
    input.nextAction = observation.attention.nextAction;
  }
  return input;
}

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  fields: T,
  label: string,
): Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error(`${label} could not be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must use a plain or null prototype`);
  }
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key as T[number]))
  ) {
    throw new Error(`${label} fields are invalid`);
  }
  const record = Object.create(null) as Record<T[number], unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      throw new Error(`${label} could not be inspected`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} field ${field} is invalid`);
    }
    record[field as T[number]] = descriptor.value;
  }
  return record;
}

function exactArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error(`${label} could not be inspected`);
  }
  if (
    prototype !== Array.prototype
    || !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumRelatedEvidence
  ) {
    throw new Error(`${label} is invalid`);
  }
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new Error(`${label} is decorated or sparse`);
  }
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new Error(`${label} is decorated or sparse`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} entry is invalid`);
    }
    values.push(requiredString(descriptor.value, `${label} entry`));
  }
  return values;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Orchestrator activity ${label} is invalid`);
  return value;
}

function canonicalNullable(value: unknown, label: string): unknown {
  if (value === undefined) throw new Error(`Orchestrator activity ${label} must use null`);
  return value;
}

function assignOptionalString(
  input: OrchestratorActivityObservationInput,
  key: OptionalStringInputKey,
  value: unknown,
  label: string,
): void {
  if (value === null) return;
  if (value === undefined) throw new Error(`Orchestrator activity ${label} must use null`);
  input[key] = requiredString(value, label);
}
