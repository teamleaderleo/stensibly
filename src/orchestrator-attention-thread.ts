import {
  compareCodeUnits,
  sha256,
  stableJson,
} from "./canonical-json.js";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservation,
  type OrchestratorActivityObservationInput,
  type OrchestratorActivitySourceClass,
} from "./orchestrator-activity-observation.js";

export const ORCHESTRATOR_ATTENTION_THREAD_STATES = Object.freeze([
  "open",
  "resolved",
  "contradictory",
  "incomplete",
] as const);

export const ORCHESTRATOR_ATTENTION_COVERAGE_STATES = Object.freeze([
  "complete",
  "partial",
] as const);

export type OrchestratorAttentionThreadState =
  typeof ORCHESTRATOR_ATTENTION_THREAD_STATES[number];
export type OrchestratorAttentionCoverageState =
  typeof ORCHESTRATOR_ATTENTION_COVERAGE_STATES[number];
export type OrchestratorAttentionClass = "review" | "decision" | "incident";

export interface OrchestratorAttentionThread {
  schemaVersion: 1;
  threadId: string;
  threadFingerprint: string;
  workspace: string;
  project: string;
  workItemId: string | null;
  attemptId: string | null;
  runId: string | null;
  responsibilityGeneration: number | null;
  provider: string;
  attentionClass: OrchestratorAttentionClass;
  state: OrchestratorAttentionThreadState;
  reasonCode: string;
  nextAction: string;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  evidenceCount: number;
  supportingObservationIds: readonly string[];
  contradictionCount: number;
  contradictingObservationIds: readonly string[];
  sourceClasses: readonly OrchestratorActivitySourceClass[];
  coverage: Readonly<{
    state: OrchestratorAttentionCoverageState;
    missingSourceClasses: readonly OrchestratorActivitySourceClass[];
  }>;
  resolutionCondition: "exact_provider_reconciliation";
  grantsAuthority: false;
}

export interface OrchestratorAttentionProjection {
  schemaVersion: 1;
  projectionFingerprint: string;
  observationCount: number;
  threadCount: number;
  threads: readonly OrchestratorAttentionThread[];
  grantsAuthority: false;
}

interface ThreadSeed {
  lineageKey: string;
  reasonCode: string;
  nextAction: string;
  observations: OrchestratorActivityObservation[];
}

const maximumObservations = 256;
const maximumRetainedEvidenceIds = 32;
const expectedProviderSourceClasses = Object.freeze([
  "provider_receipt",
  "provider_observation",
] as const satisfies readonly OrchestratorActivitySourceClass[]);
const observationKeys = Object.freeze([
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
] as const);
const attentionKeys = Object.freeze([
  "level",
  "reasonCode",
  "nextAction",
] as const);
const disclosureKeys = Object.freeze([
  "containsPrivateReasoning",
  "containsRawPrompt",
  "containsProviderBody",
  "containsCredentialMaterial",
  "containsUnboundedLogText",
] as const);

/**
 * Deterministically compiles operator-attention threads from already admitted
 * orchestrator activity observations. The projection grants no authority and
 * retains only bounded structured evidence identities.
 */
export function compileOrchestratorAttentionProjection(
  input: unknown,
): OrchestratorAttentionProjection {
  const observations = admitObservationArray(input);
  const lineage = new Map<string, OrchestratorActivityObservation[]>();
  const seeds = new Map<string, ThreadSeed>();

  for (const observation of observations) {
    const lineageKey = observationLineageKey(observation);
    const lineageEntries = lineage.get(lineageKey) ?? [];
    lineageEntries.push(observation);
    lineage.set(lineageKey, lineageEntries);

    if (!isProviderAmbiguity(observation)) continue;
    const reasonCode = observation.attention.reasonCode
      ?? "provider_outcome_ambiguous";
    const nextAction = observation.attention.nextAction
      ?? "reconcile_exact_operation";
    const seedKey = stableJson([lineageKey, reasonCode, nextAction]);
    const seed = seeds.get(seedKey) ?? {
      lineageKey,
      reasonCode,
      nextAction,
      observations: [],
    };
    seed.observations.push(observation);
    seeds.set(seedKey, seed);
  }

  const threads = [...seeds.values()].map((seed) =>
    compileThread(seed, lineage.get(seed.lineageKey) ?? seed.observations)
  ).sort((left, right) => compareCodeUnits(left.threadId, right.threadId));

  const projectionPayload = {
    schemaVersion: 1 as const,
    observationCount: observations.length,
    threadCount: threads.length,
    threads,
    grantsAuthority: false as const,
  };
  const projectionFingerprint = sha256(stableJson(projectionPayload));
  return deepFreeze({
    ...projectionPayload,
    projectionFingerprint,
  });
}

function compileThread(
  seed: ThreadSeed,
  lineageObservations: readonly OrchestratorActivityObservation[],
): OrchestratorAttentionThread {
  const supports = [...seed.observations].sort(compareObservations);
  const latestSupport = supports.at(-1)!;
  const supportIds = new Set(supports.map((entry) => entry.observationId));
  const provider = supports[0]!.provider;
  if (!provider) {
    throw new Error("Orchestrator attention provider evidence was missing");
  }

  const relevantLineage = lineageObservations
    .filter((entry) => entry.provider === provider)
    .sort(compareObservations);
  const resolvers = relevantLineage.filter((entry) =>
    isExactProviderResolver(
      entry,
      latestSupport.observationId,
      latestSupport.observedAt,
    )
  );
  const resolverIds = new Set(resolvers.map((entry) => entry.observationId));
  const contradictions = relevantLineage.filter((entry) =>
    !supportIds.has(entry.observationId)
    && !resolverIds.has(entry.observationId)
    && isMaterialProviderContradiction(entry)
  );

  const representedSourceClasses = uniqueSorted(
    relevantLineage.map((entry) => entry.sourceClass),
  ) as OrchestratorActivitySourceClass[];
  const missingSourceClasses = expectedProviderSourceClasses.filter(
    (sourceClass) => !representedSourceClasses.includes(sourceClass),
  );
  const coverageState: OrchestratorAttentionCoverageState =
    missingSourceClasses.length === 0 ? "complete" : "partial";

  const resolver = resolvers.at(-1) ?? null;
  const state: OrchestratorAttentionThreadState = contradictions.length > 0
    ? "contradictory"
    : missingSourceClasses.length > 0
      ? "incomplete"
      : resolver
        ? "resolved"
        : "open";

  const first = supports[0]!;
  const evidenceObservations = [
    ...supports,
    ...contradictions,
    ...(resolver ? [resolver] : []),
  ].sort(compareObservations);
  const attentionClass = strongestAttentionClass(supports);
  const payload = {
    schemaVersion: 1 as const,
    workspace: first.workspace,
    project: first.project,
    workItemId: first.workItemId,
    attemptId: first.attemptId,
    runId: first.runId,
    responsibilityGeneration: first.responsibilityGeneration,
    provider,
    attentionClass,
    state,
    reasonCode: seed.reasonCode,
    nextAction: seed.nextAction,
    openedAt: first.observedAt,
    updatedAt: evidenceObservations.at(-1)!.observedAt,
    resolvedAt: state === "resolved" ? resolver!.observedAt : null,
    evidenceCount: supports.length,
    supportingObservationIds: compactEvidenceIds(supports),
    contradictionCount: contradictions.length,
    contradictingObservationIds: compactEvidenceIds(contradictions),
    sourceClasses: Object.freeze(representedSourceClasses),
    coverage: Object.freeze({
      state: coverageState,
      missingSourceClasses: Object.freeze([...missingSourceClasses]),
    }),
    resolutionCondition: "exact_provider_reconciliation" as const,
    grantsAuthority: false as const,
  };
  const threadFingerprint = sha256(stableJson(payload));
  const threadId = `oat_${threadFingerprint.slice("sha256:".length, 39)}`;
  return deepFreeze({
    ...payload,
    threadId,
    threadFingerprint,
  });
}

function admitObservationArray(input: unknown): OrchestratorActivityObservation[] {
  let isArray: boolean;
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(input);
    prototype = isArray && input !== null ? Object.getPrototypeOf(input) : null;
    lengthDescriptor = isArray && input !== null
      ? Object.getOwnPropertyDescriptor(input, "length")
      : undefined;
  } catch {
    throw new Error("Orchestrator attention observations could not be inspected");
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new Error("Orchestrator attention observations must be an ordinary array");
  }
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maximumObservations
  ) {
    throw new RangeError(
      `Orchestrator attention accepts at most ${maximumObservations} observations`,
    );
  }

  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error("Orchestrator attention observations could not be inspected");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new Error("Orchestrator attention observations must be dense and undecorated");
  }

  const byId = new Map<string, OrchestratorActivityObservation>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(
        "Orchestrator attention observations must contain enumerable data entries",
      );
    }
    const observation = admitObservation(descriptor.value);
    const existing = byId.get(observation.observationId);
    if (existing) {
      if (
        existing.observationFingerprint !== observation.observationFingerprint
        || stableJson(existing) !== stableJson(observation)
      ) {
        throw new Error("Orchestrator attention observation identity conflict");
      }
      continue;
    }
    byId.set(observation.observationId, observation);
  }
  return [...byId.values()].sort(compareObservations);
}

function admitObservation(value: unknown): OrchestratorActivityObservation {
  const snapshot = snapshotExactRecord(
    value,
    observationKeys,
    "Orchestrator attention observation",
  );
  snapshot.relatedEvidenceIds = snapshotDenseArray(
    snapshot.relatedEvidenceIds,
    32,
    "Orchestrator attention related evidence",
  );
  snapshot.attention = snapshotExactRecord(
    snapshot.attention,
    attentionKeys,
    "Orchestrator attention observation attention",
  );
  snapshot.disclosure = snapshotExactRecord(
    snapshot.disclosure,
    disclosureKeys,
    "Orchestrator attention observation disclosure",
  );

  const rebuiltInput = {
    workspace: snapshot.workspace,
    project: snapshot.project,
    actorId: snapshot.actorId,
    sourceClass: snapshot.sourceClass,
    sourceId: snapshot.sourceId,
    sourceFingerprint: snapshot.sourceFingerprint,
    observedAt: snapshot.observedAt,
    activityClass: snapshot.activityClass,
    activityState: snapshot.activityState,
    ...(snapshot.workItemId === null ? {} : { workItemId: snapshot.workItemId }),
    ...(snapshot.attemptId === null ? {} : { attemptId: snapshot.attemptId }),
    ...(snapshot.runId === null ? {} : { runId: snapshot.runId }),
    ...(snapshot.responsibilityGeneration === null
      ? {}
      : { responsibilityGeneration: snapshot.responsibilityGeneration }),
    ...(snapshot.causalPredecessorId === null
      ? {}
      : { causalPredecessorId: snapshot.causalPredecessorId }),
    relatedEvidenceIds: snapshot.relatedEvidenceIds,
    ...(snapshot.provider === null
      ? {}
      : {
          provider: snapshot.provider,
          providerLifecycle: snapshot.providerLifecycle,
        }),
    ...attentionInput(snapshot.attention as Record<string, unknown>),
  } as OrchestratorActivityObservationInput;
  const canonical = compileOrchestratorActivityObservation(rebuiltInput);
  if (
    snapshot.schemaVersion !== 1
    || snapshot.observationId !== canonical.observationId
    || snapshot.observationFingerprint !== canonical.observationFingerprint
    || stableJson(snapshot) !== stableJson(canonical)
  ) {
    throw new Error("Orchestrator attention observation identity changed");
  }
  return canonical;
}

function attentionInput(
  attention: Record<string, unknown>,
): Partial<OrchestratorActivityObservationInput> {
  if (attention.level === "none") return {};
  return {
    attentionLevel: attention.level,
    attentionReasonCode: attention.reasonCode,
    nextAction: attention.nextAction,
  } as Partial<OrchestratorActivityObservationInput>;
}

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} could not be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must use a plain or null prototype`);
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error(`${label} must use exact fields`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotDenseArray(
  value: unknown,
  maximumLength: number,
  label: string,
): unknown[] {
  let isArray: boolean;
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = isArray && value !== null ? Object.getPrototypeOf(value) : null;
    lengthDescriptor = isArray && value !== null
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
  } catch {
    throw new Error(`${label} could not be inspected`);
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new Error(`${label} must be an ordinary array`);
  }
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maximumLength
  ) {
    throw new RangeError(`${label} exceeds its entry limit`);
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} could not be inspected`);
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) {
    throw new Error(`${label} must be dense and undecorated`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function observationLineageKey(observation: OrchestratorActivityObservation): string {
  const hasDeclaredLineage = observation.workItemId !== null
    || observation.attemptId !== null
    || observation.runId !== null
    || observation.responsibilityGeneration !== null;
  return stableJson([
    observation.workspace,
    observation.project,
    observation.provider,
    ...(hasDeclaredLineage
      ? [
          observation.workItemId,
          observation.attemptId,
          observation.runId,
          observation.responsibilityGeneration,
        ]
      : [observation.observationId]),
  ]);
}

function isProviderAmbiguity(
  observation: OrchestratorActivityObservation,
): boolean {
  return observation.provider !== null
    && observation.providerLifecycle === "pending_reconciliation"
    && observation.activityState === "ambiguous";
}

function isExactProviderResolver(
  observation: OrchestratorActivityObservation,
  latestSupportId: string,
  latestSupportTime: string,
): boolean {
  return observation.activityState === "succeeded"
    && observation.providerLifecycle === "verified"
    && observation.causalPredecessorId === latestSupportId
    && observation.observedAt >= latestSupportTime;
}

function isMaterialProviderContradiction(
  observation: OrchestratorActivityObservation,
): boolean {
  return observation.activityState === "succeeded"
    || observation.activityState === "failed"
    || observation.activityState === "conflicted"
    || observation.providerLifecycle === "verified"
    || observation.providerLifecycle === "rejected";
}

function strongestAttentionClass(
  observations: readonly OrchestratorActivityObservation[],
): OrchestratorAttentionClass {
  let result: OrchestratorAttentionClass = "review";
  for (const observation of observations) {
    if (observation.attention.level === "incident") return "incident";
    if (observation.attention.level === "decision") result = "decision";
  }
  return result;
}

function compactEvidenceIds(
  observations: readonly OrchestratorActivityObservation[],
): readonly string[] {
  const ids = observations.map((entry) => entry.observationId);
  if (ids.length <= maximumRetainedEvidenceIds) return Object.freeze(ids);
  const half = maximumRetainedEvidenceIds / 2;
  return Object.freeze([
    ...ids.slice(0, half),
    ...ids.slice(ids.length - half),
  ]);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function compareObservations(
  left: OrchestratorActivityObservation,
  right: OrchestratorActivityObservation,
): number {
  const byTime = compareCodeUnits(left.observedAt, right.observedAt);
  return byTime !== 0
    ? byTime
    : compareCodeUnits(left.observationId, right.observationId);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
