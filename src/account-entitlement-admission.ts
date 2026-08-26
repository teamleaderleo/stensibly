import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const ACCOUNT_ENTITLEMENT_ADMISSION_VERSION = 1 as const;

export type EntitlementSubjectKind = "account" | "authorization";
export type HostedServiceClass =
  | "hosted_read"
  | "hosted_write"
  | "provider_backed_effect";
export type AccountEntitlementStatus = "active" | "suspended";
export type AccountEntitlementAdmissionReason =
  | "allowed"
  | "no_entitlement"
  | "suspended"
  | "allowance_exhausted"
  | "entitlement_expired"
  | "usage_unknown";

export interface EntitlementSubject {
  kind: EntitlementSubjectKind;
  id: string;
  workspace: string;
}

export interface UnlimitedEntitlementAllowance {
  kind: "unlimited";
}

export interface KnownWindowUsage {
  state: "known";
  consumed: number;
  reserved: number;
  observedAt: string;
}

export interface UnknownWindowUsage {
  state: "unknown";
}

export interface WindowedEntitlementAllowance {
  kind: "window";
  windowId: string;
  limit: number;
  resetAt: string;
  usage: KnownWindowUsage | UnknownWindowUsage;
}

export type AccountEntitlementAllowance =
  | UnlimitedEntitlementAllowance
  | WindowedEntitlementAllowance;

export interface AccountEntitlement {
  version: 1;
  subject: EntitlementSubject;
  serviceClass: HostedServiceClass;
  revision: string;
  sourceReference: string;
  status: AccountEntitlementStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  allowance: AccountEntitlementAllowance;
}

export interface AccountEntitlementAdmissionInput {
  subject: EntitlementSubject;
  serviceClass: HostedServiceClass;
  requestIdentity: string;
  currentTime: string;
  entitlement: AccountEntitlement | null;
}

export interface AccountEntitlementAdmission {
  version: typeof ACCOUNT_ENTITLEMENT_ADMISSION_VERSION;
  outcome: "admit" | "deny";
  reason: AccountEntitlementAdmissionReason;
  subjectKind: EntitlementSubjectKind;
  subjectId: string;
  workspace: string;
  serviceClass: HostedServiceClass;
  requestIdentity: string;
  evaluatedAt: string;
  entitlementRevision: string | null;
  entitlementSourceReference: string | null;
  entitlementFingerprint: string | null;
  windowId: string | null;
  resetAt: string | null;
  remaining: number | null;
  decisionFingerprint: string;
  grantsAuthority: false;
}

const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const hostedServiceClasses: readonly HostedServiceClass[] = [
  "hosted_read",
  "hosted_write",
  "provider_backed_effect",
];
const entitlementStatuses: readonly AccountEntitlementStatus[] = [
  "active",
  "suspended",
];

export function compileAccountEntitlementAdmission(
  input: AccountEntitlementAdmissionInput,
): AccountEntitlementAdmission {
  const subject = normalizeSubject(input.subject, "request subject");
  const serviceClass = normalizeServiceClass(input.serviceClass);
  const requestIdentity = boundedIdentity(
    input.requestIdentity,
    "request identity",
    240,
  );
  const evaluatedAt = normalizeTimestamp(input.currentTime, "current time");
  const evaluatedAtMs = Date.parse(evaluatedAt);

  if (input.entitlement === null) {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "deny",
      reason: "no_entitlement",
      entitlementRevision: null,
      entitlementSourceReference: null,
      entitlementFingerprint: null,
      windowId: null,
      resetAt: null,
      remaining: null,
    });
  }

  const route = normalizeEntitlementRoute(input.entitlement);
  if (
    route.subject.kind !== subject.kind
    || route.subject.id !== subject.id
    || route.subject.workspace !== subject.workspace
    || route.serviceClass !== serviceClass
  ) {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "deny",
      reason: "no_entitlement",
      entitlementRevision: null,
      entitlementSourceReference: null,
      entitlementFingerprint: null,
      windowId: null,
      resetAt: null,
      remaining: null,
    });
  }

  const entitlement = normalizeEntitlement(input.entitlement, route);
  const source = {
    entitlementRevision: entitlement.revision,
    entitlementSourceReference: entitlement.sourceReference,
    entitlementFingerprint: fingerprintCanonicalRequest(entitlement),
  };
  const effectiveFromMs = Date.parse(entitlement.effectiveFrom);
  const effectiveUntilMs = entitlement.effectiveUntil === null
    ? null
    : Date.parse(entitlement.effectiveUntil);

  if (evaluatedAtMs < effectiveFromMs) {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "deny",
      reason: "no_entitlement",
      ...source,
      windowId: null,
      resetAt: null,
      remaining: null,
    });
  }
  if (effectiveUntilMs !== null && evaluatedAtMs >= effectiveUntilMs) {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "deny",
      reason: "entitlement_expired",
      ...source,
      windowId: null,
      resetAt: null,
      remaining: null,
    });
  }
  if (entitlement.status === "suspended") {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "deny",
      reason: "suspended",
      ...source,
      windowId: null,
      resetAt: null,
      remaining: null,
    });
  }

  if (entitlement.allowance.kind === "unlimited") {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "admit",
      reason: "allowed",
      ...source,
      windowId: null,
      resetAt: null,
      remaining: null,
    });
  }

  const allowance = entitlement.allowance;
  const resetAtMs = Date.parse(allowance.resetAt);
  const usageIsFuture = allowance.usage.state === "known"
    && Date.parse(allowance.usage.observedAt) > evaluatedAtMs;
  if (
    resetAtMs <= evaluatedAtMs
    || allowance.usage.state === "unknown"
    || usageIsFuture
  ) {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "deny",
      reason: "usage_unknown",
      ...source,
      windowId: allowance.windowId,
      resetAt: allowance.resetAt,
      remaining: null,
    });
  }

  const used = allowance.usage.consumed + allowance.usage.reserved;
  const remaining = Math.max(0, allowance.limit - used);
  if (remaining === 0) {
    return decision({
      subject,
      serviceClass,
      requestIdentity,
      evaluatedAt,
      outcome: "deny",
      reason: "allowance_exhausted",
      ...source,
      windowId: allowance.windowId,
      resetAt: allowance.resetAt,
      remaining: 0,
    });
  }

  return decision({
    subject,
    serviceClass,
    requestIdentity,
    evaluatedAt,
    outcome: "admit",
    reason: "allowed",
    ...source,
    windowId: allowance.windowId,
    resetAt: allowance.resetAt,
    remaining,
  });
}

function normalizeEntitlementRoute(value: AccountEntitlement): {
  subject: EntitlementSubject;
  serviceClass: HostedServiceClass;
} {
  if (value.version !== 1) throw new TypeError("entitlement version is invalid");
  return {
    subject: normalizeSubject(value.subject, "entitlement subject"),
    serviceClass: normalizeServiceClass(value.serviceClass),
  };
}

function normalizeEntitlement(
  value: AccountEntitlement,
  route: { subject: EntitlementSubject; serviceClass: HostedServiceClass },
): AccountEntitlement {
  const revision = boundedIdentity(value.revision, "entitlement revision", 240);
  const sourceReference = boundedIdentity(
    value.sourceReference,
    "entitlement source reference",
    500,
  );
  if (!entitlementStatuses.includes(value.status)) {
    throw new TypeError("entitlement status is invalid");
  }
  const effectiveFrom = normalizeTimestamp(
    value.effectiveFrom,
    "entitlement effective from",
  );
  const effectiveUntil = value.effectiveUntil === null
    ? null
    : normalizeTimestamp(value.effectiveUntil, "entitlement effective until");
  if (
    effectiveUntil !== null
    && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)
  ) {
    throw new TypeError("entitlement effective interval is invalid");
  }

  const allowance = normalizeAllowance(value.allowance);
  return {
    version: 1,
    subject: route.subject,
    serviceClass: route.serviceClass,
    revision,
    sourceReference,
    status: value.status,
    effectiveFrom,
    effectiveUntil,
    allowance,
  };
}

function normalizeAllowance(
  value: AccountEntitlementAllowance,
): AccountEntitlementAllowance {
  if (value.kind === "unlimited") return { kind: "unlimited" };
  if (value.kind !== "window") {
    throw new TypeError("entitlement allowance kind is invalid");
  }

  const windowId = boundedIdentity(value.windowId, "allowance window id", 240);
  assertPositiveSafeInteger(value.limit, "allowance limit");
  const resetAt = normalizeTimestamp(value.resetAt, "allowance reset time");
  if (value.usage.state === "unknown") {
    return {
      kind: "window",
      windowId,
      limit: value.limit,
      resetAt,
      usage: { state: "unknown" },
    };
  }
  if (value.usage.state !== "known") {
    throw new TypeError("allowance usage state is invalid");
  }
  assertNonNegativeSafeInteger(value.usage.consumed, "consumed usage");
  assertNonNegativeSafeInteger(value.usage.reserved, "reserved usage");
  const observedAt = normalizeTimestamp(value.usage.observedAt, "usage observed at");
  if (Date.parse(observedAt) >= Date.parse(resetAt)) {
    throw new TypeError("usage observation must precede allowance reset");
  }
  return {
    kind: "window",
    windowId,
    limit: value.limit,
    resetAt,
    usage: {
      state: "known",
      consumed: value.usage.consumed,
      reserved: value.usage.reserved,
      observedAt,
    },
  };
}

function normalizeSubject(value: EntitlementSubject, field: string): EntitlementSubject {
  if (value.kind !== "account" && value.kind !== "authorization") {
    throw new TypeError(`${field} kind is invalid`);
  }
  return {
    kind: value.kind,
    id: boundedIdentity(value.id, `${field} id`, 240),
    workspace: boundedIdentity(value.workspace, `${field} workspace`, 240),
  };
}

function normalizeServiceClass(value: HostedServiceClass): HostedServiceClass {
  if (!hostedServiceClasses.includes(value)) {
    throw new TypeError("service class is invalid");
  }
  return value;
}

function decision(input: {
  subject: EntitlementSubject;
  serviceClass: HostedServiceClass;
  requestIdentity: string;
  evaluatedAt: string;
  outcome: "admit" | "deny";
  reason: AccountEntitlementAdmissionReason;
  entitlementRevision: string | null;
  entitlementSourceReference: string | null;
  entitlementFingerprint: string | null;
  windowId: string | null;
  resetAt: string | null;
  remaining: number | null;
}): AccountEntitlementAdmission {
  const semantics = {
    version: ACCOUNT_ENTITLEMENT_ADMISSION_VERSION,
    outcome: input.outcome,
    reason: input.reason,
    subjectKind: input.subject.kind,
    subjectId: input.subject.id,
    workspace: input.subject.workspace,
    serviceClass: input.serviceClass,
    requestIdentity: input.requestIdentity,
    evaluatedAt: input.evaluatedAt,
    entitlementRevision: input.entitlementRevision,
    entitlementSourceReference: input.entitlementSourceReference,
    entitlementFingerprint: input.entitlementFingerprint,
    windowId: input.windowId,
    resetAt: input.resetAt,
    remaining: input.remaining,
    grantsAuthority: false as const,
  };
  return Object.freeze({
    ...semantics,
    decisionFingerprint: fingerprintCanonicalRequest(semantics),
  });
}

function boundedIdentity(value: string, field: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${field} is invalid`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !boundedIdentityPattern.test(normalized)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function normalizeTimestamp(value: string, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is invalid`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${field} is invalid`);
  return new Date(timestamp).toISOString();
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}
