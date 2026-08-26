import type { KnownWindowUsage } from "./account-entitlement-admission.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  ACCOUNT_USAGE_SERVICE_CLASSES,
  parseAccountUsageReservationReceipt,
  type AccountUsageServiceClass,
  type AccountUsageSubject,
} from "./account-usage-reservation.js";

export const ACCOUNT_USAGE_WINDOW_EVIDENCE_VERSION = 1 as const;
export const ACCOUNT_USAGE_WINDOW_MAX_RECEIPTS = 10_000 as const;

export interface AccountUsageWindowEvidence {
  version: typeof ACCOUNT_USAGE_WINDOW_EVIDENCE_VERSION;
  subject: AccountUsageSubject;
  serviceClass: AccountUsageServiceClass;
  windowId: string;
  usage: KnownWindowUsage;
  receiptCount: number;
  receiptSetFingerprint: string;
  evidenceFingerprint: string;
  grantsAuthority: false;
  grantsProviderBudget: false;
}

const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;

/**
 * Compile one authoritative window observation from exact per-request usage
 * receipts. The caller owns the storage/query boundary and supplies the
 * observation time after completing that bounded read. Any foreign, duplicate,
 * future, or malformed receipt makes the observation unusable.
 */
export function compileAccountUsageWindowEvidence(
  input: unknown,
): AccountUsageWindowEvidence {
  const record = requireRecord(input, "Account usage window input");
  rejectUnknownKeys(record, [
    "subject",
    "serviceClass",
    "windowId",
    "observedAt",
    "receipts",
  ], "Account usage window input");

  const subject = normalizeSubject(record.subject);
  const serviceClass = normalizeServiceClass(record.serviceClass);
  const windowId = boundedIdentity(record.windowId, "allowance window id", 240);
  const observedAt = normalizeTimestamp(record.observedAt, "usage observation time");
  const observedAtMs = Date.parse(observedAt);
  if (!Array.isArray(record.receipts)) {
    throw new TypeError("usage receipts must be an array");
  }
  if (record.receipts.length > ACCOUNT_USAGE_WINDOW_MAX_RECEIPTS) {
    throw new RangeError("usage receipt set exceeds the bounded window limit");
  }

  const receipts = record.receipts.map(parseAccountUsageReservationReceipt);
  const sorted = [...receipts].sort((left, right) => {
    if (left.requestIdentity < right.requestIdentity) return -1;
    if (left.requestIdentity > right.requestIdentity) return 1;
    return left.receiptFingerprint < right.receiptFingerprint
      ? -1
      : left.receiptFingerprint > right.receiptFingerprint
        ? 1
        : 0;
  });

  let consumed = 0;
  let reserved = 0;
  let previousRequestIdentity: string | null = null;
  const receiptSet: Array<{
    requestIdentity: string;
    receiptFingerprint: string;
  }> = [];

  for (const receipt of sorted) {
    if (
      receipt.subject.kind !== subject.kind
      || receipt.subject.id !== subject.id
      || receipt.subject.workspace !== subject.workspace
      || receipt.serviceClass !== serviceClass
      || receipt.windowId !== windowId
    ) {
      throw new Error("Account usage window contains a foreign receipt");
    }
    if (receipt.requestIdentity === previousRequestIdentity) {
      throw new Error("Account usage window contains a duplicate request identity");
    }
    previousRequestIdentity = receipt.requestIdentity;
    if (Date.parse(receipt.updatedAt) > observedAtMs) {
      throw new Error("Account usage window contains future receipt evidence");
    }
    consumed = safeAdd(consumed, receipt.usage.consumed, "consumed usage");
    reserved = safeAdd(reserved, receipt.usage.reserved, "reserved usage");
    receiptSet.push({
      requestIdentity: receipt.requestIdentity,
      receiptFingerprint: receipt.receiptFingerprint,
    });
  }

  const receiptSetFingerprint = fingerprintCanonicalRequest({
    version: ACCOUNT_USAGE_WINDOW_EVIDENCE_VERSION,
    operation: "account_usage.window_receipt_set",
    subject,
    serviceClass,
    windowId,
    receipts: receiptSet,
  });
  const usage: KnownWindowUsage = {
    state: "known",
    consumed,
    reserved,
    observedAt,
  };
  const withoutFingerprint = {
    version: ACCOUNT_USAGE_WINDOW_EVIDENCE_VERSION,
    subject,
    serviceClass,
    windowId,
    usage,
    receiptCount: receiptSet.length,
    receiptSetFingerprint,
    grantsAuthority: false as const,
    grantsProviderBudget: false as const,
  };
  return deepFreeze({
    ...withoutFingerprint,
    evidenceFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

function normalizeSubject(value: unknown): AccountUsageSubject {
  const record = requireRecord(value, "usage subject");
  rejectUnknownKeys(record, ["kind", "id", "workspace"], "usage subject");
  if (record.kind !== "account" && record.kind !== "authorization") {
    throw new TypeError("usage subject kind is invalid");
  }
  return {
    kind: record.kind,
    id: boundedIdentity(record.id, "usage subject id", 240),
    workspace: boundedIdentity(record.workspace, "usage subject workspace", 240),
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

function boundedIdentity(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || !boundedIdentityPattern.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError(`${field} cannot retain credential-like text`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid timestamp`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new TypeError(`${field} must be canonical UTC`);
  return canonical;
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${field} exceeds safe integer accounting`);
  }
  return result;
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
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new TypeError(`${field} contains unknown fields`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
