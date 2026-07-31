import { sha256, stableJson } from "./canonical-json.js";

export const synchronizationCompilerRevision = "synchronization-state/1" as const;

export type SynchronizationState =
  | "synchronized"
  | "pending_outbound"
  | "pending_reconciliation"
  | "degraded"
  | "stale"
  | "conflicted"
  | "unknown";

export type SynchronizationConflictType =
  | "delivery_identity_conflict"
  | "stale_source_observation"
  | "source_revision_divergence"
  | "ambiguous_outbound_operation"
  | "provider_readback_mismatch"
  | "competing_producer"
  | "missing_source_coverage"
  | "authority_generation_mismatch"
  | "projection_input_changed"
  | "unsupported_source_transition";

export type SynchronizationSourceOwner = "github" | "proofwake" | "stensibly";

export type SynchronizationNextAction =
  | "none"
  | "inspect_delivery_conflict"
  | "refresh_source_observation"
  | "reconcile_outbound_operation"
  | "verify_provider_readback"
  | "resolve_competing_producer"
  | "restore_source_coverage"
  | "renew_authority"
  | "refresh_evidence_projection"
  | "admit_supported_transition"
  | "await_provider_result"
  | "collect_missing_facts";

export interface SynchronizationSubjectV1 {
  owner: "github";
  repository: string;
  kind:
    | "issue"
    | "pull_request"
    | "commit"
    | "ref"
    | "workflow_run"
    | "deployment"
    | "release";
  id: string;
  revision: string;
}

export interface GitHubSourceFactV1 {
  id: string;
  deliveryId: string;
  revision: string;
  observedAt: string;
  freshnessUntil: string;
  status: "accepted" | "delivery_conflict" | "unsupported";
}

export interface ProofWakeEvidenceFactV1 {
  id: string;
  projectionFingerprint: string;
  sourceRevision: string;
  observedAt: string;
  freshnessUntil: string;
  status: "accepted" | "conflicted";
}

export interface StensiblyOperationFactV1 {
  id: string;
  state:
    | "reserved"
    | "dispatched"
    | "pending_reconciliation"
    | "verified"
    | "mismatched";
  targetRevision: string;
  providerRevision: string | null;
  observedAt: string;
}

export interface StensiblyAuthorityFactV1 {
  id: string;
  generation: number;
  currentGeneration: number;
  status: "active" | "expired" | "revoked";
  observedAt: string;
}

export interface StensiblyCoordinationFactV1 {
  id: string;
  inputFingerprint: string;
  status: "accepted" | "competing" | "degraded";
  observedAt: string;
}

export interface SynchronizationConflictInputV1 {
  type: SynchronizationConflictType;
  factIds: readonly string[];
  sourceOwners: readonly SynchronizationSourceOwner[];
}

export interface SynchronizationCompilerInputV1 {
  schemaVersion: 1;
  policyVersion: string;
  evaluatedAt: string;
  subject: SynchronizationSubjectV1;
  source: GitHubSourceFactV1 | null;
  evidence: ProofWakeEvidenceFactV1 | null;
  operation: StensiblyOperationFactV1 | null;
  authority: StensiblyAuthorityFactV1 | null;
  coordination: StensiblyCoordinationFactV1 | null;
  declaredConflicts: readonly SynchronizationConflictInputV1[];
}

export interface SynchronizationConflictV1 {
  type: SynchronizationConflictType;
  factIds: readonly string[];
  sourceOwners: readonly SynchronizationSourceOwner[];
}

export interface SynchronizationProjectionV1 {
  schemaVersion: 1;
  compilerRevision: typeof synchronizationCompilerRevision;
  policyVersion: string;
  evaluatedAt: string;
  subject: Readonly<SynchronizationSubjectV1>;
  state: SynchronizationState;
  conflicts: readonly Readonly<SynchronizationConflictV1>[];
  nextAction: SynchronizationNextAction;
  facts: Readonly<{
    sourceObservationId: string | null;
    evidenceProjectionId: string | null;
    operationId: string | null;
    authorityId: string | null;
    authorityGeneration: number | null;
    coordinationReceiptId: string | null;
  }>;
  inputFingerprint: string;
  projectionFingerprint: string;
  authorizesMutation: false;
  authorizesAuthority: false;
}

interface AdmittedInput {
  schemaVersion: 1;
  policyVersion: string;
  evaluatedAt: string;
  subject: SynchronizationSubjectV1;
  source: GitHubSourceFactV1 | null;
  evidence: ProofWakeEvidenceFactV1 | null;
  operation: StensiblyOperationFactV1 | null;
  authority: StensiblyAuthorityFactV1 | null;
  coordination: StensiblyCoordinationFactV1 | null;
  declaredConflicts: SynchronizationConflictV1[];
}

const conflictPriority: readonly SynchronizationConflictType[] = Object.freeze([
  "delivery_identity_conflict",
  "source_revision_divergence",
  "provider_readback_mismatch",
  "competing_producer",
  "authority_generation_mismatch",
  "projection_input_changed",
  "unsupported_source_transition",
  "ambiguous_outbound_operation",
  "stale_source_observation",
  "missing_source_coverage",
]);

const hardConflictTypes = new Set<SynchronizationConflictType>([
  "delivery_identity_conflict",
  "source_revision_divergence",
  "provider_readback_mismatch",
  "competing_producer",
  "authority_generation_mismatch",
  "projection_input_changed",
  "unsupported_source_transition",
]);

const realisticCredentialPattern = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;

export function compileSynchronizationState(
  input: unknown,
): SynchronizationProjectionV1 {
  const admitted = admitInput(input);
  const conflicts = collectConflicts(admitted);
  const state = deriveState(admitted, conflicts);
  const nextAction = deriveNextAction(state, conflicts);
  const facts = Object.freeze({
    sourceObservationId: admitted.source?.id ?? null,
    evidenceProjectionId: admitted.evidence?.id ?? null,
    operationId: admitted.operation?.id ?? null,
    authorityId: admitted.authority?.id ?? null,
    authorityGeneration: admitted.authority?.generation ?? null,
    coordinationReceiptId: admitted.coordination?.id ?? null,
  });
  const normalizedInput = normalizedInputValue(admitted);
  const inputFingerprint = sha256(stableJson(normalizedInput));
  const projectionBody = {
    schemaVersion: 1 as const,
    compilerRevision: synchronizationCompilerRevision,
    policyVersion: admitted.policyVersion,
    evaluatedAt: admitted.evaluatedAt,
    subject: admitted.subject,
    state,
    conflicts,
    nextAction,
    facts,
    inputFingerprint,
    authorizesMutation: false as const,
    authorizesAuthority: false as const,
  };
  return deepFreeze({
    ...projectionBody,
    projectionFingerprint: sha256(stableJson(projectionBody)),
  });
}

function admitInput(value: unknown): AdmittedInput {
  const input = exactRecord(
    value,
    [
      "schemaVersion",
      "policyVersion",
      "evaluatedAt",
      "subject",
      "source",
      "evidence",
      "operation",
      "authority",
      "coordination",
      "declaredConflicts",
    ],
    "Synchronization compiler input",
  );
  if (input.schemaVersion !== 1) {
    throw new TypeError("Synchronization compiler schemaVersion must equal 1");
  }
  const evaluatedAt = canonicalTimestamp(input.evaluatedAt, "Synchronization evaluation time");
  const admitted: AdmittedInput = {
    schemaVersion: 1,
    policyVersion: safeText(input.policyVersion, "Synchronization policy version", 120),
    evaluatedAt,
    subject: admitSubject(input.subject),
    source: input.source === null ? null : admitSource(input.source),
    evidence: input.evidence === null ? null : admitEvidence(input.evidence),
    operation: input.operation === null ? null : admitOperation(input.operation),
    authority: input.authority === null ? null : admitAuthority(input.authority),
    coordination: input.coordination === null
      ? null
      : admitCoordination(input.coordination),
    declaredConflicts: admitDeclaredConflicts(input.declaredConflicts),
  };
  for (const timestamp of factTimestamps(admitted)) {
    if (Date.parse(timestamp) > Date.parse(evaluatedAt)) {
      throw new TypeError("Synchronization fact time cannot be after evaluatedAt");
    }
  }
  return admitted;
}

function admitSubject(value: unknown): SynchronizationSubjectV1 {
  const subject = exactRecord(
    value,
    ["owner", "repository", "kind", "id", "revision"],
    "Synchronization subject",
  );
  if (subject.owner !== "github") {
    throw new TypeError("Synchronization subject owner must equal github");
  }
  return Object.freeze({
    owner: "github",
    repository: repository(subject.repository),
    kind: literal(
      subject.kind,
      ["issue", "pull_request", "commit", "ref", "workflow_run", "deployment", "release"],
      "Synchronization subject kind",
    ),
    id: safeText(subject.id, "Synchronization subject ID", 240),
    revision: safeText(subject.revision, "Synchronization subject revision", 240),
  });
}

function admitSource(value: unknown): GitHubSourceFactV1 {
  const fact = exactRecord(
    value,
    ["id", "deliveryId", "revision", "observedAt", "freshnessUntil", "status"],
    "GitHub source fact",
  );
  const observedAt = canonicalTimestamp(fact.observedAt, "GitHub source observation time");
  const freshnessUntil = canonicalTimestamp(
    fact.freshnessUntil,
    "GitHub source freshness time",
  );
  if (Date.parse(freshnessUntil) < Date.parse(observedAt)) {
    throw new TypeError("GitHub source freshness cannot precede observation time");
  }
  return Object.freeze({
    id: safeText(fact.id, "GitHub source fact ID", 240),
    deliveryId: safeText(fact.deliveryId, "GitHub delivery ID", 240),
    revision: safeText(fact.revision, "GitHub source revision", 240),
    observedAt,
    freshnessUntil,
    status: literal(
      fact.status,
      ["accepted", "delivery_conflict", "unsupported"],
      "GitHub source fact status",
    ),
  });
}

function admitEvidence(value: unknown): ProofWakeEvidenceFactV1 {
  const fact = exactRecord(
    value,
    ["id", "projectionFingerprint", "sourceRevision", "observedAt", "freshnessUntil", "status"],
    "ProofWake evidence fact",
  );
  const observedAt = canonicalTimestamp(fact.observedAt, "ProofWake evidence time");
  const freshnessUntil = canonicalTimestamp(
    fact.freshnessUntil,
    "ProofWake evidence freshness time",
  );
  if (Date.parse(freshnessUntil) < Date.parse(observedAt)) {
    throw new TypeError("ProofWake freshness cannot precede observation time");
  }
  return Object.freeze({
    id: safeText(fact.id, "ProofWake evidence fact ID", 240),
    projectionFingerprint: fingerprint(
      fact.projectionFingerprint,
      "ProofWake projection fingerprint",
    ),
    sourceRevision: safeText(fact.sourceRevision, "ProofWake source revision", 240),
    observedAt,
    freshnessUntil,
    status: literal(fact.status, ["accepted", "conflicted"], "ProofWake evidence status"),
  });
}

function admitOperation(value: unknown): StensiblyOperationFactV1 {
  const fact = exactRecord(
    value,
    ["id", "state", "targetRevision", "providerRevision", "observedAt"],
    "Stensibly operation fact",
  );
  const state = literal(
    fact.state,
    ["reserved", "dispatched", "pending_reconciliation", "verified", "mismatched"],
    "Stensibly operation state",
  );
  const providerRevision = fact.providerRevision === null
    ? null
    : safeText(fact.providerRevision, "Stensibly provider revision", 240);
  if ((state === "verified" || state === "mismatched") && providerRevision === null) {
    throw new TypeError("Settled Stensibly operation requires providerRevision");
  }
  if (
    (state === "reserved" || state === "dispatched" || state === "pending_reconciliation")
    && providerRevision !== null
  ) {
    throw new TypeError("Unsettled Stensibly operation cannot claim providerRevision");
  }
  return Object.freeze({
    id: safeText(fact.id, "Stensibly operation fact ID", 240),
    state,
    targetRevision: safeText(fact.targetRevision, "Stensibly target revision", 240),
    providerRevision,
    observedAt: canonicalTimestamp(fact.observedAt, "Stensibly operation time"),
  });
}

function admitAuthority(value: unknown): StensiblyAuthorityFactV1 {
  const fact = exactRecord(
    value,
    ["id", "generation", "currentGeneration", "status", "observedAt"],
    "Stensibly authority fact",
  );
  return Object.freeze({
    id: safeText(fact.id, "Stensibly authority fact ID", 240),
    generation: boundedInteger(fact.generation, "Stensibly authority generation", 1, 1_000_000),
    currentGeneration: boundedInteger(
      fact.currentGeneration,
      "Stensibly current authority generation",
      1,
      1_000_000,
    ),
    status: literal(fact.status, ["active", "expired", "revoked"], "Stensibly authority status"),
    observedAt: canonicalTimestamp(fact.observedAt, "Stensibly authority time"),
  });
}

function admitCoordination(value: unknown): StensiblyCoordinationFactV1 {
  const fact = exactRecord(
    value,
    ["id", "inputFingerprint", "status", "observedAt"],
    "Stensibly coordination fact",
  );
  return Object.freeze({
    id: safeText(fact.id, "Stensibly coordination fact ID", 240),
    inputFingerprint: fingerprint(
      fact.inputFingerprint,
      "Stensibly coordination input fingerprint",
    ),
    status: literal(
      fact.status,
      ["accepted", "competing", "degraded"],
      "Stensibly coordination status",
    ),
    observedAt: canonicalTimestamp(fact.observedAt, "Stensibly coordination time"),
  });
}

function admitDeclaredConflicts(value: unknown): SynchronizationConflictV1[] {
  const conflicts = denseArray(value, 20, "Synchronization declared conflicts")
    .map((entry) => admitConflict(entry));
  const normalized = conflicts.map(canonicalConflict).sort(compareConflict);
  const keys = new Set<string>();
  for (const conflict of normalized) {
    const key = stableJson(conflict);
    if (keys.has(key)) throw new TypeError("Synchronization declared conflict was duplicated");
    keys.add(key);
  }
  return normalized;
}

function admitConflict(value: unknown): SynchronizationConflictV1 {
  const conflict = exactRecord(
    value,
    ["type", "factIds", "sourceOwners"],
    "Synchronization conflict",
  );
  const type = literal(
    conflict.type,
    conflictPriority,
    "Synchronization conflict type",
  );
  const factIds = denseArray(conflict.factIds, 6, "Synchronization conflict fact IDs")
    .map((entry) => safeText(entry, "Synchronization conflict fact ID", 240));
  if (factIds.length === 0) {
    throw new TypeError("Synchronization conflict requires at least one fact ID");
  }
  const sourceOwners = denseArray(
    conflict.sourceOwners,
    3,
    "Synchronization conflict source owners",
  ).map((entry) => literal(
    entry,
    ["github", "proofwake", "stensibly"],
    "Synchronization conflict source owner",
  ));
  if (sourceOwners.length === 0) {
    throw new TypeError("Synchronization conflict requires at least one source owner");
  }
  return canonicalConflict({ type, factIds, sourceOwners });
}

function collectConflicts(admitted: AdmittedInput): SynchronizationConflictV1[] {
  const conflicts = admitted.declaredConflicts.map((entry) => canonicalConflict(entry));
  const push = (
    type: SynchronizationConflictType,
    factIds: readonly string[],
    sourceOwners: readonly SynchronizationSourceOwner[],
  ): void => {
    conflicts.push(canonicalConflict({ type, factIds, sourceOwners }));
  };
  const { source, evidence, operation, authority, coordination, subject } = admitted;
  const hasAnyFact = source !== null
    || evidence !== null
    || operation !== null
    || authority !== null
    || coordination !== null;

  if (hasAnyFact && source === null) {
    push("missing_source_coverage", [subject.id], ["github"]);
  }
  if (source !== null) {
    if (source.status === "delivery_conflict") {
      push("delivery_identity_conflict", [source.id, source.deliveryId], ["github"]);
    }
    if (source.status === "unsupported") {
      push("unsupported_source_transition", [source.id], ["github"]);
    }
    if (source.revision !== subject.revision) {
      push("source_revision_divergence", [source.id, subject.id], ["github"]);
    }
    if (Date.parse(source.freshnessUntil) < Date.parse(admitted.evaluatedAt)) {
      push("stale_source_observation", [source.id], ["github"]);
    }
  }

  if (hasAnyFact && evidence === null) {
    push("missing_source_coverage", [subject.id], ["proofwake"]);
  }
  if (evidence !== null) {
    if (evidence.status === "conflicted") {
      push("projection_input_changed", [evidence.id], ["proofwake"]);
    }
    if (evidence.sourceRevision !== subject.revision) {
      push("projection_input_changed", [evidence.id, subject.id], ["proofwake", "github"]);
    }
    if (Date.parse(evidence.freshnessUntil) < Date.parse(admitted.evaluatedAt)) {
      push("stale_source_observation", [evidence.id], ["proofwake"]);
    }
  }

  if (operation !== null) {
    if (operation.targetRevision !== subject.revision) {
      push("source_revision_divergence", [operation.id, subject.id], ["stensibly", "github"]);
    }
    if (operation.state === "pending_reconciliation") {
      push("ambiguous_outbound_operation", [operation.id], ["stensibly", "github"]);
    }
    if (
      operation.state === "mismatched"
      || (operation.state === "verified" && operation.providerRevision !== subject.revision)
    ) {
      push("provider_readback_mismatch", [operation.id, subject.id], ["stensibly", "github"]);
    }
  }

  if (hasAnyFact && authority === null) {
    push("missing_source_coverage", [subject.id], ["stensibly"]);
  }
  if (
    authority !== null
    && (
      authority.status !== "active"
      || authority.generation !== authority.currentGeneration
    )
  ) {
    push("authority_generation_mismatch", [authority.id], ["stensibly"]);
  }

  if (hasAnyFact && coordination === null) {
    push("missing_source_coverage", [subject.id], ["stensibly"]);
  }
  if (coordination?.status === "competing") {
    push("competing_producer", [coordination.id], ["stensibly"]);
  }
  if (coordination?.status === "degraded") {
    push("missing_source_coverage", [coordination.id], ["stensibly"]);
  }

  const normalized = conflicts.map(canonicalConflict).sort(compareConflict);
  const unique: SynchronizationConflictV1[] = [];
  let prior: string | null = null;
  for (const conflict of normalized) {
    const key = stableJson(conflict);
    if (key !== prior) unique.push(conflict);
    prior = key;
  }
  return Object.freeze(unique.map((conflict) => deepFreeze(conflict))) as unknown as SynchronizationConflictV1[];
}

function deriveState(
  admitted: AdmittedInput,
  conflicts: readonly SynchronizationConflictV1[],
): SynchronizationState {
  const conflictTypes = new Set(conflicts.map((conflict) => conflict.type));
  if ([...conflictTypes].some((type) => hardConflictTypes.has(type))) {
    return "conflicted";
  }
  if (conflictTypes.has("ambiguous_outbound_operation")) {
    return "pending_reconciliation";
  }
  if (admitted.operation?.state === "reserved" || admitted.operation?.state === "dispatched") {
    return "pending_outbound";
  }
  if (conflictTypes.has("stale_source_observation")) return "stale";
  if (conflictTypes.has("missing_source_coverage")) return "degraded";
  if (
    admitted.source === null
    && admitted.evidence === null
    && admitted.operation === null
    && admitted.authority === null
    && admitted.coordination === null
  ) {
    return "unknown";
  }
  if (
    admitted.source?.status === "accepted"
    && admitted.evidence?.status === "accepted"
    && admitted.authority?.status === "active"
    && admitted.authority.generation === admitted.authority.currentGeneration
    && admitted.coordination?.status === "accepted"
    && (admitted.operation === null || admitted.operation.state === "verified")
  ) {
    return "synchronized";
  }
  return "unknown";
}

function deriveNextAction(
  state: SynchronizationState,
  conflicts: readonly SynchronizationConflictV1[],
): SynchronizationNextAction {
  const types = new Set(conflicts.map((conflict) => conflict.type));
  for (const type of conflictPriority) {
    if (!types.has(type)) continue;
    switch (type) {
      case "delivery_identity_conflict": return "inspect_delivery_conflict";
      case "stale_source_observation": return "refresh_source_observation";
      case "source_revision_divergence": return "refresh_source_observation";
      case "ambiguous_outbound_operation": return "reconcile_outbound_operation";
      case "provider_readback_mismatch": return "verify_provider_readback";
      case "competing_producer": return "resolve_competing_producer";
      case "missing_source_coverage": return "restore_source_coverage";
      case "authority_generation_mismatch": return "renew_authority";
      case "projection_input_changed": return "refresh_evidence_projection";
      case "unsupported_source_transition": return "admit_supported_transition";
    }
  }
  if (state === "pending_outbound") return "await_provider_result";
  if (state === "unknown") return "collect_missing_facts";
  return "none";
}

function normalizedInputValue(admitted: AdmittedInput): unknown {
  return {
    schemaVersion: admitted.schemaVersion,
    policyVersion: admitted.policyVersion,
    evaluatedAt: admitted.evaluatedAt,
    subject: admitted.subject,
    source: admitted.source,
    evidence: admitted.evidence,
    operation: admitted.operation,
    authority: admitted.authority,
    coordination: admitted.coordination,
    declaredConflicts: admitted.declaredConflicts,
  };
}

function canonicalConflict(
  conflict: SynchronizationConflictV1,
): SynchronizationConflictV1 {
  return Object.freeze({
    type: conflict.type,
    factIds: Object.freeze([...new Set(conflict.factIds)].sort(codeUnitCompare)),
    sourceOwners: Object.freeze(
      [...new Set(conflict.sourceOwners)].sort(codeUnitCompare),
    ),
  });
}

function compareConflict(
  left: SynchronizationConflictV1,
  right: SynchronizationConflictV1,
): number {
  const priority = conflictPriority.indexOf(left.type) - conflictPriority.indexOf(right.type);
  if (priority !== 0) return priority;
  return codeUnitCompare(stableJson(left), stableJson(right));
}

function factTimestamps(admitted: AdmittedInput): string[] {
  return [
    admitted.source?.observedAt,
    admitted.evidence?.observedAt,
    admitted.operation?.observedAt,
    admitted.authority?.observedAt,
    admitted.coordination?.observedAt,
  ].filter((value): value is string => value !== undefined);
}

function repository(value: unknown): string {
  const text = safeText(value, "Synchronization repository", 200);
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?$/.test(text)) {
    throw new TypeError("Synchronization repository must be an exact lowercase owner/name");
  }
  return text;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const text = safeText(value, label, 40);
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return text;
}

function safeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must use exact control-free bytes`);
  }
  if (realisticCredentialPattern.test(value)) {
    throw new TypeError(`${label} must not contain a credential value or reference`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${label} was invalid`);
  }
  return value as Values[number];
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain or null prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
    throw new TypeError(`${label} fields were invalid`);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }
  const keys = Object.keys(value);
  if (keys.length !== value.length) {
    throw new TypeError(`${label} must be dense and undecorated`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) {
      throw new TypeError(`${label} must be dense and undecorated`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} entries must be enumerable data properties`);
    }
  }
  return value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
