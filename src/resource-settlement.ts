import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const RESOURCE_SETTLEMENT_SCHEMA_VERSION = 1 as const;
export const RESOURCE_SETTLEMENT_OWNER_KINDS = [
  "transport",
  "worker",
  "artifact",
  "task",
  "lease",
  "provider_resource",
  "generation",
] as const;
export const RESOURCE_SETTLEMENT_OWNER_STATES = [
  "pending",
  "settled_success",
  "settled_failure",
  "reconciliation_required",
  "publication_fenced",
] as const;
export const RESOURCE_SETTLEMENT_FAILURE_CLASSES = [
  "cancelled",
  "timeout",
  "transport_failure",
  "worker_failure",
  "artifact_failure",
  "provider_failure",
  "cleanup_failure",
  "unknown_outcome",
] as const;

export type ResourceSettlementOwnerKind = typeof RESOURCE_SETTLEMENT_OWNER_KINDS[number];
export type ResourceSettlementOwnerState = typeof RESOURCE_SETTLEMENT_OWNER_STATES[number];
export type ResourceSettlementFailureClass = typeof RESOURCE_SETTLEMENT_FAILURE_CLASSES[number];
export type ResourceSettlementPhase = "open" | "closing" | "settled_success" | "settled_failure";
export type ResourceSettlementDisposition = "reusable" | "retired" | "reconciliation_hold";
export type ResourceSettlementFailureMode = "continue_through_error" | "stop_after_failure";

export interface ResourceSettlementOwnerInput {
  id: string;
  kind: ResourceSettlementOwnerKind;
  generation: number;
  attempted: boolean;
  state: ResourceSettlementOwnerState;
  attemptedAt: string | null;
  settledAt: string | null;
  failureClass: ResourceSettlementFailureClass | null;
  reconciliationRequired: boolean;
  canPublishLate: boolean;
  outputFingerprint: string | null;
  publicationFenceFingerprint: string | null;
}

export interface ResourceSettlementInput {
  workspace: string;
  project: string;
  resourceId: string;
  resourceKind: string;
  generation: number;
  operationRef: string;
  policyVersion: string;
  failureMode: ResourceSettlementFailureMode;
  admissionState: "open" | "closed";
  disposition: ResourceSettlementDisposition | null;
  openedAt: string;
  closingStartedAt: string | null;
  terminalAt: string | null;
  observedAt: string;
  owners: ResourceSettlementOwnerInput[];
}

export interface ResourceSettlementOwner extends ResourceSettlementOwnerInput {
  ownerKey: string;
}

export interface ResourceSettlementReceipt extends Omit<ResourceSettlementInput, "owners"> {
  schemaVersion: typeof RESOURCE_SETTLEMENT_SCHEMA_VERSION;
  phase: ResourceSettlementPhase;
  owners: ResourceSettlementOwner[];
  counts: {
    total: number;
    pending: number;
    settledSuccess: number;
    settledFailure: number;
    reconciliationRequired: number;
    publicationFenced: number;
  };
  successfulOutputs: Array<{ ownerKey: string; outputFingerprint: string }>;
  reconciliationOwnerKeys: string[];
  settlementRetryAuthorization: "not_authorized";
  receiptFingerprint: string;
}

export interface ResourceGenerationAdvanceDecision {
  allowed: boolean;
  currentGeneration: number;
  requestedGeneration: number;
  reason:
    | "next_generation_allowed"
    | "generation_must_increase_by_one"
    | "settlement_not_terminal"
    | "reconciliation_still_required";
  receiptFingerprint: string;
}

const terminalOwnerStates = new Set<ResourceSettlementOwnerState>([
  "settled_success",
  "settled_failure",
  "reconciliation_required",
  "publication_fenced",
]);

export function createResourceSettlementReceipt(input: unknown): ResourceSettlementReceipt {
  const parsed = parseInput(input);
  const phase = derivePhase(parsed);
  validateAggregate(parsed, phase);
  const owners = parsed.owners.map((owner) => ({
    ...owner,
    ownerKey: ownerKey(owner),
  }));
  const counts = {
    total: owners.length,
    pending: countState(owners, "pending"),
    settledSuccess: countState(owners, "settled_success"),
    settledFailure: countState(owners, "settled_failure"),
    reconciliationRequired: countState(owners, "reconciliation_required"),
    publicationFenced: countState(owners, "publication_fenced"),
  };
  const successfulOutputs = owners
    .filter((owner): owner is ResourceSettlementOwner & { outputFingerprint: string } => owner.outputFingerprint !== null)
    .map((owner) => ({ ownerKey: owner.ownerKey, outputFingerprint: owner.outputFingerprint }));
  const reconciliationOwnerKeys = owners
    .filter((owner) => owner.reconciliationRequired)
    .map((owner) => owner.ownerKey);
  const withoutFingerprint = {
    schemaVersion: RESOURCE_SETTLEMENT_SCHEMA_VERSION,
    workspace: parsed.workspace,
    project: parsed.project,
    resourceId: parsed.resourceId,
    resourceKind: parsed.resourceKind,
    generation: parsed.generation,
    operationRef: parsed.operationRef,
    policyVersion: parsed.policyVersion,
    failureMode: parsed.failureMode,
    admissionState: parsed.admissionState,
    disposition: parsed.disposition,
    openedAt: parsed.openedAt,
    closingStartedAt: parsed.closingStartedAt,
    terminalAt: parsed.terminalAt,
    observedAt: parsed.observedAt,
    phase,
    owners,
    counts,
    successfulOutputs,
    reconciliationOwnerKeys,
    settlementRetryAuthorization: "not_authorized" as const,
  };
  return deepFreeze({
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

export function parseResourceSettlementReceipt(input: unknown): ResourceSettlementReceipt {
  const record = requireRecord(input, "Resource settlement receipt");
  rejectUnknownKeys(record, [
    "schemaVersion",
    "workspace",
    "project",
    "resourceId",
    "resourceKind",
    "generation",
    "operationRef",
    "policyVersion",
    "failureMode",
    "admissionState",
    "disposition",
    "openedAt",
    "closingStartedAt",
    "terminalAt",
    "observedAt",
    "phase",
    "owners",
    "counts",
    "successfulOutputs",
    "reconciliationOwnerKeys",
    "settlementRetryAuthorization",
    "receiptFingerprint",
  ], "Resource settlement receipt");
  if (record.schemaVersion !== RESOURCE_SETTLEMENT_SCHEMA_VERSION) {
    throw new Error("Resource settlement receipt schema version is unsupported");
  }
  if (record.settlementRetryAuthorization !== "not_authorized") {
    throw new Error("Resource settlement receipt cannot authorize retry");
  }
  const owners = parseReceiptOwners(record.owners);
  const reconstructed = createResourceSettlementReceipt({
    workspace: record.workspace,
    project: record.project,
    resourceId: record.resourceId,
    resourceKind: record.resourceKind,
    generation: record.generation,
    operationRef: record.operationRef,
    policyVersion: record.policyVersion,
    failureMode: record.failureMode,
    admissionState: record.admissionState,
    disposition: record.disposition,
    openedAt: record.openedAt,
    closingStartedAt: record.closingStartedAt,
    terminalAt: record.terminalAt,
    observedAt: record.observedAt,
    owners: owners.map(({ ownerKey: _ownerKey, ...owner }) => owner),
  });
  const fingerprint = sha256(record.receiptFingerprint, "Resource settlement receipt fingerprint");
  if (fingerprint !== reconstructed.receiptFingerprint) {
    throw new Error("Resource settlement receipt fingerprint does not match its contents");
  }
  if (record.phase !== reconstructed.phase) throw new Error("Resource settlement phase is not derived correctly");
  const counts = parseReceiptCounts(record.counts);
  if (JSON.stringify(counts) !== JSON.stringify(reconstructed.counts)) {
    throw new Error("Resource settlement counts are not derived correctly");
  }
  const successfulOutputs = parseSuccessfulOutputs(record.successfulOutputs);
  if (JSON.stringify(successfulOutputs) !== JSON.stringify(reconstructed.successfulOutputs)) {
    throw new Error("Resource settlement outputs are not derived correctly");
  }
  const reconciliationOwnerKeys = parseOwnerKeys(
    record.reconciliationOwnerKeys,
    "Resource settlement reconciliation owner keys",
  );
  if (JSON.stringify(reconciliationOwnerKeys) !== JSON.stringify(reconstructed.reconciliationOwnerKeys)) {
    throw new Error("Resource settlement reconciliation owners are not derived correctly");
  }
  return reconstructed;
}

export function evaluateResourceGenerationAdvance(
  receiptInput: unknown,
  requestedGeneration: number,
): ResourceGenerationAdvanceDecision {
  const receipt = parseResourceSettlementReceipt(receiptInput);
  const requested = positiveInteger(requestedGeneration, "Requested generation");
  let allowed = false;
  let reason: ResourceGenerationAdvanceDecision["reason"];
  if (requested !== receipt.generation + 1) {
    reason = "generation_must_increase_by_one";
  } else if (receipt.phase !== "settled_success" && receipt.phase !== "settled_failure") {
    reason = "settlement_not_terminal";
  } else if (receipt.reconciliationOwnerKeys.length > 0 || receipt.disposition === "reconciliation_hold") {
    reason = "reconciliation_still_required";
  } else {
    allowed = true;
    reason = "next_generation_allowed";
  }
  return deepFreeze({
    allowed,
    currentGeneration: receipt.generation,
    requestedGeneration: requested,
    reason,
    receiptFingerprint: receipt.receiptFingerprint,
  });
}

export class AuthoritativeSettlementController<T> {
  #phase: ResourceSettlementPhase = "open";
  #completion: Promise<T> | null = null;

  get phase(): ResourceSettlementPhase {
    return this.#phase;
  }

  get admissionOpen(): boolean {
    return this.#phase === "open";
  }

  start(executor: () => Promise<T> | T): Promise<T> {
    if (this.#completion) return this.#completion;
    this.#phase = "closing";
    this.#completion = Promise.resolve()
      .then(executor)
      .then(
        (value) => {
          this.#phase = "settled_success";
          return value;
        },
        (error: unknown) => {
          this.#phase = "settled_failure";
          throw error;
        },
      );
    return this.#completion;
  }

  wait(signal?: AbortSignal): Promise<T> {
    if (!this.#completion) throw new Error("Authoritative settlement has not started");
    if (!signal) return this.#completion;
    if (signal.aborted) return Promise.reject(waiterAbortError());
    const completion = this.#completion;
    return new Promise<T>((resolve, reject) => {
      let waiterSettled = false;
      const finish = (callback: () => void) => {
        if (waiterSettled) return;
        waiterSettled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(waiterAbortError()));
      signal.addEventListener("abort", onAbort, { once: true });
      completion.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}

function parseInput(input: unknown): ResourceSettlementInput {
  const record = requireRecord(input, "Resource settlement input");
  rejectUnknownKeys(record, [
    "workspace",
    "project",
    "resourceId",
    "resourceKind",
    "generation",
    "operationRef",
    "policyVersion",
    "failureMode",
    "admissionState",
    "disposition",
    "openedAt",
    "closingStartedAt",
    "terminalAt",
    "observedAt",
    "owners",
  ], "Resource settlement input");
  const openedAt = canonicalTimestamp(record.openedAt, "Resource opened time");
  const closingStartedAt = nullableTimestamp(record.closingStartedAt, "Resource closing start time");
  const terminalAt = nullableTimestamp(record.terminalAt, "Resource terminal time");
  const observedAt = canonicalTimestamp(record.observedAt, "Resource settlement observation time");
  const owners = parseOwners(record.owners, openedAt, closingStartedAt, observedAt);
  return {
    workspace: boundedSlug(record.workspace, "Resource settlement workspace", 80),
    project: boundedSlug(record.project, "Resource settlement project", 80),
    resourceId: boundedIdentifier(record.resourceId, "Resource identity", 160),
    resourceKind: boundedIdentifier(record.resourceKind, "Resource kind", 80),
    generation: positiveInteger(record.generation, "Resource generation"),
    operationRef: boundedIdentifier(record.operationRef, "Settlement operation reference", 160),
    policyVersion: boundedIdentifier(record.policyVersion, "Settlement policy version", 120),
    failureMode: closedValue(record.failureMode, ["continue_through_error", "stop_after_failure"] as const, "Settlement failure mode"),
    admissionState: closedValue(record.admissionState, ["open", "closed"] as const, "Resource admission state"),
    disposition: record.disposition === null
      ? null
      : closedValue(record.disposition, ["reusable", "retired", "reconciliation_hold"] as const, "Resource disposition"),
    openedAt,
    closingStartedAt,
    terminalAt,
    observedAt,
    owners,
  };
}

function parseOwners(
  input: unknown,
  openedAt: string,
  closingStartedAt: string | null,
  observedAt: string,
): ResourceSettlementOwnerInput[] {
  const raw = exactDenseArray(input, "Resource settlement owners", 500);
  const owners = raw.map((entry) => parseOwner(entry, openedAt, closingStartedAt, observedAt));
  const sorted = [...owners].sort((left, right) => compareCodeUnits(ownerKey(left), ownerKey(right)));
  if (new Set(owners.map(ownerKey)).size !== owners.length || JSON.stringify(owners) !== JSON.stringify(sorted)) {
    throw new Error("Resource settlement owners must be unique and in canonical order");
  }
  return owners;
}

function parseReceiptOwners(input: unknown): ResourceSettlementOwner[] {
  const raw = exactDenseArray(input, "Resource settlement receipt owners", 500);
  return raw.map((entry) => {
    const record = requireRecord(entry, "Resource settlement receipt owner");
    rejectUnknownKeys(record, [
      "id", "kind", "generation", "attempted", "state", "attemptedAt", "settledAt",
      "failureClass", "reconciliationRequired", "canPublishLate", "outputFingerprint",
      "publicationFenceFingerprint", "ownerKey",
    ], "Resource settlement receipt owner");
    const kind = closedValue(record.kind, RESOURCE_SETTLEMENT_OWNER_KINDS, "Settlement owner kind");
    const id = boundedIdentifier(record.id, "Settlement owner identity", 160);
    const generation = positiveInteger(record.generation, "Settlement owner generation");
    const expectedKey = ownerKey({ id, kind, generation });
    if (record.ownerKey !== expectedKey) throw new Error("Resource settlement owner key is not canonical");
    return {
      id,
      kind,
      generation,
      attempted: booleanValue(record.attempted, "Settlement owner attempted flag"),
      state: closedValue(record.state, RESOURCE_SETTLEMENT_OWNER_STATES, "Settlement owner state"),
      attemptedAt: nullableTimestamp(record.attemptedAt, "Settlement owner attempted time"),
      settledAt: nullableTimestamp(record.settledAt, "Settlement owner settled time"),
      failureClass: record.failureClass === null
        ? null
        : closedValue(record.failureClass, RESOURCE_SETTLEMENT_FAILURE_CLASSES, "Settlement owner failure class"),
      reconciliationRequired: booleanValue(record.reconciliationRequired, "Settlement owner reconciliation flag"),
      canPublishLate: booleanValue(record.canPublishLate, "Settlement owner late-publication flag"),
      outputFingerprint: record.outputFingerprint === null
        ? null
        : sha256(record.outputFingerprint, "Settlement owner output fingerprint"),
      publicationFenceFingerprint: record.publicationFenceFingerprint === null
        ? null
        : sha256(record.publicationFenceFingerprint, "Settlement owner publication fence fingerprint"),
      ownerKey: expectedKey,
    };
  });
}

function parseReceiptCounts(input: unknown): ResourceSettlementReceipt["counts"] {
  const record = requireRecord(input, "Resource settlement receipt counts");
  rejectUnknownKeys(record, [
    "total",
    "pending",
    "settledSuccess",
    "settledFailure",
    "reconciliationRequired",
    "publicationFenced",
  ], "Resource settlement receipt counts");
  return {
    total: nonNegativeInteger(record.total, "Resource settlement total count"),
    pending: nonNegativeInteger(record.pending, "Resource settlement pending count"),
    settledSuccess: nonNegativeInteger(record.settledSuccess, "Resource settlement success count"),
    settledFailure: nonNegativeInteger(record.settledFailure, "Resource settlement failure count"),
    reconciliationRequired: nonNegativeInteger(
      record.reconciliationRequired,
      "Resource settlement reconciliation count",
    ),
    publicationFenced: nonNegativeInteger(
      record.publicationFenced,
      "Resource settlement publication-fenced count",
    ),
  };
}

function parseSuccessfulOutputs(
  input: unknown,
): Array<{ ownerKey: string; outputFingerprint: string }> {
  const raw = exactDenseArray(input, "Resource settlement successful outputs", 500);
  return raw.map((entry) => {
    const record = requireRecord(entry, "Resource settlement successful output");
    rejectUnknownKeys(
      record,
      ["ownerKey", "outputFingerprint"],
      "Resource settlement successful output",
    );
    return {
      ownerKey: boundedIdentifier(record.ownerKey, "Resource settlement output owner key", 256),
      outputFingerprint: sha256(
        record.outputFingerprint,
        "Resource settlement output fingerprint",
      ),
    };
  });
}

function parseOwnerKeys(input: unknown, label: string): string[] {
  const raw = exactDenseArray(input, label, 500);
  return raw.map((entry) => boundedIdentifier(entry, "Resource settlement owner key", 256));
}

function parseOwner(
  input: unknown,
  openedAt: string,
  closingStartedAt: string | null,
  observedAt: string,
): ResourceSettlementOwnerInput {
  const record = requireRecord(input, "Resource settlement owner");
  rejectUnknownKeys(record, [
    "id", "kind", "generation", "attempted", "state", "attemptedAt", "settledAt",
    "failureClass", "reconciliationRequired", "canPublishLate", "outputFingerprint",
    "publicationFenceFingerprint",
  ], "Resource settlement owner");
  const owner: ResourceSettlementOwnerInput = {
    id: boundedIdentifier(record.id, "Settlement owner identity", 160),
    kind: closedValue(record.kind, RESOURCE_SETTLEMENT_OWNER_KINDS, "Settlement owner kind"),
    generation: positiveInteger(record.generation, "Settlement owner generation"),
    attempted: booleanValue(record.attempted, "Settlement owner attempted flag"),
    state: closedValue(record.state, RESOURCE_SETTLEMENT_OWNER_STATES, "Settlement owner state"),
    attemptedAt: nullableTimestamp(record.attemptedAt, "Settlement owner attempted time"),
    settledAt: nullableTimestamp(record.settledAt, "Settlement owner settled time"),
    failureClass: record.failureClass === null
      ? null
      : closedValue(record.failureClass, RESOURCE_SETTLEMENT_FAILURE_CLASSES, "Settlement owner failure class"),
    reconciliationRequired: booleanValue(record.reconciliationRequired, "Settlement owner reconciliation flag"),
    canPublishLate: booleanValue(record.canPublishLate, "Settlement owner late-publication flag"),
    outputFingerprint: record.outputFingerprint === null
      ? null
      : sha256(record.outputFingerprint, "Settlement owner output fingerprint"),
    publicationFenceFingerprint: record.publicationFenceFingerprint === null
      ? null
      : sha256(record.publicationFenceFingerprint, "Settlement owner publication fence fingerprint"),
  };
  validateOwner(owner, openedAt, closingStartedAt, observedAt);
  return owner;
}

function validateOwner(
  owner: ResourceSettlementOwnerInput,
  openedAt: string,
  closingStartedAt: string | null,
  observedAt: string,
): void {
  if (owner.attempted !== (owner.attemptedAt !== null)) {
    throw new Error("Settlement owner attempted state and timestamp disagree");
  }
  if (owner.attemptedAt && compareTime(owner.attemptedAt, openedAt) < 0) {
    throw new Error("Settlement owner attempt precedes resource opening");
  }
  if (owner.attemptedAt && closingStartedAt && compareTime(owner.attemptedAt, closingStartedAt) < 0) {
    throw new Error("Settlement owner attempt precedes resource closing");
  }
  if (owner.settledAt && !owner.attemptedAt) throw new Error("Settlement owner cannot settle without an attempt");
  if (owner.settledAt && owner.attemptedAt && compareTime(owner.settledAt, owner.attemptedAt) < 0) {
    throw new Error("Settlement owner settled before its attempt");
  }
  if (owner.attemptedAt && compareTime(owner.attemptedAt, observedAt) > 0) {
    throw new Error("Settlement owner attempt occurs after the observation");
  }
  if (owner.settledAt && compareTime(owner.settledAt, observedAt) > 0) {
    throw new Error("Settlement owner settlement occurs after the observation");
  }
  switch (owner.state) {
    case "pending":
      if (owner.settledAt || owner.failureClass || owner.reconciliationRequired || owner.outputFingerprint || owner.publicationFenceFingerprint) {
        throw new Error("Pending settlement owner contains terminal evidence");
      }
      break;
    case "settled_success":
      requireTerminalOwner(owner);
      if (
        owner.failureClass
        || owner.reconciliationRequired
        || owner.canPublishLate
        || owner.publicationFenceFingerprint
      ) {
        throw new Error("Successful settlement owner contains failure or late-publication evidence");
      }
      break;
    case "settled_failure":
      requireTerminalOwner(owner);
      if (
        !owner.failureClass
        || owner.reconciliationRequired
        || owner.canPublishLate
        || owner.publicationFenceFingerprint
      ) {
        throw new Error("Failed settlement owner evidence is inconsistent or permits unfenced late publication");
      }
      break;
    case "reconciliation_required":
      requireTerminalOwner(owner);
      if (!owner.failureClass || !owner.reconciliationRequired || owner.publicationFenceFingerprint) {
        throw new Error("Reconciliation owner evidence is inconsistent");
      }
      break;
    case "publication_fenced":
      requireTerminalOwner(owner);
      if (!owner.failureClass || owner.reconciliationRequired || !owner.canPublishLate || !owner.publicationFenceFingerprint) {
        throw new Error("Publication-fenced owner evidence is inconsistent");
      }
      break;
  }
}

function requireTerminalOwner(owner: ResourceSettlementOwnerInput): void {
  if (!owner.attempted || !owner.attemptedAt || !owner.settledAt) {
    throw new Error("Terminal settlement owner requires attempted and settled timestamps");
  }
}

function derivePhase(input: ResourceSettlementInput): ResourceSettlementPhase {
  if (input.admissionState === "open") return "open";
  if (input.owners.some((owner) => owner.state === "pending")) return "closing";
  return input.owners.some((owner) => owner.state === "settled_failure" || owner.state === "reconciliation_required" || owner.state === "publication_fenced")
    ? "settled_failure"
    : "settled_success";
}

function validateAggregate(input: ResourceSettlementInput, phase: ResourceSettlementPhase): void {
  if (compareTime(input.openedAt, input.observedAt) > 0) throw new Error("Resource opening occurs after observation");
  if (input.closingStartedAt && compareTime(input.closingStartedAt, input.openedAt) < 0) {
    throw new Error("Resource closing precedes opening");
  }
  if (input.closingStartedAt && compareTime(input.closingStartedAt, input.observedAt) > 0) {
    throw new Error("Resource closing occurs after observation");
  }
  if (input.terminalAt && compareTime(input.terminalAt, input.observedAt) > 0) {
    throw new Error("Resource terminal time occurs after observation");
  }
  const terminal = phase === "settled_success" || phase === "settled_failure";
  if (phase === "open") {
    if (input.closingStartedAt || input.terminalAt || input.disposition !== null) {
      throw new Error("Open resource contains closing or terminal evidence");
    }
    if (input.owners.some((owner) => owner.attempted || owner.state !== "pending")) {
      throw new Error("Open resource cannot contain settlement attempts");
    }
    return;
  }
  if (!input.closingStartedAt) throw new Error("Closed admission requires a closing start time");
  if (terminal !== (input.terminalAt !== null)) {
    throw new Error("Resource terminal phase and timestamp disagree");
  }
  if (!terminal && input.disposition !== null) throw new Error("Closing resource cannot publish a terminal disposition");
  if (terminal && input.disposition === null) throw new Error("Terminal resource requires a disposition");
  if (phase === "settled_success" && input.disposition === "reconciliation_hold") {
    throw new Error("Successful settlement cannot require reconciliation hold");
  }
  if (phase === "settled_failure" && input.disposition === "reusable") {
    throw new Error("Failed settlement cannot mark the prior generation reusable");
  }
  if (input.terminalAt) {
    if (compareTime(input.terminalAt, input.closingStartedAt) < 0) {
      throw new Error("Resource terminal time precedes closing");
    }
    const latestOwnerTime = input.owners.reduce<string | null>((latest, owner) => {
      if (!owner.settledAt) return latest;
      return !latest || compareTime(owner.settledAt, latest) > 0 ? owner.settledAt : latest;
    }, null);
    if (latestOwnerTime && compareTime(input.terminalAt, latestOwnerTime) < 0) {
      throw new Error("Resource terminal time precedes owner settlement evidence");
    }
  }
  if (input.failureMode === "stop_after_failure") {
    const firstFailureTime = input.owners.reduce<string | null>((earliest, owner) => {
      const failed = owner.state === "settled_failure"
        || owner.state === "reconciliation_required"
        || owner.state === "publication_fenced";
      if (!failed || !owner.settledAt) return earliest;
      return !earliest || compareTime(owner.settledAt, earliest) < 0 ? owner.settledAt : earliest;
    }, null);
    if (
      firstFailureTime
      && input.owners.some((owner) =>
        owner.attemptedAt !== null && compareTime(owner.attemptedAt, firstFailureTime) > 0)
    ) {
      throw new Error("Stop-after-failure policy attempted an owner after failure settlement");
    }
  }
  if (input.owners.some((owner) => terminalOwnerStates.has(owner.state)) && input.admissionState !== "closed") {
    throw new Error("Terminal owner evidence requires closed admission");
  }
}

function ownerKey(owner: Pick<ResourceSettlementOwnerInput, "id" | "kind" | "generation">): string {
  return `${owner.kind}:${owner.id}:g${owner.generation}`;
}

function countState(owners: ResourceSettlementOwner[], state: ResourceSettlementOwnerState): number {
  return owners.filter((owner) => owner.state === state).length;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : canonicalTimestamp(value, label);
}

function compareTime(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const realisticCredentialPattern = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;

function boundedSlug(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || value !== value.toLowerCase()
    || !/^[a-z0-9][a-z0-9_-]*$/.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new Error(`${label} must be a bounded lowercase slug`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function closedValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) throw new Error(`${label} is invalid`);
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
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must contain only enumerable data properties`);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must contain only enumerable data properties`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactDenseArray(value: unknown, label: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a dense undecorated array`);
  }
  if (value.length > maximumLength || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must be a dense undecorated array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) {
    throw new Error(`${label} must be a dense undecorated array`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must be a dense undecorated array`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
  if (unknown.length) throw new Error(`${label} has unknown field ${unknown[0]}`);
}

function waiterAbortError(): DOMException {
  return new DOMException("Settlement waiter was cancelled", "AbortError");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
