import { sha256, stableJson } from "./canonical-json.js";

export const ORCHESTRATOR_ACTIVITY_SOURCE_CLASSES = [
  "ledger_event",
  "responsibility",
  "provider_receipt",
  "ci_receipt",
  "artifact",
  "provider_observation",
] as const;

export const ORCHESTRATOR_ACTIVITY_CLASSES = [
  "work_started",
  "progress_evidence",
  "provider_effect",
  "verification",
  "blocked",
  "handoff",
  "completed",
  "reconciliation_required",
  "attention_required",
] as const;

export const ORCHESTRATOR_ACTIVITY_STATES = [
  "observed",
  "in_progress",
  "succeeded",
  "failed",
  "blocked",
  "ambiguous",
  "stale",
  "conflicted",
] as const;

export const ORCHESTRATOR_PROVIDER_LIFECYCLES = [
  "reserved",
  "dispatched",
  "accepted",
  "verified",
  "rejected",
  "pending_reconciliation",
] as const;

export const ORCHESTRATOR_ATTENTION_LEVELS = [
  "none",
  "review",
  "decision",
  "incident",
] as const;

export type OrchestratorActivitySourceClass =
  typeof ORCHESTRATOR_ACTIVITY_SOURCE_CLASSES[number];
export type OrchestratorActivityClass =
  typeof ORCHESTRATOR_ACTIVITY_CLASSES[number];
export type OrchestratorActivityState =
  typeof ORCHESTRATOR_ACTIVITY_STATES[number];
export type OrchestratorProviderLifecycle =
  typeof ORCHESTRATOR_PROVIDER_LIFECYCLES[number];
export type OrchestratorAttentionLevel =
  typeof ORCHESTRATOR_ATTENTION_LEVELS[number];

export interface OrchestratorActivityObservationInput {
  workspace: string;
  project: string;
  actorId: string;
  sourceClass: OrchestratorActivitySourceClass;
  sourceId: string;
  sourceFingerprint: string;
  observedAt: string;
  activityClass: OrchestratorActivityClass;
  activityState: OrchestratorActivityState;
  workItemId?: string;
  attemptId?: string;
  runId?: string;
  responsibilityGeneration?: number;
  causalPredecessorId?: string;
  relatedEvidenceIds?: string[];
  provider?: string;
  providerLifecycle?: OrchestratorProviderLifecycle;
  attentionLevel?: OrchestratorAttentionLevel;
  attentionReasonCode?: string;
  nextAction?: string;
}

export interface OrchestratorActivityObservation {
  schemaVersion: 1;
  observationId: string;
  observationFingerprint: string;
  workspace: string;
  project: string;
  actorId: string;
  sourceClass: OrchestratorActivitySourceClass;
  sourceId: string;
  sourceFingerprint: string;
  observedAt: string;
  activityClass: OrchestratorActivityClass;
  activityState: OrchestratorActivityState;
  workItemId: string | null;
  attemptId: string | null;
  runId: string | null;
  responsibilityGeneration: number | null;
  causalPredecessorId: string | null;
  relatedEvidenceIds: readonly string[];
  provider: string | null;
  providerLifecycle: OrchestratorProviderLifecycle | null;
  attention: Readonly<{
    level: OrchestratorAttentionLevel;
    reasonCode: string | null;
    nextAction: string | null;
  }>;
  disclosure: Readonly<{
    containsPrivateReasoning: false;
    containsRawPrompt: false;
    containsProviderBody: false;
    containsCredentialMaterial: false;
    containsUnboundedLogText: false;
  }>;
}

const allowedInputFields = new Set<string>([
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
  "attentionLevel",
  "attentionReasonCode",
  "nextAction",
]);

const requiredInputFields = [
  "workspace",
  "project",
  "actorId",
  "sourceClass",
  "sourceId",
  "sourceFingerprint",
  "observedAt",
  "activityClass",
  "activityState",
] as const;

const maximumRelatedEvidence = 32;
const maximumResponsibilityGeneration = 2_147_483_647;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,239}$/u;
const credentialPattern = /(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|sk-(?:proj-)?[A-Za-z0-9_\-]{12,}|stn\.(?:tok|svc)_[A-Za-z0-9._\-]{12,}|xox[baprs]-[A-Za-z0-9\-]{12,}|authorization\s*:)/iu;

/**
 * Compiles one content-minimised activity fact for automatic orchestrator
 * telemetry. It grants no authority and accepts no narrative, prompt, provider
 * body, credential, or unbounded log field.
 */
export function compileOrchestratorActivityObservation(
  input: unknown,
): OrchestratorActivityObservation {
  const record = exactInputRecord(input);
  const workspace = slug(record.workspace, "workspace", 80);
  const project = slug(record.project, "project", 80);
  const actorId = identifier(record.actorId, "actor ID");
  const sourceClass = closedValue(
    record.sourceClass,
    ORCHESTRATOR_ACTIVITY_SOURCE_CLASSES,
    "source class",
  );
  const sourceId = identifier(record.sourceId, "source ID");
  const sourceFingerprint = fingerprint(
    record.sourceFingerprint,
    "source fingerprint",
  );
  const observedAt = canonicalTimestamp(record.observedAt);
  const activityClass = closedValue(
    record.activityClass,
    ORCHESTRATOR_ACTIVITY_CLASSES,
    "activity class",
  );
  const activityState = closedValue(
    record.activityState,
    ORCHESTRATOR_ACTIVITY_STATES,
    "activity state",
  );

  const workItemId = optionalIdentifier(record.workItemId, "work item ID");
  const attemptId = optionalIdentifier(record.attemptId, "attempt ID");
  const runId = optionalIdentifier(record.runId, "run ID");
  const responsibilityGeneration = optionalGeneration(
    record.responsibilityGeneration,
  );
  const causalPredecessorId = optionalIdentifier(
    record.causalPredecessorId,
    "causal predecessor ID",
  );
  const relatedEvidenceIds = record.relatedEvidenceIds === undefined
    ? []
    : identifierArray(record.relatedEvidenceIds, "related evidence ID");

  const provider = optionalSlug(record.provider, "provider", 40);
  const providerLifecycle = record.providerLifecycle === undefined
    ? null
    : closedValue(
      record.providerLifecycle,
      ORCHESTRATOR_PROVIDER_LIFECYCLES,
      "provider lifecycle",
    );
  if ((provider === null) !== (providerLifecycle === null)) {
    throw new Error("Provider and provider lifecycle must be supplied together");
  }
  if (
    (
      sourceClass === "provider_receipt"
      || sourceClass === "provider_observation"
      || activityClass === "provider_effect"
    )
    && provider === null
  ) {
    throw new Error("Provider activity requires provider lifecycle evidence");
  }

  const attentionLevel = record.attentionLevel === undefined
    ? "none"
    : closedValue(
      record.attentionLevel,
      ORCHESTRATOR_ATTENTION_LEVELS,
      "attention level",
    );
  const attentionReasonCode = optionalIdentifier(
    record.attentionReasonCode,
    "attention reason code",
  );
  const nextAction = optionalIdentifier(record.nextAction, "next action");
  if (attentionLevel === "none") {
    if (attentionReasonCode !== null || nextAction !== null) {
      throw new Error(
        "Attention reason and next action require a non-none attention level",
      );
    }
  } else if (attentionReasonCode === null || nextAction === null) {
    throw new Error("Non-none attention requires a reason code and next action");
  }
  if (activityClass === "attention_required" && attentionLevel === "none") {
    throw new Error("Attention-required activity requires non-none attention");
  }
  enforceActivityCoherence(activityClass, activityState);

  const payload = {
    schemaVersion: 1 as const,
    workspace,
    project,
    actorId,
    sourceClass,
    sourceId,
    sourceFingerprint,
    observedAt,
    activityClass,
    activityState,
    workItemId,
    attemptId,
    runId,
    responsibilityGeneration,
    causalPredecessorId,
    relatedEvidenceIds,
    provider,
    providerLifecycle,
    attention: {
      level: attentionLevel,
      reasonCode: attentionReasonCode,
      nextAction,
    },
    disclosure: {
      containsPrivateReasoning: false as const,
      containsRawPrompt: false as const,
      containsProviderBody: false as const,
      containsCredentialMaterial: false as const,
      containsUnboundedLogText: false as const,
    },
  };
  const observationFingerprint = sha256(stableJson(payload));
  const observationId =
    `oao_${observationFingerprint.slice("sha256:".length, 39)}`;

  return deepFreeze({
    ...payload,
    observationId,
    observationFingerprint,
  });
}

function exactInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Orchestrator activity observation must be an object");
  }
  let isArray: boolean;
  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("Orchestrator activity observation could not be inspected");
  }
  if (isArray) {
    throw new Error("Orchestrator activity observation must be an object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      "Orchestrator activity observation must use a plain or null prototype",
    );
  }
  if (symbols.length > 0) {
    throw new Error("Orchestrator activity observation contains a symbol field");
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedInputFields.has(key)) {
      throw new Error("Orchestrator activity observation has an unknown field");
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(
        `Orchestrator activity observation field ${key} must be an enumerable data property`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredInputFields) {
    if (!Object.hasOwn(result, key)) {
      throw new Error(
        `Orchestrator activity observation is missing field ${key}`,
      );
    }
  }
  return result;
}

function identifierArray(value: unknown, label: string): string[] {
  let isArray: boolean;
  let prototype: object | null;
  let names: string[];
  let symbols: symbol[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = isArray && value !== null
      ? Object.getPrototypeOf(value)
      : null;
    names = isArray && value !== null
      ? Object.getOwnPropertyNames(value)
      : [];
    symbols = isArray && value !== null
      ? Object.getOwnPropertySymbols(value)
      : [];
    lengthDescriptor = isArray && value !== null
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
  } catch {
    throw new Error(`${label} list could not be inspected`);
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new Error(`${label} list must be an ordinary array`);
  }
  if (
    symbols.length > 0
    || !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumRelatedEvidence
  ) {
    throw new Error(`${label} list is invalid`);
  }

  const length = lengthDescriptor.value as number;
  if (names.length !== length + 1 || !names.includes("length")) {
    throw new Error(`${label} list must be dense and undecorated`);
  }
  const admitted: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!names.includes(key)) {
      throw new Error(`${label} list must be dense and undecorated`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new Error(`${label} list could not be inspected`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} list entries must be enumerable data properties`);
    }
    admitted.push(identifier(descriptor.value, label));
  }
  if (new Set(admitted).size !== admitted.length) {
    throw new Error(`${label} list must be unique`);
  }
  return admitted.sort(codeUnitCompare);
}

function optionalSlug(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  return value === undefined ? null : slug(value, label, maximumLength);
}

function slug(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || !/^[a-z0-9][a-z0-9_\-]*$/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  rejectCredential(value, label);
  return value;
}

function optionalIdentifier(value: unknown, label: string): string | null {
  return value === undefined ? null : identifier(value, label);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  rejectCredential(value, label);
  return value;
}

function rejectCredential(value: string, label: string): void {
  if (credentialPattern.test(value)) {
    throw new Error(`${label} cannot contain credential material`);
  }
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be an exact SHA-256 fingerprint`);
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Observed time must be a canonical timestamp");
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error("Observed time must be a canonical timestamp");
  }
  if (canonical !== value) {
    throw new Error("Observed time must be a canonical timestamp");
  }
  return canonical;
}

function optionalGeneration(value: unknown): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximumResponsibilityGeneration
  ) {
    throw new Error("Responsibility generation is invalid");
  }
  return value;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}

function enforceActivityCoherence(
  activityClass: OrchestratorActivityClass,
  activityState: OrchestratorActivityState,
): void {
  if (activityClass === "completed" && activityState !== "succeeded") {
    throw new Error("Completed activity must be succeeded");
  }
  if (activityClass === "blocked" && activityState !== "blocked") {
    throw new Error("Blocked activity must use blocked state");
  }
  if (
    activityClass === "reconciliation_required"
    && activityState !== "ambiguous"
  ) {
    throw new Error(
      "Reconciliation-required activity must use ambiguous state",
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
