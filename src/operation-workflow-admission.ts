import { sha256, stableJson } from "./canonical-json.js";
import {
  operationWorkflowKinds,
  operationWorkflowStates,
  operationWorkflowStepStates,
  type OperationAuthorityFence,
  type OperationWorkflow,
  type OperationWorkflowState,
  type OperationWorkflowStep,
  type OperationWorkflowStepState,
} from "./operation-workflow-contracts.js";

const shaPattern = /^sha256:[a-f0-9]{64}$/u;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u;
const credentialShapedPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{24,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}|bearer\s+[A-Za-z0-9._~+\/-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
const maximumSteps = 8;

export function admitOperationWorkflow(value: unknown): OperationWorkflow {
  const record = exactRecord(value, [
    "version", "id", "revision", "project", "itemId", "runId", "actorId",
    "clientId", "kind", "target", "requestSha256", "idempotencyKey", "state",
    "steps", "cancellationRequestedAt", "createdAt", "updatedAt", "terminalAt",
    "recovery",
  ]);
  if (record.version !== 1) throw new RangeError("Operation workflow version is invalid");
  const stepsValue = exactArray(record.steps, "Operation workflow steps", maximumSteps);
  if (stepsValue.length < 1) {
    throw new RangeError(`Operation workflow must contain 1 to ${maximumSteps} steps`);
  }
  const steps = stepsValue.map((step, index) => admitStep(step, index));
  const createdAt = timestamp(record.createdAt, "Operation workflow creation time");
  const updatedAt = timestamp(record.updatedAt, "Operation workflow update time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new RangeError("Operation workflow update time precedes creation");
  }
  const terminalAt = nullableTimestamp(record.terminalAt, "Operation workflow terminal time");
  const state = member(record.state, operationWorkflowStates, "Operation workflow state");
  const expected = deriveOperationWorkflowState(steps, record.cancellationRequestedAt !== null);
  if (state !== expected) {
    throw new RangeError(`Operation workflow state must be ${expected}`);
  }
  if ((terminalAt !== null) !== terminalStates.has(state)) {
    throw new RangeError("Operation workflow terminal time does not match lifecycle state");
  }
  if (terminalAt !== null && Date.parse(terminalAt) < Date.parse(updatedAt)) {
    throw new RangeError("Operation workflow terminal time precedes its last update");
  }
  if (terminalAt !== null && terminalAt !== updatedAt) {
    throw new RangeError("Operation workflow terminal time must equal its last update");
  }
  const recoveryRecord = exactRecord(record.recovery, ["nextAction"]);
  const recovery = {
    nextAction: member(recoveryRecord.nextAction, [
      "continue", "reconcile_current_step", "compensate_completed_steps",
      "manual_reconciliation", "none",
    ] as const, "Operation workflow recovery action"),
  };
  if (recovery.nextAction !== recoveryForState(state)) {
    throw new RangeError("Operation workflow recovery action is incoherent");
  }
  const workflow: OperationWorkflow = {
    version: 1,
    id: identifier(record.id, "Operation workflow ID", 160),
    revision: positiveInteger(record.revision, "Operation workflow revision"),
    project: pattern(record.project, "Operation workflow project", projectPattern, 80),
    itemId: identifier(record.itemId, "Operation workflow item ID", 160),
    runId: identifier(record.runId, "Operation workflow run ID", 160),
    actorId: identifier(record.actorId, "Operation workflow actor ID", 160),
    clientId: identifier(record.clientId, "Operation workflow client ID", 240),
    kind: member(record.kind, operationWorkflowKinds, "Operation workflow kind"),
    target: identifier(record.target, "Operation workflow target", 320),
    requestSha256: pattern(record.requestSha256, "Operation workflow request digest", shaPattern, 71),
    idempotencyKey: identifier(record.idempotencyKey, "Operation workflow idempotency key", 240),
    state,
    steps,
    cancellationRequestedAt: nullableTimestamp(
      record.cancellationRequestedAt,
      "Operation workflow cancellation time",
    ),
    createdAt,
    updatedAt,
    terminalAt,
    recovery,
  };
  for (const step of workflow.steps) {
    const prefix = `run:${workflow.runId}:generation:`;
    const generation = step.authorityFence.resource.startsWith(prefix)
      ? step.authorityFence.resource.slice(prefix.length)
      : "";
    if (!/^[1-9][0-9]*$/u.test(generation) || !Number.isSafeInteger(Number(generation))) {
      throw new RangeError("Operation workflow authority must bind its run");
    }
    if (step.authorityFence.holderId !== workflow.actorId) {
      throw new RangeError("Operation workflow authority must bind its actor");
    }
  }
  return deepFreeze(workflow);
}

export function canonicalOperationWorkflowJson(workflow: OperationWorkflow): string {
  return stableJson(admitOperationWorkflow(workflow));
}

export function parseOperationWorkflowJson(value: unknown): OperationWorkflow {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) {
    throw new RangeError("Stored operation workflow is invalid");
  }
  return admitOperationWorkflow(JSON.parse(value));
}

export function fingerprintOperationWorkflow(workflow: OperationWorkflow): string {
  return sha256(canonicalOperationWorkflowJson(workflow));
}

export function operationWorkflowStableRequestJson(workflowInput: unknown): string {
  const workflow = admitOperationWorkflow(workflowInput);
  return stableJson({
    project: workflow.project,
    itemId: workflow.itemId,
    runId: workflow.runId,
    actorId: workflow.actorId,
    clientId: workflow.clientId,
    kind: workflow.kind,
    target: workflow.target,
    requestSha256: workflow.requestSha256,
    idempotencyKey: workflow.idempotencyKey,
    steps: workflow.steps.map((step) => ({
      ordinal: step.ordinal,
      kind: step.kind,
      commandSha256: step.commandSha256,
      providerIdempotencyKey: step.providerIdempotencyKey,
      authorityFence: {
        resource: step.authorityFence.resource,
        holderId: step.authorityFence.holderId,
        generation: step.authorityFence.generation,
      },
      compensation: {
        disposition: step.compensation.disposition,
        kind: step.compensation.kind,
        commandSha256: step.compensation.commandSha256,
      },
    })),
  });
}

export function assertOperationWorkflowTransition(
  currentInput: unknown,
  nextInput: unknown,
): { current: OperationWorkflow; next: OperationWorkflow } {
  const current = admitOperationWorkflow(currentInput);
  const next = admitOperationWorkflow(nextInput);
  for (const key of [
    "version", "id", "project", "itemId", "runId", "actorId", "clientId", "kind",
    "target", "requestSha256", "idempotencyKey", "createdAt",
  ] as const) {
    if (current[key] !== next[key]) throw new RangeError("Operation workflow identity changed");
  }
  if (next.revision !== current.revision + 1) {
    throw new RangeError("Operation workflow revision must advance exactly once");
  }
  if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new RangeError("Operation workflow update time moved backwards");
  }
  if (current.steps.length !== next.steps.length) {
    throw new RangeError("Operation workflow plan changed after reservation");
  }
  if (current.terminalAt !== null) throw new RangeError("Terminal operation workflow cannot transition");

  const cancellationTransition = current.cancellationRequestedAt === null
    && next.cancellationRequestedAt !== null;
  let changed = 0;
  let planned = 0;
  for (let index = 0; index < current.steps.length; index += 1) {
    const before = current.steps[index]!;
    const after = next.steps[index]!;
    assertStepIdentity(before, after);
    if (before.state === "planned") planned += 1;
    if (stableJson(before) === stableJson(after)) continue;
    changed += 1;
    if (cancellationTransition) {
      if (before.state !== "planned" || after.state !== "cancelled") {
        throw new RangeError("Operation workflow cancellation can only stop unscheduled steps");
      }
      assertStepTransition(before, after);
      continue;
    }
    assertStepTransition(before, after);
  }

  if (cancellationTransition) {
    if (next.cancellationRequestedAt !== next.updatedAt) {
      throw new RangeError("Operation workflow cancellation time must equal its update time");
    }
    if (changed !== planned) {
      throw new RangeError("Operation workflow cancellation must stop every unscheduled step");
    }
    return { current, next };
  }

  if (current.cancellationRequestedAt !== next.cancellationRequestedAt) {
    throw new RangeError("Step transition cannot alter cancellation state");
  }
  if (changed !== 1) throw new RangeError("Operation workflow must transition exactly one step");
  return { current, next };
}

export function deriveOperationWorkflowState(
  steps: readonly OperationWorkflowStep[],
  cancellationRequested: boolean,
): OperationWorkflowState {
  const states = new Set(steps.map((step) => step.state));
  if (states.has("pending_reconciliation")) return "waiting_reconciliation";
  if (states.has("compensation_failed")) return "escalated";
  if (states.has("compensating")) return "compensating";
  if (states.has("rejected")) {
    if (cancellationRequested && steps.some((step) => step.state === "cancelled")) return "failed";
    if (steps.some((step) => step.state === "verified")) return "partially_completed";
    return steps.some((step) => step.state === "compensated") ? "compensated" : "failed";
  }
  if (steps.every((step) => step.state === "compensated" || step.state === "cancelled")) {
    return steps.some((step) => step.state === "compensated") ? "compensated" : "cancelled";
  }
  if (steps.every((step) => step.state === "verified")) return "succeeded";
  if (cancellationRequested && steps.every((step) => step.state === "planned" || step.state === "cancelled")) {
    return "cancelled";
  }
  if (
    cancellationRequested
    && steps.some((step) => step.state === "cancelled")
    && steps.every((step) => step.state === "verified" || step.state === "compensated" || step.state === "cancelled")
  ) {
    return "cancelled";
  }
  if (steps.some((step) => step.state !== "planned")) return "running";
  return "reserved";
}

export function recoveryForState(state: OperationWorkflowState): OperationWorkflow["recovery"]["nextAction"] {
  switch (state) {
    case "reserved":
    case "running":
    case "compensating": return "continue";
    case "waiting_reconciliation": return "reconcile_current_step";
    case "partially_completed": return "compensate_completed_steps";
    case "escalated": return "manual_reconciliation";
    default: return "none";
  }
}

function admitStep(value: unknown, index: number): OperationWorkflowStep {
  const record = exactRecord(value, [
    "id", "ordinal", "kind", "commandId", "commandSha256", "providerIdempotencyKey", "authorityFence", "state",
    "reservedAt", "settledAt", "providerReceiptRef", "beforeSha256", "afterSha256",
    "verificationSha256", "errorCode", "retry", "compensation",
  ]);
  const ordinal = positiveInteger(record.ordinal, "Operation workflow step ordinal");
  if (ordinal !== index + 1) throw new RangeError("Operation workflow step order is invalid");
  const state = member(record.state, operationWorkflowStepStates, "Operation workflow step state");
  const reservedAt = nullableTimestamp(record.reservedAt, "Operation workflow step reservation time");
  const settledAt = nullableTimestamp(record.settledAt, "Operation workflow step settlement time");
  if ((state === "planned" || state === "cancelled") && reservedAt !== null) {
    throw new RangeError("Unscheduled operation workflow step cannot have a reservation time");
  }
  if (state === "dispatch_reserved" && (reservedAt === null || settledAt !== null)) {
    throw new RangeError("Reserved operation workflow step has invalid timestamps");
  }
  if (!["planned", "dispatch_reserved", "cancelled"].includes(state) && settledAt === null) {
    throw new RangeError("Settled operation workflow step requires a settlement time");
  }
  const compensationRecord = exactRecord(record.compensation, [
    "disposition", "kind", "commandSha256", "state", "providerReceiptRef",
  ]);
  const compensation = {
    disposition: member(compensationRecord.disposition, [
      "reversible", "conditionally_reversible", "compensatable", "irreversible",
    ] as const, "Operation compensation disposition"),
    kind: nullableIdentifier(compensationRecord.kind, "Operation compensation kind", 120),
    commandSha256: nullablePattern(compensationRecord.commandSha256, "Operation compensation digest", shaPattern, 71),
    state: member(compensationRecord.state, [
      "not_started", "reserved", "succeeded", "failed", "unavailable",
    ] as const, "Operation compensation state"),
    providerReceiptRef: nullableIdentifier(
      compensationRecord.providerReceiptRef,
      "Operation compensation receipt reference",
      240,
    ),
  };
  if (compensation.disposition === "irreversible" && compensation.kind !== null) {
    throw new RangeError("Irreversible operation step cannot claim compensation");
  }
  if (compensation.disposition !== "irreversible" && (compensation.kind === null || compensation.commandSha256 === null)) {
    throw new RangeError("Reversible operation step requires a compensation command");
  }
  assertStepLifecycleEvidence({
    state,
    reservedAt,
    settledAt,
    providerReceiptRef: record.providerReceiptRef,
    beforeSha256: record.beforeSha256,
    afterSha256: record.afterSha256,
    verificationSha256: record.verificationSha256,
    errorCode: record.errorCode,
    retry: record.retry,
    compensation,
  });
  return deepFreeze({
    id: identifier(record.id, "Operation workflow step ID", 160),
    ordinal,
    kind: identifier(record.kind, "Operation workflow step kind", 120),
    commandId: identifier(record.commandId, "Operation workflow step command ID", 160),
    commandSha256: pattern(record.commandSha256, "Operation workflow step command digest", shaPattern, 71),
    providerIdempotencyKey: identifier(
      record.providerIdempotencyKey,
      "Operation workflow step provider idempotency key",
      240,
    ),
    authorityFence: admitFence(record.authorityFence),
    state,
    reservedAt,
    settledAt,
    providerReceiptRef: nullableIdentifier(record.providerReceiptRef, "Operation provider receipt reference", 240),
    beforeSha256: nullablePattern(record.beforeSha256, "Operation before digest", shaPattern, 71),
    afterSha256: nullablePattern(record.afterSha256, "Operation after digest", shaPattern, 71),
    verificationSha256: nullablePattern(record.verificationSha256, "Operation verification digest", shaPattern, 71),
    errorCode: nullableIdentifier(record.errorCode, "Operation error code", 120),
    retry: member(record.retry, ["none", "reconcile_before_retry"] as const, "Operation retry policy"),
    compensation,
  });
}

function admitFence(value: unknown): OperationAuthorityFence {
  const record = exactRecord(value, ["resource", "holderId", "generation", "expiresAt"]);
  return deepFreeze({
    resource: identifier(record.resource, "Operation authority resource", 240),
    holderId: identifier(record.holderId, "Operation authority holder", 160),
    generation: positiveInteger(record.generation, "Operation authority generation"),
    expiresAt: timestamp(record.expiresAt, "Operation authority expiry"),
  });
}

function assertStepIdentity(before: OperationWorkflowStep, after: OperationWorkflowStep): void {
  for (const key of ["id", "ordinal", "kind", "commandId", "commandSha256", "providerIdempotencyKey"] as const) {
    if (before[key] !== after[key]) throw new RangeError("Operation workflow step identity changed");
  }
  if (stableJson(before.authorityFence) !== stableJson(after.authorityFence)) {
    throw new RangeError("Operation workflow step authority changed");
  }
  if (stableJson(before.compensation.disposition) !== stableJson(after.compensation.disposition)
    || before.compensation.kind !== after.compensation.kind
    || before.compensation.commandSha256 !== after.compensation.commandSha256) {
    throw new RangeError("Operation workflow compensation plan changed");
  }
}

function assertStepTransition(before: OperationWorkflowStep, after: OperationWorkflowStep): void {
  const allowed: Record<OperationWorkflowStepState, readonly OperationWorkflowStepState[]> = {
    planned: ["dispatch_reserved", "cancelled"],
    dispatch_reserved: ["verified", "rejected", "pending_reconciliation"],
    pending_reconciliation: ["verified", "rejected"],
    verified: ["compensating"],
    compensating: ["compensated", "compensation_failed"],
    rejected: [], compensated: [], compensation_failed: [], cancelled: [],
  };
  if (!allowed[before.state].includes(after.state)) {
    throw new RangeError(`Operation workflow step cannot move from ${before.state} to ${after.state}`);
  }
  if (after.reservedAt !== before.reservedAt && before.state !== "planned") {
    throw new RangeError("Operation workflow step reservation time changed");
  }
  if (
    !["planned", "dispatch_reserved", "pending_reconciliation"].includes(before.state)
    && after.settledAt !== before.settledAt
  ) {
    throw new RangeError("Operation workflow step settlement time changed");
  }
  if (
    !["verified", "compensating"].includes(before.state)
    && stableJson(after.compensation) !== stableJson(before.compensation)
  ) {
    throw new RangeError("Operation workflow compensation changed outside compensation execution");
  }
  if (before.state === "planned" && after.state === "dispatch_reserved") {
    if (
      after.reservedAt === null
      || after.settledAt !== null
      || after.providerReceiptRef !== null
      || after.beforeSha256 !== null
      || after.afterSha256 !== null
      || after.verificationSha256 !== null
      || after.errorCode !== null
      || after.retry !== "none"
    ) {
      throw new RangeError("Operation workflow dispatch reservation is invalid");
    }
  }
  if (after.state === "verified") {
    if (after.providerReceiptRef === null || after.afterSha256 === null || after.verificationSha256 === null || after.errorCode !== null || after.retry !== "none") {
      throw new RangeError("Verified operation workflow step lacks exact evidence");
    }
  }
  if (after.state === "pending_reconciliation" && (after.errorCode === null || after.retry !== "reconcile_before_retry")) {
    throw new RangeError("Ambiguous operation workflow step must require reconciliation");
  }
  if (after.state === "rejected" && (after.errorCode === null || after.retry !== "none")) {
    throw new RangeError("Rejected operation workflow step must fail closed");
  }
  if (
    (after.state === "pending_reconciliation" || after.state === "rejected")
    && (
      after.beforeSha256 !== before.beforeSha256
      || after.afterSha256 !== before.afterSha256
      || after.verificationSha256 !== before.verificationSha256
    )
  ) {
    throw new RangeError("Unverified operation workflow step cannot invent effect evidence");
  }
  if (before.state === "verified" && after.state === "compensating") {
    if (before.compensation.state !== "not_started" || after.compensation.state !== "reserved") {
      throw new RangeError("Operation workflow compensation reservation is invalid");
    }
  }
  if (before.state === "compensating" && after.state === "compensated") {
    if (after.compensation.state !== "succeeded" || after.compensation.providerReceiptRef === null) {
      throw new RangeError("Operation workflow compensation success lacks a receipt");
    }
  }
  if (before.state === "compensating" && after.state === "compensation_failed") {
    if (after.compensation.state !== "failed" || after.errorCode === null) {
      throw new RangeError("Operation workflow compensation failure lacks evidence");
    }
  }
}

const terminalStates = new Set<OperationWorkflowState>([
  "succeeded", "compensated", "failed", "cancelled", "escalated",
]);

function assertStepLifecycleEvidence(input: {
  state: OperationWorkflowStepState;
  reservedAt: string | null;
  settledAt: string | null;
  providerReceiptRef: unknown;
  beforeSha256: unknown;
  afterSha256: unknown;
  verificationSha256: unknown;
  errorCode: unknown;
  retry: unknown;
  compensation: OperationWorkflowStep["compensation"];
}): void {
  const noEffectEvidence = input.beforeSha256 === null
    && input.afterSha256 === null
    && input.verificationSha256 === null;
  if (input.state === "planned" || input.state === "cancelled") {
    if (
      input.reservedAt !== null
      || input.settledAt !== null
      || input.providerReceiptRef !== null
      || !noEffectEvidence
      || input.errorCode !== null
      || input.retry !== "none"
    ) throw new RangeError("Unscheduled operation workflow step contains effect evidence");
  } else if (input.state === "dispatch_reserved") {
    if (
      input.reservedAt === null
      || input.settledAt !== null
      || input.providerReceiptRef !== null
      || !noEffectEvidence
      || input.errorCode !== null
      || input.retry !== "none"
    ) throw new RangeError("Reserved operation workflow step contains settlement evidence");
  } else if (input.state === "verified" || input.state === "compensating" || input.state === "compensated") {
    if (
      input.reservedAt === null
      || input.settledAt === null
      || input.providerReceiptRef === null
      || input.beforeSha256 === null
      || input.afterSha256 === null
      || input.verificationSha256 === null
      || input.errorCode !== null
      || input.retry !== "none"
    ) throw new RangeError("Verified operation workflow step lacks coherent effect evidence");
  } else if (input.state === "pending_reconciliation" || input.state === "rejected") {
    if (
      input.reservedAt === null
      || input.settledAt === null
      || !noEffectEvidence
      || input.errorCode === null
      || input.retry !== (input.state === "pending_reconciliation" ? "reconcile_before_retry" : "none")
    ) throw new RangeError("Unverified operation workflow step contains incoherent evidence");
  } else if (input.state === "compensation_failed") {
    if (
      input.reservedAt === null
      || input.settledAt === null
      || input.providerReceiptRef === null
      || input.beforeSha256 === null
      || input.afterSha256 === null
      || input.verificationSha256 === null
      || input.errorCode === null
      || input.retry !== "none"
    ) throw new RangeError("Failed compensation lacks coherent effect evidence");
  }
  const expectedCompensationState = input.state === "compensating"
    ? "reserved"
    : input.state === "compensated"
      ? "succeeded"
      : input.state === "compensation_failed"
        ? "failed"
        : input.compensation.disposition === "irreversible"
          ? "unavailable"
          : "not_started";
  if (input.compensation.state !== expectedCompensationState) {
    throw new RangeError("Operation workflow compensation state is incoherent");
  }
  if (input.compensation.state === "succeeded" && input.compensation.providerReceiptRef === null) {
    throw new RangeError("Operation workflow compensation receipt is incoherent");
  }
  if (
    input.compensation.state !== "succeeded"
    && input.compensation.state !== "failed"
    && input.compensation.providerReceiptRef !== null
  ) {
    throw new RangeError("Operation workflow compensation receipt is incoherent");
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Operation workflow record is invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Operation workflow record is invalid");
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("Operation workflow record is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (stableJson(actual) !== stableJson(expected)) throw new TypeError("Operation workflow record shape is invalid");
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Operation workflow record is invalid");
    }
    record[key] = descriptor.value;
  }
  return record;
}

function exactArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => key !== "length");
  if (keys.length !== value.length) throw new TypeError(`${label} is invalid`);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} is invalid`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value: unknown, label: string, maximum: number): string {
  const text = pattern(value, label, identifierPattern, maximum);
  if (credentialShapedPattern.test(text)) throw new RangeError(`${label} is invalid`);
  return text;
}

function nullableIdentifier(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : identifier(value, label, maximum);
}

function pattern(value: unknown, label: string, matcher: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !matcher.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function nullablePattern(value: unknown, label: string, matcher: RegExp, maximum: number): string | null {
  return value === null ? null : pattern(value, label, matcher, maximum);
}

function timestamp(value: unknown, label: string): string {
  const text = pattern(value, label, timestampPattern, 24);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) throw new RangeError(`${label} is invalid`);
  return text;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RangeError(`${label} must be a positive integer`);
  return Number(value);
}

function member<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new RangeError(`${label} is invalid`);
  return value as T[number];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
