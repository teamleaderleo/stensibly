import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const ACCOUNT_USAGE_RESERVATION_VERSION = 1 as const;

export const ACCOUNT_USAGE_SERVICE_CLASSES = [
  "hosted_read",
  "hosted_write",
  "provider_backed_effect",
] as const;

export type AccountUsageSubjectKind = "account" | "authorization";
export type AccountUsageServiceClass = typeof ACCOUNT_USAGE_SERVICE_CLASSES[number];
export type AccountUsageReservationState =
  | "reserved"
  | "consumed"
  | "released"
  | "ambiguous";

export interface AccountUsageSubject {
  kind: AccountUsageSubjectKind;
  id: string;
  workspace: string;
}

export interface AccountUsageReservationIntent {
  subject: AccountUsageSubject;
  serviceClass: AccountUsageServiceClass;
  windowId: string;
  requestIdentity: string;
  units: number;
  admissionDecisionFingerprint: string;
}

export interface ReserveAccountUsageInput extends AccountUsageReservationIntent {
  currentTime: string;
}

export interface SettleAccountUsageInput {
  outcome: "consumed" | "released" | "ambiguous";
  settlementReference: string;
  currentTime: string;
}

export interface ReconcileAccountUsageInput {
  outcome: "consumed" | "released";
  reconciliationReference: string;
  currentTime: string;
}

export interface AccountUsageReservationReceipt extends AccountUsageReservationIntent {
  version: typeof ACCOUNT_USAGE_RESERVATION_VERSION;
  intentFingerprint: string;
  state: AccountUsageReservationState;
  reservedAt: string;
  updatedAt: string;
  settlementReference: string | null;
  reconciliationReference: string | null;
  usage: {
    consumed: number;
    reserved: number;
  };
  grantsAuthority: false;
  grantsProviderBudget: false;
  receiptFingerprint: string;
}

const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;

export function reserveAccountUsage(
  input: ReserveAccountUsageInput,
  existing: unknown | null = null,
): AccountUsageReservationReceipt {
  const intent = normalizeIntent(input);
  const currentTime = normalizeTimestamp(input.currentTime, "current time");
  const intentFingerprint = fingerprintIntent(intent);

  if (existing === null) {
    return createReceipt({
      ...intent,
      state: "reserved",
      reservedAt: currentTime,
      updatedAt: currentTime,
      settlementReference: null,
      reconciliationReference: null,
    });
  }

  const receipt = parseAccountUsageReservationReceipt(existing);
  if (receipt.intentFingerprint !== intentFingerprint) {
    throw new Error("Account usage reservation replay conflicts with the existing intent");
  }
  return receipt;
}

export function settleAccountUsage(
  receiptInput: unknown,
  input: SettleAccountUsageInput,
): AccountUsageReservationReceipt {
  const receipt = parseAccountUsageReservationReceipt(receiptInput);
  const outcome = normalizeSettlementOutcome(input.outcome);
  const settlementReference = boundedIdentity(
    input.settlementReference,
    "settlement reference",
    500,
  );

  if (receipt.state === "reserved") {
    const currentTime = transitionTime(input.currentTime, receipt.updatedAt);
    return createReceipt({
      ...coreFromReceipt(receipt),
      state: outcome,
      updatedAt: currentTime,
      settlementReference,
      reconciliationReference: null,
    });
  }

  if (receipt.state === "ambiguous") {
    if (
      outcome === "ambiguous"
      && receipt.settlementReference === settlementReference
    ) {
      return receipt;
    }
    throw new Error("Ambiguous account usage requires explicit reconciliation");
  }

  if (
    receipt.reconciliationReference === null
    && receipt.state === outcome
    && receipt.settlementReference === settlementReference
  ) {
    return receipt;
  }

  throw new Error("Account usage settlement conflicts with the existing outcome");
}

export function reconcileAccountUsage(
  receiptInput: unknown,
  input: ReconcileAccountUsageInput,
): AccountUsageReservationReceipt {
  const receipt = parseAccountUsageReservationReceipt(receiptInput);
  const outcome = normalizeReconciliationOutcome(input.outcome);
  const reconciliationReference = boundedIdentity(
    input.reconciliationReference,
    "reconciliation reference",
    500,
  );

  if (receipt.state === "ambiguous") {
    const currentTime = transitionTime(input.currentTime, receipt.updatedAt);
    return createReceipt({
      ...coreFromReceipt(receipt),
      state: outcome,
      updatedAt: currentTime,
      settlementReference: receipt.settlementReference,
      reconciliationReference,
    });
  }

  if (
    (receipt.state === "consumed" || receipt.state === "released")
    && receipt.reconciliationReference === reconciliationReference
    && receipt.state === outcome
  ) {
    return receipt;
  }

  if (receipt.state === "reserved") {
    throw new Error("Account usage cannot be reconciled before an ambiguous outcome exists");
  }

  throw new Error("Account usage reconciliation conflicts with the existing outcome");
}

export function parseAccountUsageReservationReceipt(
  input: unknown,
): AccountUsageReservationReceipt {
  const record = requireRecord(input, "Account usage reservation receipt");
  rejectUnknownKeys(record, [
    "version",
    "subject",
    "serviceClass",
    "windowId",
    "requestIdentity",
    "units",
    "admissionDecisionFingerprint",
    "intentFingerprint",
    "state",
    "reservedAt",
    "updatedAt",
    "settlementReference",
    "reconciliationReference",
    "usage",
    "grantsAuthority",
    "grantsProviderBudget",
    "receiptFingerprint",
  ], "Account usage reservation receipt");

  if (record.version !== ACCOUNT_USAGE_RESERVATION_VERSION) {
    throw new Error("Account usage reservation version is unsupported");
  }
  if (record.grantsAuthority !== false || record.grantsProviderBudget !== false) {
    throw new Error("Account usage reservation cannot grant authority or provider budget");
  }

  const subject = normalizeSubject(record.subject, "receipt subject");
  const serviceClass = normalizeServiceClass(record.serviceClass);
  const windowId = boundedIdentity(record.windowId, "allowance window id", 240);
  const requestIdentity = boundedIdentity(record.requestIdentity, "request identity", 240);
  const units = positiveSafeInteger(record.units, "usage units");
  const admissionDecisionFingerprint = sha256(
    record.admissionDecisionFingerprint,
    "admission decision fingerprint",
  );
  const state = normalizeState(record.state);
  const reservedAt = normalizeTimestamp(record.reservedAt, "reserved time");
  const updatedAt = normalizeTimestamp(record.updatedAt, "updated time");
  if (Date.parse(updatedAt) < Date.parse(reservedAt)) {
    throw new Error("Account usage reservation update precedes reservation");
  }
  const settlementReference = nullableIdentity(
    record.settlementReference,
    "settlement reference",
    500,
  );
  const reconciliationReference = nullableIdentity(
    record.reconciliationReference,
    "reconciliation reference",
    500,
  );

  validateTransitionFields({
    state,
    reservedAt,
    updatedAt,
    settlementReference,
    reconciliationReference,
  });

  const reconstructed = createReceipt({
    subject,
    serviceClass,
    windowId,
    requestIdentity,
    units,
    admissionDecisionFingerprint,
    state,
    reservedAt,
    updatedAt,
    settlementReference,
    reconciliationReference,
  });

  if (record.intentFingerprint !== reconstructed.intentFingerprint) {
    throw new Error("Account usage reservation intent fingerprint does not match its contents");
  }
  if (record.receiptFingerprint !== reconstructed.receiptFingerprint) {
    throw new Error("Account usage reservation receipt fingerprint does not match its contents");
  }
  if (!sameUsage(record.usage, reconstructed.usage)) {
    throw new Error("Account usage reservation accounting is not derived correctly");
  }

  return reconstructed;
}

type ReceiptCore = AccountUsageReservationIntent & {
  state: AccountUsageReservationState;
  reservedAt: string;
  updatedAt: string;
  settlementReference: string | null;
  reconciliationReference: string | null;
};

function createReceipt(core: ReceiptCore): AccountUsageReservationReceipt {
  const intent: AccountUsageReservationIntent = {
    subject: core.subject,
    serviceClass: core.serviceClass,
    windowId: core.windowId,
    requestIdentity: core.requestIdentity,
    units: core.units,
    admissionDecisionFingerprint: core.admissionDecisionFingerprint,
  };
  const intentFingerprint = fingerprintIntent(intent);
  const usage = usageForState(core.state, core.units);
  const withoutFingerprint = {
    version: ACCOUNT_USAGE_RESERVATION_VERSION,
    ...intent,
    intentFingerprint,
    state: core.state,
    reservedAt: core.reservedAt,
    updatedAt: core.updatedAt,
    settlementReference: core.settlementReference,
    reconciliationReference: core.reconciliationReference,
    usage,
    grantsAuthority: false as const,
    grantsProviderBudget: false as const,
  };
  return deepFreeze({
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

function coreFromReceipt(receipt: AccountUsageReservationReceipt): ReceiptCore {
  return {
    subject: receipt.subject,
    serviceClass: receipt.serviceClass,
    windowId: receipt.windowId,
    requestIdentity: receipt.requestIdentity,
    units: receipt.units,
    admissionDecisionFingerprint: receipt.admissionDecisionFingerprint,
    state: receipt.state,
    reservedAt: receipt.reservedAt,
    updatedAt: receipt.updatedAt,
    settlementReference: receipt.settlementReference,
    reconciliationReference: receipt.reconciliationReference,
  };
}

function normalizeIntent(input: AccountUsageReservationIntent): AccountUsageReservationIntent {
  return {
    subject: normalizeSubject(input.subject, "usage subject"),
    serviceClass: normalizeServiceClass(input.serviceClass),
    windowId: boundedIdentity(input.windowId, "allowance window id", 240),
    requestIdentity: boundedIdentity(input.requestIdentity, "request identity", 240),
    units: positiveSafeInteger(input.units, "usage units"),
    admissionDecisionFingerprint: sha256(
      input.admissionDecisionFingerprint,
      "admission decision fingerprint",
    ),
  };
}

function fingerprintIntent(intent: AccountUsageReservationIntent): string {
  return fingerprintCanonicalRequest({
    version: ACCOUNT_USAGE_RESERVATION_VERSION,
    operation: "account_usage.reserve",
    ...intent,
  });
}

function normalizeSubject(input: unknown, field: string): AccountUsageSubject {
  const record = requireRecord(input, field);
  rejectUnknownKeys(record, ["kind", "id", "workspace"], field);
  if (record.kind !== "account" && record.kind !== "authorization") {
    throw new TypeError(`${field} kind is invalid`);
  }
  return {
    kind: record.kind,
    id: boundedIdentity(record.id, `${field} id`, 240),
    workspace: boundedIdentity(record.workspace, `${field} workspace`, 240),
  };
}

function normalizeServiceClass(value: unknown): AccountUsageServiceClass {
  if (
    typeof value !== "string"
    || !ACCOUNT_USAGE_SERVICE_CLASSES.includes(value as AccountUsageServiceClass)
  ) {
    throw new TypeError("service class is invalid");
  }
  return value as AccountUsageServiceClass;
}

function normalizeState(value: unknown): AccountUsageReservationState {
  if (
    value !== "reserved"
    && value !== "consumed"
    && value !== "released"
    && value !== "ambiguous"
  ) {
    throw new TypeError("account usage reservation state is invalid");
  }
  return value;
}

function normalizeSettlementOutcome(value: unknown): SettleAccountUsageInput["outcome"] {
  if (value !== "consumed" && value !== "released" && value !== "ambiguous") {
    throw new TypeError("account usage settlement outcome is invalid");
  }
  return value;
}

function normalizeReconciliationOutcome(value: unknown): ReconcileAccountUsageInput["outcome"] {
  if (value !== "consumed" && value !== "released") {
    throw new TypeError("account usage reconciliation outcome is invalid");
  }
  return value;
}

function validateTransitionFields(input: {
  state: AccountUsageReservationState;
  reservedAt: string;
  updatedAt: string;
  settlementReference: string | null;
  reconciliationReference: string | null;
}): void {
  if (input.state === "reserved") {
    if (
      input.settlementReference !== null
      || input.reconciliationReference !== null
      || input.updatedAt !== input.reservedAt
    ) {
      throw new Error("Reserved account usage has invalid settlement evidence");
    }
    return;
  }

  if (input.settlementReference === null) {
    throw new Error("Settled account usage requires a settlement reference");
  }
  if (input.state === "ambiguous" && input.reconciliationReference !== null) {
    throw new Error("Ambiguous account usage cannot already be reconciled");
  }
}

function usageForState(
  state: AccountUsageReservationState,
  units: number,
): { consumed: number; reserved: number } {
  if (state === "consumed") return { consumed: units, reserved: 0 };
  if (state === "released") return { consumed: 0, reserved: 0 };
  return { consumed: 0, reserved: units };
}

function sameUsage(
  input: unknown,
  expected: { consumed: number; reserved: number },
): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "consumed,reserved") return false;
  return record.consumed === expected.consumed && record.reserved === expected.reserved;
}

function transitionTime(value: unknown, previous: string): string {
  const current = normalizeTimestamp(value, "current time");
  if (Date.parse(current) < Date.parse(previous)) {
    throw new Error("Account usage transition time precedes existing evidence");
  }
  return current;
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid timestamp`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new TypeError(`${field} must be canonical UTC`);
  return canonical;
}

function boundedIdentity(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || !boundedIdentityPattern.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError(`${field} cannot retain credential-like text`);
  }
  return value;
}

function nullableIdentity(value: unknown, field: string, maxLength: number): string | null {
  return value === null ? null : boundedIdentity(value, field, maxLength);
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 fingerprint`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new TypeError(`${field} contains unknown field ${unknown}`);
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
