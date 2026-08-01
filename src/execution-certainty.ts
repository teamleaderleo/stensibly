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

const realisticCredentialPattern =
  /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;

export function createExecutionCertaintyReceipt(input: unknown): ExecutionCertaintyReceipt {
  const parsed = parseExecutionCertaintyInput(input);
  const certainty = deriveCertainty(parsed);
  const unsigned = {
    schemaVersion: EXECUTION_CERTAINTY_SCHEMA_VERSION,
    ...parsed,
    certainty,
  };
  return deepFreeze({
    ...unsigned,
    receiptFingerprint: fingerprintCanonicalRequest(unsigned),
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

  const expected = createExecutionCertaintyReceipt({
    workspace: record.workspace,
    project: record.project,
    executionPath: record.executionPath,
    operation: record.operation,
    operationKind: record.operationKind,
    operationRef: record.operationRef,
    requestFingerprint: record.requestFingerprint,
    authorityFingerprint: record.authorityFingerprint,
    runGeneration: record.runGeneration,
    observedAt: record.observedAt,
    evidence: record.evidence,
  });
  const certainty = parseCertaintyProjection(record.certainty);
  if (stableJson(certainty) !== stableJson(expected.certainty)) {
    throw new Error("Execution certainty projection does not match its evidence");
  }
  const receiptFingerprint = sha256(
    record.receiptFingerprint,
    "Execution certainty receipt fingerprint",
  );
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

  const status: "required" | "resolved" =
    resolution.outcome === "still_unknown" ? "required" : "resolved";
  const unsigned = {
    schemaVersion: 1 as const,
    originalReceiptFingerprint: receipt.receiptFingerprint,
    operationRef: receipt.operationRef,
    requestFingerprint: receipt.requestFingerprint,
    authorityFingerprint: receipt.authorityFingerprint,
    runGeneration: receipt.runGeneration,
    ...resolution,
    resolution: {
      effect: resolvedEffect(resolution.outcome),
      status,
      replayAuthorization: "not_authorized" as const,
      nextEvidence:
        status === "required" ? "continue_reconciliation" as const : "none" as const,
    },
  };
  return deepFreeze({
    ...unsigned,
    reconciliationFingerprint: fingerprintCanonicalRequest(unsigned),
  });
}

export function parseExecutionReconciliationRecord(
  input: unknown,
  receiptInput?: unknown,
): ExecutionReconciliationRecord {
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

  const projection = requireRecord(
    record.resolution,
    "Execution reconciliation projection",
  );
  rejectUnknownKeys(
    projection,
    ["effect", "status", "replayAuthorization", "nextEvidence"],
    "Execution reconciliation projection",
  );

  const parsed: Omit<ExecutionReconciliationRecord, "reconciliationFingerprint"> = {
    schemaVersion: 1,
    originalReceiptFingerprint: sha256(
      record.originalReceiptFingerprint,
      "Original execution receipt fingerprint",
    ),
    operationRef: boundedIdentifier(
      record.operationRef,
      "Execution operation reference",
      160,
    ),
    requestFingerprint: sha256(
      record.requestFingerprint,
      "Execution request fingerprint",
    ),
    authorityFingerprint: sha256(
      record.authorityFingerprint,
      "Execution authority fingerprint",
    ),
    runGeneration: positiveInteger(
      record.runGeneration,
      "Execution run generation",
    ),
    resolvedAt: canonicalTimestamp(
      record.resolvedAt,
      "Execution reconciliation time",
    ),
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
        projection.effect,
        EXECUTION_RESOLVED_EFFECTS,
        "Execution resolved effect",
      ),
      status: closedValue(
        projection.status,
        ["resolved", "required"] as const,
        "Execution reconciliation status",
      ),
      replayAuthorization: closedValue(
        projection.replayAuthorization,
        ["not_authorized"] as const,
        "Execution replay authorization",
      ),
      nextEvidence: closedValue(
        projection.nextEvidence,
        ["none", "continue_reconciliation"] as const,
        "Execution reconciliation next evidence",
      ),
    },
  };
  validateReconciliationPair(parsed.source, parsed.outcome);

  const expectedResolution: ExecutionReconciliationRecord["resolution"] = {
    effect: resolvedEffect(parsed.outcome),
    status: parsed.outcome === "still_unknown" ? "required" : "resolved",
    replayAuthorization: "not_authorized",
    nextEvidence:
      parsed.outcome === "still_unknown" ? "continue_reconciliation" : "none",
  };
  if (stableJson(parsed.resolution) !== stableJson(expectedResolution)) {
    throw new Error("Execution reconciliation projection does not match its evidence");
  }

  if (receiptInput !== undefined) {
    const receipt = parseExecutionCertaintyReceipt(receiptInput);
    if (receipt.certainty.reconciliationRequired === "none") {
      throw new Error(
        "Execution certainty receipt does not require reconciliation",
      );
    }
    if (
      parsed.originalReceiptFingerprint !== receipt.receiptFingerprint ||
      parsed.operationRef !== receipt.operationRef ||
      parsed.requestFingerprint !== receipt.requestFingerprint ||
      parsed.authorityFingerprint !== receipt.authorityFingerprint ||
      parsed.runGeneration !== receipt.runGeneration
    ) {
      throw new Error("Execution reconciliation record is bound to a different receipt");
    }
    if (parsed.resolvedAt < receipt.observedAt) {
      throw new Error("Execution reconciliation cannot precede the original observation");
    }
  }

  const reconciliationFingerprint = sha256(
    record.reconciliationFingerprint,
    "Execution reconciliation fingerprint",
  );
  if (reconciliationFingerprint !== fingerprintCanonicalRequest(parsed)) {
    throw new Error("Execution reconciliation fingerprint does not match its contents");
  }
  return deepFreeze({ ...parsed, reconciliationFingerprint });
}

function parseExecutionCertaintyInput(input: unknown): ExecutionCertaintyInput {
  const record = requireRecord(input, "Execution certainty input");
  rejectUnknownKeys(record, [
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
  ], "Execution certainty input");

  const parsed: ExecutionCertaintyInput = {
    workspace: boundedSlug(record.workspace, "Execution workspace", 80),
    project: boundedSlug(record.project, "Execution project", 80),
    executionPath: closedValue(
      record.executionPath,
      EXECUTION_PATHS,
      "Execution path",
    ),
    operation: boundedIdentifier(
      record.operation,
      "Execution operation",
      120,
    ),
    operationKind: closedValue(
      record.operationKind,
      EXECUTION_OPERATION_KINDS,
      "Execution operation kind",
    ),
    operationRef: boundedIdentifier(
      record.operationRef,
      "Execution operation reference",
      160,
    ),
    requestFingerprint: sha256(
      record.requestFingerprint,
      "Execution request fingerprint",
    ),
    authorityFingerprint: sha256(
      record.authorityFingerprint,
      "Execution authority fingerprint",
    ),
    runGeneration: positiveInteger(
      record.runGeneration,
      "Execution run generation",
    ),
    observedAt: canonicalTimestamp(
      record.observedAt,
      "Execution observation time",
    ),
    evidence: parseEvidence(record.evidence),
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
    remoteResult:
      record.remoteResult === null ? null : parseRemoteResult(record.remoteResult),
    localFailureClass:
      record.localFailureClass === null
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
  rejectUnknownKeys(
    record,
    ["outcome", "resultIdentity"],
    "Execution remote result",
  );
  return {
    outcome: closedValue(
      record.outcome,
      EXECUTION_REMOTE_OUTCOMES,
      "Execution remote outcome",
    ),
    resultIdentity:
      record.resultIdentity === null
        ? null
        : boundedIdentifier(
            record.resultIdentity,
            "Execution remote result identity",
            200,
          ),
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
    state: closedValue(
      record.state,
      EXECUTION_CERTAINTY_STATES,
      "Execution certainty state",
    ),
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
    resolvedAt: canonicalTimestamp(
      record.resolvedAt,
      "Execution reconciliation time",
    ),
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
  if (evidence.remoteResult !== null) {
    if (evidence.dispatchState !== "started") {
      throw new Error("A received remote result requires started dispatch");
    }
    if (evidence.localFailureClass !== null) {
      throw new Error("A received remote result cannot carry a local failure class");
    }
    return;
  }

  if (evidence.localFailureClass === null) {
    throw new Error(
      "Execution evidence without a remote result requires a local failure class",
    );
  }
  if (evidence.dispatchState === "not_started") {
    if (evidence.localFailureClass === "timeout") {
      throw new Error("A pre-dispatch execution cannot report a tools-call timeout");
    }
    if (evidence.cancellationState !== "not_requested") {
      throw new Error(
        "A non-dispatched execution cannot report remote cancellation delivery",
      );
    }
  }
  if (
    preDispatchFailures.has(evidence.localFailureClass) &&
    evidence.dispatchState !== "not_started"
  ) {
    throw new Error("A known pre-dispatch failure cannot follow dispatch");
  }
  if (
    evidence.localFailureClass === "result_serialization_failed" &&
    evidence.dispatchState !== "started"
  ) {
    throw new Error(
      "Result serialization failure requires completed local dispatch",
    );
  }
}

function deriveCertainty(input: ExecutionCertaintyInput): ExecutionCertaintyProjection {
  const { evidence } = input;
  if (evidence.remoteResult !== null) {
    return {
      state: "remote_result_received",
      effectCertainty: "remote_response_received",
      remoteResultReceived: true,
      reconciliationRequired: "none",
      replayAuthorization: "not_authorized",
      nextEvidence: "none",
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

  const reconciliationRequired =
    input.operationKind === "read"
      ? "none"
      : "operation_receipt_or_provider_state";
  const localTimeout = evidence.localFailureClass === "timeout";
  return {
    state:
      localTimeout
        ? "local_timeout_outcome_unknown"
        : "local_failure_unclassified",
    effectCertainty:
      localTimeout
        ? "may_still_run_or_may_have_committed"
        : "unknown",
    remoteResultReceived: false,
    reconciliationRequired,
    replayAuthorization: "not_authorized",
    nextEvidence:
      reconciliationRequired === "none"
        ? "none"
        : "operation_receipt_or_provider_state",
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
    throw new Error(
      "Remote-result evidence must resolve as a recovered remote result",
    );
  }
}

function resolvedEffect(
  outcome: ExecutionReconciliationOutcome,
): ExecutionResolvedEffect {
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
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(value) ||
    realisticCredentialPattern.test(value)
  ) {
    throw new Error(`${label} must be a bounded lowercase slug`);
  }
  return value;
}

function boundedIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(value) ||
    realisticCredentialPattern.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
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
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
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
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new Error(
        `${label} must contain only enumerable data properties`,
      );
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(
        `${label} must contain only enumerable data properties`,
      );
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .sort(codeUnitCompare);
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field ${unknown[0]}`);
  }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  return fingerprintCanonicalRequest(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
