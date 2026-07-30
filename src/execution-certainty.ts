import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const EXECUTION_CERTAINTY_SCHEMA_VERSION = 1 as const;
export const EXECUTION_CERTAINTY_STATES = [
  "not_dispatched",
  "remote_result_received",
  "local_failure_unclassified",
  "local_timeout_outcome_unknown",
] as const;
export const EXECUTION_PATHS = [
  "direct_mcp",
  "hosted_mcp",
  "runner_adapter",
  "provider_adapter",
] as const;
export const EXECUTION_OPERATION_KINDS = ["read", "mutation", "mixed", "unknown"] as const;
export const EXECUTION_DISPATCH_STATES = ["not_started", "possibly_started", "started"] as const;
export const EXECUTION_CANCELLATION_STATES = [
  "not_requested",
  "requested_delivery_unknown",
  "delivered",
  "observed_by_remote",
] as const;
export const EXECUTION_REMOTE_OUTCOMES = ["success", "application_error"] as const;
export const EXECUTION_LOCAL_FAILURE_CLASSES = [
  "argument_rejected",
  "binding_missing",
  "policy_denied",
  "approval_declined",
  "preparation_failed",
  "generation_mismatch",
  "timeout",
  "transport_failure",
  "result_serialization_failed",
  "unknown",
] as const;
export const EXECUTION_EFFECT_CERTAINTIES = [
  "not_executed_by_this_call_path",
  "remote_response_received",
  "may_still_run_or_may_have_committed",
  "unknown",
] as const;
export const EXECUTION_RECONCILIATION_REQUIREMENTS = [
  "none",
  "operation_receipt_or_provider_state",
] as const;
export const EXECUTION_NEXT_EVIDENCE = [
  "none",
  "remote_result",
  "operation_receipt_or_provider_state",
] as const;
export const EXECUTION_RECONCILIATION_SOURCES = [
  "operation_receipt",
  "provider_state",
  "remote_result",
] as const;
export const EXECUTION_RECONCILIATION_OUTCOMES = [
  "effect_recorded",
  "effect_absent",
  "remote_result_recovered",
  "still_unknown",
] as const;
export const EXECUTION_RESOLVED_EFFECTS = [
  "effect_recorded",
  "effect_absent_after_exact_reconciliation",
  "remote_response_received",
  "unknown",
] as const;

export type ExecutionCertaintyState = typeof EXECUTION_CERTAINTY_STATES[number];
export type ExecutionPath = typeof EXECUTION_PATHS[number];
export type ExecutionOperationKind = typeof EXECUTION_OPERATION_KINDS[number];
export type ExecutionDispatchState = typeof EXECUTION_DISPATCH_STATES[number];
export type ExecutionCancellationState = typeof EXECUTION_CANCELLATION_STATES[number];
export type ExecutionRemoteOutcome = typeof EXECUTION_REMOTE_OUTCOMES[number];
export type ExecutionLocalFailureClass = typeof EXECUTION_LOCAL_FAILURE_CLASSES[number];
export type ExecutionEffectCertainty = typeof EXECUTION_EFFECT_CERTAINTIES[number];
export type ExecutionReconciliationRequirement =
  typeof EXECUTION_RECONCILIATION_REQUIREMENTS[number];
export type ExecutionNextEvidence = typeof EXECUTION_NEXT_EVIDENCE[number];
export type ExecutionReconciliationSource = typeof EXECUTION_RECONCILIATION_SOURCES[number];
export type ExecutionReconciliationOutcome = typeof EXECUTION_RECONCILIATION_OUTCOMES[number];
export type ExecutionResolvedEffect = typeof EXECUTION_RESOLVED_EFFECTS[number];

export interface ExecutionRemoteResultEvidence {
  outcome: ExecutionRemoteOutcome;
  resultIdentity: string | null;
}

export interface ExecutionCertaintyEvidence {
  dispatchState: ExecutionDispatchState;
  cancellationState: ExecutionCancellationState;
  remoteResult: ExecutionRemoteResultEvidence | null;
  localFailureClass: ExecutionLocalFailureClass | null;
}

export interface ExecutionCertaintyInput {
  workspace: string;
  project: string;
  executionPath: ExecutionPath;
  operation: string;
  operationKind: ExecutionOperationKind;
  operationRef: string;
  requestFingerprint: string;
  authorityFingerprint: string;
  runGeneration: number;
  observedAt: string;
  evidence: ExecutionCertaintyEvidence;
}

export interface ExecutionCertaintyProjection {
  state: ExecutionCertaintyState;
  effectCertainty: ExecutionEffectCertainty;
  remoteResultReceived: boolean;
  reconciliationRequired: ExecutionReconciliationRequirement;
  replayAuthorization: "not_authorized";
  nextEvidence: ExecutionNextEvidence;
}

export interface ExecutionCertaintyReceipt extends ExecutionCertaintyInput {
  schemaVersion: typeof EXECUTION_CERTAINTY_SCHEMA_VERSION;
  certainty: ExecutionCertaintyProjection;
  receiptFingerprint: string;
}

export interface ExecutionReconciliationInput {
  resolvedAt: string;
  source: ExecutionReconciliationSource;
  outcome: ExecutionReconciliationOutcome;
  evidenceFingerprint: string;
}

export interface ExecutionReconciliationRecord {
  schemaVersion: 1;
  originalReceiptFingerprint: string;
  operationRef: string;
  requestFingerprint: string;
  authorityFingerprint: string;
  runGeneration: number;
  resolvedAt: string;
  source: ExecutionReconciliationSource;
  outcome: ExecutionReconciliationOutcome;
  evidenceFingerprint: string;
  resolution: {
    effect: ExecutionResolvedEffect;
    status: "resolved" | "required";
    replayAuthorization: "not_authorized";
    nextEvidence: "none" | "continue_reconciliation";
  };
  reconciliationFingerprint: string;
}

const preDispatchFailures = new Set<ExecutionLocalFailureClass>([
  "argument_rejected",
  "binding_missing",
  "policy_denied",
  "approval_declined",
  "preparation_failed",
  "generation_mismatch",
]);

export function createExecutionCertaintyReceipt(input: unknown): ExecutionCertaintyReceipt {
  const parsed = parseExecutionCertaintyInput(input);
  const certainty = deriveCertainty(parsed);
  const withoutFingerprint = {
    schemaVersion: EXECUTION_CERTAINTY_SCHEMA_VERSION,
    ...parsed,
    certainty,
  };
  return deepFreeze({
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

export function parseExecutionCertaintyReceipt(input: unknown): ExecutionCertaintyReceipt {
  const record = requireRecord(input, "Execution certainty receipt");
  rejectUnknownKeys(record, [
    "schemaVersion",
    "workspace",
    "project",
    "executionPath",
    "operation",
    "operationKind",
    "operationRef",
    "requestFingerprint",
    "authorityFingerprint",
    "runGeneration",
    "observedAt",
    "evidence",
    "certainty",
    "receiptFingerprint",
  ], "Execution certainty receipt");
  if (record.schemaVersion !== EXECUTION_CERTAINTY_SCHEMA_VERSION) {
    throw new Error("Execution certainty receipt schema version is unsupported");
  }

  const expected = createExecutionCertaintyReceipt(record);
  const certainty = parseCertaintyProjection(record.certainty);
  if (stableJson(certainty) !== stableJson(expected.certainty)) {
    throw new Error("Execution certainty projection does not match its evidence");
  }
  const receiptFingerprint = sha256(record.receiptFingerprint, "Execution certainty receipt fingerprint");
  if (receiptFingerprint !== expected.receiptFingerprint) {
    throw new Error("Execution certainty receipt fingerprint does not match its contents");
  }
  return expected;
}

export function reconcileExecutionCertainty(
  receiptInput: unknown,
  resolutionInput: unknown,
): ExecutionReconciliationRecord {
  const receipt = parseExecutionCertaintyReceipt(receiptInput);
  if (receipt.certainty.reconciliationRequired === "none") {
    throw new Error("Execution certainty receipt does not require reconciliation");
  }
  const resolution = parseReconciliationInput(resolutionInput);
  if (resolution.resolvedAt < receipt.observedAt) {
    throw new Error("Execution reconciliation cannot precede the original observation");
  }
  validateReconciliationPair(resolution.source, resolution.outcome);

  const effect = resolvedEffect(resolution.outcome);
  const status = resolution.outcome === "still_unknown" ? "required" : "resolved";
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    originalReceiptFingerprint: receipt.receiptFingerprint,
    operationRef: receipt.operationRef,
    requestFingerprint: receipt.requestFingerprint,
    authorityFingerprint: receipt.authorityFingerprint,
    runGeneration: receipt.runGeneration,
    ...resolution,
    resolution: {
      effect,
      status,
      replayAuthorization: "not_authorized" as const,
      nextEvidence: status === "required" ? "continue_reconciliation" as const : "none" as const,
    },
  };
  return deepFreeze({
    ...withoutFingerprint,
    reconciliationFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

export function parseExecutionReconciliationRecord(input: unknown): ExecutionReconciliationRecord {
  const record = requireRecord(input, "Execution reconciliation record");
  rejectUnknownKeys(record, [
    "schemaVersion",
    "originalReceiptFingerprint",
    "operationRef",
    "requestFingerprint",
    "authorityFingerprint",
    "runGeneration",
    "resolvedAt",
    "source",
    "outcome",
    "evidenceFingerprint",
    "resolution",
    "reconciliationFingerprint",
  ], "Execution reconciliation record");
  if (record.schemaVersion !== 1) {
    throw new Error("Execution reconciliation record schema version is unsupported");
  }
  const resolution = requireRecord(record.resolution, "Execution reconciliation projection");
  rejectUnknownKeys(
    resolution,
    ["effect", "status", "replayAuthorization", "nextEvidence"],
    "Execution reconciliation projection",
  );
  const parsed: Omit<ExecutionReconciliationRecord, "reconciliationFingerprint"> = {
    schemaVersion: 1,
    originalReceiptFingerprint: sha256(
      record.originalReceiptFingerprint,
      "Original execution receipt fingerprint",
    ),
    operationRef: boundedIdentifier(record.operationRef, "Execution operation reference", 160),
    requestFingerprint: sha256(record.requestFingerprint, "Execution request fingerprint"),
    authorityFingerprint: sha256(record.authorityFingerprint, "Execution authority fingerprint"),
    runGeneration: positiveInteger(record.runGeneration, "Execution run generation"),
    resolvedAt: canonicalTimestamp(record.resolvedAt, "Execution reconciliation time"),
    source: closedValue(
      record.source,
      EXECUTION_RECONCILIATION_SOURCES,
      "Execution reconciliation source",
    ),
    outcome: closedValue(
      record.outcome,
      EXECUTION_RECONCILIATION_OUTCOMES,
      "Execution reconciliation outcome",
    ),
    evidenceFingerprint: sha256(
      record.evidenceFingerprint,
      "Execution reconciliation evidence fingerprint",
    ),
    resolution: {
      effect: closedValue(
        resolution.effect,
        EXECUTION_RESOLVED_EFFECTS,
        "Execution resolved effect",
      ),
      status: closedValue(
        resolution.status,
        ["resolved", "required"] as const,
        "Execution reconciliation status",
      ),
      replayAuthorization: closedValue(
        resolution.replayAuthorization,
        ["not_authorized"] as const,
        "Execution replay authorization",
      ),
      nextEvidence: closedValue(
        resolution.nextEvidence,
        ["none", "continue_reconciliation"] as const,
        "Execution reconciliation next evidence",
      ),
    },
  };
  validateReconciliationPair(parsed.source, parsed.outcome);
  const expectedResolution = {
    effect: resolvedEffect(parsed.outcome),
    status: parsed.outcome === "still_unknown" ? "required" as const : "resolved" as const,
    replayAuthorization: "not_authorized" as const,
    nextEvidence: parsed.outcome === "still_unknown"
      ? "continue_reconciliation" as const
      : "none" as const,
  };
  if (stableJson(parsed.resolution) !== stableJson(expectedResolution)) {
    throw new Error("Execution reconciliation projection does not match its evidence");
  }
  const expectedFingerprint = fingerprintCanonicalRequest(parsed);
  const reconciliationFingerprint = sha256(
    record.reconciliationFingerprint,
    "Execution reconciliation fingerprint",
  );
  if (reconciliationFingerprint !== expectedFingerprint) {
    throw new Error("Execution reconciliation fingerprint does not match its contents");
  }
  return deepFreeze({ ...parsed, reconciliationFingerprint });
}

function parseExecutionCertaintyInput(input: unknown): ExecutionCertaintyInput {
  const record = requireRecord(input, "Execution certainty input");
  const allowed = [
    "schemaVersion",
    "workspace",
    "project",
    "executionPath",
    "operation",
    "operationKind",
    "operationRef",
    "requestFingerprint",
    "authorityFingerprint",
    "runGeneration",
    "observedAt",
    "evidence",
    "certainty",
    "receiptFingerprint",
  ];
  rejectUnknownKeys(record, allowed, "Execution certainty input");
  const evidence = parseEvidence(record.evidence);
  const parsed: ExecutionCertaintyInput = {
    workspace: boundedSlug(record.workspace, "Execution workspace", 80),
    project: boundedSlug(record.project, "Execution project", 80),
    executionPath: closedValue(record.executionPath, EXECUTION_PATHS, "Execution path"),
    operation: boundedIdentifier(record.operation, "Execution operation", 120),
    operationKind: closedValue(
      record.operationKind,
      EXECUTION_OPERATION_KINDS,
      "Execution operation kind",
    ),
    operationRef: boundedIdentifier(record.operationRef, "Execution operation reference", 160),
    requestFingerprint: sha256(record.requestFingerprint, "Execution request fingerprint"),
    authorityFingerprint: sha256(record.authorityFingerprint, "Execution authority fingerprint"),
    runGeneration: positiveInteger(record.runGeneration, "Execution run generation"),
    observedAt: canonicalTimestamp(record.observedAt, "Execution observation time"),
    evidence,
  };
  validateEvidence(parsed.evidence);
  return parsed;
}

function parseEvidence(input: unknown): ExecutionCertaintyEvidence {
  const record = requireRecord(input, "Execution certainty evidence");
  rejectUnknownKeys(
    record,
    ["dispatchState", "cancellationState", "remoteResult", "localFailureClass"],
    "Execution certainty evidence",
  );
  return {
    dispatchState: closedValue(
      record.dispatchState,
      EXECUTION_DISPATCH_STATES,
      "Execution dispatch state",
    ),
    cancellationState: closedValue(
      record.cancellationState,
      EXECUTION_CANCELLATION_STATES,
      "Execution cancellation state",
    ),
    remoteResult: record.remoteResult === null
      ? null
      : parseRemoteResult(record.remoteResult),
    localFailureClass: record.localFailureClass === null
      ? null
      : closedValue(
        record.localFailureClass,
        EXECUTION_LOCAL_FAILURE_CLASSES,
        "Execution local failure class",
      ),
  };
}

function parseRemoteResult(input: unknown): ExecutionRemoteResultEvidence {
  const record = requireRecord(input, "Execution remote result");
  rejectUnknownKeys(record, ["outcome", "resultIdentity"], "Execution remote result");
  return {
    outcome: closedValue(record.outcome, EXECUTION_REMOTE_OUTCOMES, "Execution remote outcome"),
    resultIdentity: record.resultIdentity === null
      ? null
      : boundedIdentifier(record.resultIdentity, "Execution remote result identity", 200),
  };
}

function parseCertaintyProjection(input: unknown): ExecutionCertaintyProjection {
  const record = requireRecord(input, "Execution certainty projection");
  rejectUnknownKeys(record, [
    "state",
    "effectCertainty",
    "remoteResultReceived",
    "reconciliationRequired",
    "replayAuthorization",
    "nextEvidence",
  ], "Execution certainty projection");
  if (typeof record.remoteResultReceived !== "boolean") {
    throw new Error("Execution remote-result flag must be boolean");
  }
  return {
    state: closedValue(record.state, EXECUTION_CERTAINTY_STATES, "Execution certainty state"),
    effectCertainty: closedValue(
      record.effectCertainty,
      EXECUTION_EFFECT_CERTAINTIES,
      "Execution effect certainty",
    ),
    remoteResultReceived: record.remoteResultReceived,
    reconciliationRequired: closedValue(
      record.reconciliationRequired,
      EXECUTION_RECONCILIATION_REQUIREMENTS,
      "Execution reconciliation requirement",
    ),
    replayAuthorization: closedValue(
      record.replayAuthorization,
      ["not_authorized"] as const,
      "Execution replay authorization",
    ),
    nextEvidence: closedValue(
      record.nextEvidence,
      EXECUTION_NEXT_EVIDENCE,
      "Execution next evidence",
    ),
  };
}

function parseReconciliationInput(input: unknown): ExecutionReconciliationInput {
  const record = requireRecord(input, "Execution reconciliation input");
  rejectUnknownKeys(
    record,
    ["resolvedAt", "source", "outcome", "evidenceFingerprint"],
    "Execution reconciliation input",
  );
  return {
    resolvedAt: canonicalTimestamp(record.resolvedAt, "Execution reconciliation time"),
    source: closedValue(
      record.source,
      EXECUTION_RECONCILIATION_SOURCES,
      "Execution reconciliation source",
    ),
    outcome: closedValue(
      record.outcome,
      EXECUTION_RECONCILIATION_OUTCOMES,
      "Execution reconciliation outcome",
    ),
    evidenceFingerprint: sha256(
      record.evidenceFingerprint,
      "Execution reconciliation evidence fingerprint",
    ),
  };
}

function validateEvidence(evidence: ExecutionCertaintyEvidence): void {
  if (evidence.remoteResult) {
    if (evidence.dispatchState !== "started") {
      throw new Error("A received remote result requires started dispatch");
    }
    if (evidence.localFailureClass !== null) {
      throw new Error("A received remote result cannot carry a local failure class");
    }
    return;
  }
  if (evidence.localFailureClass === null) {
    throw new Error("Execution evidence without a remote result requires a local failure class");
  }
  if (evidence.dispatchState === "not_started") {
    if (evidence.localFailureClass === "timeout") {
      throw new Error("A pre-dispatch execution cannot report a tools-call timeout");
    }
    if (evidence.cancellationState !== "not_requested") {
      throw new Error("A non-dispatched execution cannot report remote cancellation delivery");
    }
  }
  if (preDispatchFailures.has(evidence.localFailureClass) && evidence.dispatchState !== "not_started") {
    throw new Error("A known pre-dispatch failure cannot follow dispatch");
  }
  if (
    evidence.localFailureClass === "result_serialization_failed"
    && evidence.dispatchState !== "started"
  ) {
    throw new Error("Result serialization failure requires completed local dispatch");
  }
  if (
    evidence.cancellationState === "delivered"
    || evidence.cancellationState === "observed_by_remote"
  ) {
    if (evidence.dispatchState === "not_started") {
      throw new Error("Remote cancellation evidence requires possible dispatch");
    }
  }
}

function deriveCertainty(input: ExecutionCertaintyInput): ExecutionCertaintyProjection {
  const { evidence } = input;
  if (evidence.remoteResult) {
    return {
      state: "remote_result_received",
      effectCertainty: "remote_response_received",
      remoteResultReceived: true,
      reconciliationRequired: "none",
      replayAuthorization: "not_authorized",
      nextEvidence: "remote_result",
    };
  }
  if (evidence.dispatchState === "not_started") {
    return {
      state: "not_dispatched",
      effectCertainty: "not_executed_by_this_call_path",
      remoteResultReceived: false,
      reconciliationRequired: "none",
      replayAuthorization: "not_authorized",
      nextEvidence: "none",
    };
  }

  const mutationCouldExist = input.operationKind !== "read";
  const localTimeout = evidence.localFailureClass === "timeout";
  return {
    state: localTimeout ? "local_timeout_outcome_unknown" : "local_failure_unclassified",
    effectCertainty: localTimeout ? "may_still_run_or_may_have_committed" : "unknown",
    remoteResultReceived: false,
    reconciliationRequired: mutationCouldExist
      ? "operation_receipt_or_provider_state"
      : "none",
    replayAuthorization: "not_authorized",
    nextEvidence: mutationCouldExist
      ? "operation_receipt_or_provider_state"
      : "none",
  };
}

function validateReconciliationPair(
  source: ExecutionReconciliationSource,
  outcome: ExecutionReconciliationOutcome,
): void {
  if (outcome === "remote_result_recovered" && source !== "remote_result") {
    throw new Error("Recovered remote results require remote-result evidence");
  }
  if (source === "remote_result" && outcome !== "remote_result_recovered") {
    throw new Error("Remote-result evidence must resolve as a recovered remote result");
  }
  if (
    (outcome === "effect_recorded" || outcome === "effect_absent")
    && source === "remote_result"
  ) {
    throw new Error("Effect reconciliation requires an operation receipt or provider state");
  }
}

function resolvedEffect(outcome: ExecutionReconciliationOutcome): ExecutionResolvedEffect {
  switch (outcome) {
    case "effect_recorded":
      return "effect_recorded";
    case "effect_absent":
      return "effect_absent_after_exact_reconciliation";
    case "remote_result_recovered":
      return "remote_response_received";
    case "still_unknown":
      return "unknown";
  }
}

function boundedSlug(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)
  ) {
    throw new Error(`${label} must be a bounded lowercase slug`);
  }
  return normalized;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(normalized)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a canonical UTC timestamp`);
  const canonical = new Date(parsed).toISOString();
  const supplied = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  if (canonical !== supplied) throw new Error(`${label} must be a canonical UTC timestamp`);
  return canonical;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key)).sort();
  if (unknown.length) throw new Error(`${label} has unknown field ${unknown[0]}`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
