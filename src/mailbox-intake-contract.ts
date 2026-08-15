import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const mailboxObservationEventTypes = [
  "mail.message.created",
  "mail.message.updated",
  "mail.message.deleted",
  "mail.scope.added",
  "mail.scope.removed",
  "mail.subscription.degraded",
  "mail.subscription.recovered",
] as const;

export type MailboxObservationEventType =
  typeof mailboxObservationEventTypes[number];
export type MailboxObservationInputEventType =
  | MailboxObservationEventType
  | "mail.label.added"
  | "mail.label.removed";
export type MailboxProvider = "gmail" | "outlook";
export type MailboxCoverage = "continuous" | "unknown";
export type MailboxLoopDisposition = "ordinary" | "self_echo" | "automatic";
export type MailboxObservationSourceSchema =
  | "gmail-history"
  | "gmail-subscription"
  | "outlook-delta"
  | "outlook-subscription";

export type MailboxScope =
  | { readonly kind: "label"; readonly externalId: string }
  | { readonly kind: "folder"; readonly externalId: string };

export type MailboxCursor =
  | { readonly kind: "gmail_history_id"; readonly value: string }
  | { readonly kind: "outlook_delta_ref"; readonly value: string };

export type MailboxSubscriptionHealth = "healthy" | "degraded" | "recovering";

export interface MailboxSubscriptionProjection {
  readonly externalId: string | null;
  readonly expiresAt: string | null;
  readonly health: MailboxSubscriptionHealth;
  readonly recoveryReason: string | null;
}

export interface MailboxSubscriptionState {
  readonly version: 1;
  readonly mailboxBindingId: string;
  readonly provider: MailboxProvider;
  readonly scope: MailboxScope;
  readonly cursor: MailboxCursor;
  readonly coverage: MailboxCoverage;
  readonly subscription: MailboxSubscriptionProjection;
  readonly lastNotificationId: string | null;
  readonly lastSuccessfulReconciliationAt: string | null;
}

export interface MailboxObservation {
  readonly version: 2;
  readonly provider: MailboxProvider;
  readonly mailboxBindingId: string;
  readonly sourceSchema: MailboxObservationSourceSchema;
  readonly sourceEventId: string;
  readonly observationId: string;
  readonly semanticFingerprint: string;
  readonly eventType: MailboxObservationEventType;
  readonly providerCursor: string;
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly providerScopeId: string | null;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly wakeEligible: boolean;
  readonly loopDisposition: MailboxLoopDisposition;
  readonly containsRawContent: false;
  readonly grantsAuthority: false;
}

export interface CreateMailboxSubscriptionStateInput {
  mailboxBindingId: string;
  provider: MailboxProvider;
  scope: MailboxScope;
  cursor: MailboxCursor;
  coverage: MailboxCoverage;
  subscription: MailboxSubscriptionProjection;
  lastNotificationId: string | null;
  lastSuccessfulReconciliationAt: string | null;
}

export interface CreateMailboxObservationInput {
  provider: MailboxProvider;
  mailboxBindingId: string;
  sourceSchema: MailboxObservationSourceSchema;
  sourceEventId: string;
  eventType: MailboxObservationInputEventType;
  providerCursor: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  providerScopeId?: string | null;
  providerLabelId?: string | null;
  observedAt: string;
  receivedAt: string;
  wakeEligible: boolean;
  loopDisposition: MailboxLoopDisposition;
}

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u;
const opaqueReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,4095}$/u;
const historyIdPattern = /^[1-9][0-9]{0,39}$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const credentialPattern = /(?:^|[._:/-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/iu;

export function createMailboxSubscriptionState(
  input: CreateMailboxSubscriptionStateInput,
): MailboxSubscriptionState {
  const mailboxBindingId = boundedIdentity(input.mailboxBindingId, "Mailbox binding ID");
  const provider = mailboxProvider(input.provider);
  const scope = createScope(input.scope);
  const cursor = createCursor(input.cursor);
  validateProviderContract(provider, scope, cursor);
  const coverage = enumValue(input.coverage, "Mailbox coverage", [
    "continuous",
    "unknown",
  ] as const);
  const subscription = createSubscription(input.subscription);
  const lastNotificationId = optionalIdentity(
    input.lastNotificationId,
    "Mailbox notification ID",
  );
  const lastSuccessfulReconciliationAt = optionalTimestamp(
    input.lastSuccessfulReconciliationAt,
    "Mailbox reconciliation time",
  );

  return deepFreeze({
    version: 1 as const,
    mailboxBindingId,
    provider,
    scope,
    cursor,
    coverage,
    subscription,
    lastNotificationId,
    lastSuccessfulReconciliationAt,
  });
}

export function createMailboxObservation(
  input: CreateMailboxObservationInput,
): MailboxObservation {
  const provider = mailboxProvider(input.provider);
  const mailboxBindingId = boundedIdentity(input.mailboxBindingId, "Mailbox binding ID");
  const sourceSchema = enumValue(input.sourceSchema, "Mailbox source schema", [
    "gmail-history",
    "gmail-subscription",
    "outlook-delta",
    "outlook-subscription",
  ] as const);
  validateSourceSchema(provider, sourceSchema);
  const sourceEventId = boundedIdentity(input.sourceEventId, "Mailbox source event ID");
  const eventType = normalizeEventType(input.eventType);
  const providerCursor = provider === "gmail"
    ? gmailHistoryId(input.providerCursor, "Gmail history cursor")
    : boundedOpaqueReference(input.providerCursor, "Outlook delta cursor reference");
  const providerMessageId = optionalIdentity(
    input.providerMessageId,
    "Mailbox provider message ID",
  );
  const providerThreadId = optionalIdentity(
    input.providerThreadId,
    "Mailbox provider thread ID",
  );
  if (
    input.providerScopeId !== undefined
    && input.providerLabelId !== undefined
    && input.providerScopeId !== input.providerLabelId
  ) {
    throw new RangeError("Mailbox provider scope identity is inconsistent");
  }
  const rawScopeId = input.providerScopeId !== undefined
    ? input.providerScopeId
    : input.providerLabelId ?? null;
  const providerScopeId = optionalIdentity(
    rawScopeId,
    "Mailbox provider scope ID",
  );
  validateEventIdentity(
    eventType,
    providerMessageId,
    providerThreadId,
    providerScopeId,
  );
  const observedAt = canonicalTimestamp(input.observedAt, "Mailbox observed time");
  const receivedAt = canonicalTimestamp(input.receivedAt, "Mailbox received time");
  if (Date.parse(observedAt) > Date.parse(receivedAt) + 5 * 60_000) {
    throw new RangeError("Mailbox observed time is too far in the future");
  }
  if (typeof input.wakeEligible !== "boolean") {
    throw new RangeError("Mailbox wake eligibility must be boolean");
  }
  const loopDisposition = enumValue(
    input.loopDisposition,
    "Mailbox loop disposition",
    ["ordinary", "self_echo", "automatic"] as const,
  );

  const canonicalSemantics = {
    version: 2 as const,
    provider,
    mailboxBindingId,
    sourceSchema,
    sourceEventId,
    eventType,
    providerCursor,
    providerMessageId,
    providerThreadId,
    providerScopeId,
    observedAt,
    receivedAt,
    wakeEligible: input.wakeEligible,
    loopDisposition,
    containsRawContent: false as const,
    grantsAuthority: false as const,
  };
  const semanticFingerprint = fingerprintCanonicalRequest(canonicalSemantics);
  const identityDigest = fingerprintCanonicalRequest({
    version: 2,
    provider,
    mailboxBindingId,
    sourceSchema,
    sourceEventId,
    eventType,
  }).slice("sha256:".length);

  return deepFreeze({
    ...canonicalSemantics,
    observationId: `mail:${provider}:${identityDigest}`,
    semanticFingerprint,
  });
}

function normalizeEventType(value: unknown): MailboxObservationEventType {
  if (value === "mail.label.added") return "mail.scope.added";
  if (value === "mail.label.removed") return "mail.scope.removed";
  return enumValue(
    value,
    "Mailbox observation event type",
    mailboxObservationEventTypes,
  );
}

function createScope(value: MailboxScope): MailboxScope {
  if (!isRecord(value)) throw new RangeError("Mailbox scope must be a record");
  const kind = enumValue(value.kind, "Mailbox scope kind", ["label", "folder"] as const);
  return deepFreeze({
    kind,
    externalId: boundedIdentity(value.externalId, "Mailbox scope identity"),
  });
}

function createCursor(value: MailboxCursor): MailboxCursor {
  if (!isRecord(value)) throw new RangeError("Mailbox cursor must be a record");
  if (value.kind === "gmail_history_id") {
    return deepFreeze({
      kind: "gmail_history_id" as const,
      value: gmailHistoryId(value.value, "Gmail history cursor"),
    });
  }
  if (value.kind === "outlook_delta_ref") {
    return deepFreeze({
      kind: "outlook_delta_ref" as const,
      value: boundedOpaqueReference(value.value, "Outlook delta cursor reference"),
    });
  }
  throw new RangeError("Mailbox cursor kind is invalid");
}

function createSubscription(
  value: MailboxSubscriptionProjection,
): MailboxSubscriptionProjection {
  if (!isRecord(value)) throw new RangeError("Mailbox subscription must be a record");
  return deepFreeze({
    externalId: optionalIdentity(value.externalId, "Mailbox subscription ID"),
    expiresAt: optionalTimestamp(value.expiresAt, "Mailbox subscription expiration"),
    health: enumValue(value.health, "Mailbox subscription health", [
      "healthy",
      "degraded",
      "recovering",
    ] as const),
    recoveryReason: value.recoveryReason === null
      ? null
      : boundedIdentity(value.recoveryReason, "Mailbox subscription recovery reason"),
  });
}

function validateProviderContract(
  provider: MailboxProvider,
  scope: MailboxScope,
  cursor: MailboxCursor,
): void {
  if (provider === "gmail") {
    if (scope.kind !== "label") {
      throw new RangeError("Gmail mailbox scope must be a label");
    }
    if (cursor.kind !== "gmail_history_id") {
      throw new RangeError("Gmail mailbox cursor must be a history ID");
    }
    return;
  }
  if (scope.kind !== "folder") {
    throw new RangeError("Outlook mailbox scope must be a folder");
  }
  if (cursor.kind !== "outlook_delta_ref") {
    throw new RangeError("Outlook mailbox cursor must be a delta reference");
  }
}

function validateSourceSchema(
  provider: MailboxProvider,
  sourceSchema: MailboxObservationSourceSchema,
): void {
  if (provider === "gmail" && !sourceSchema.startsWith("gmail-")) {
    throw new RangeError("Gmail mailbox observations require a Gmail source schema");
  }
  if (provider === "outlook" && !sourceSchema.startsWith("outlook-")) {
    throw new RangeError("Outlook mailbox observations require an Outlook source schema");
  }
}

function validateEventIdentity(
  eventType: MailboxObservationEventType,
  providerMessageId: string | null,
  providerThreadId: string | null,
  providerScopeId: string | null,
): void {
  if (eventType.startsWith("mail.message.") && providerMessageId === null) {
    throw new RangeError("Mailbox message observations require a provider message ID");
  }
  if (eventType.startsWith("mail.scope.")) {
    if (providerMessageId === null || providerScopeId === null) {
      throw new RangeError("Mailbox scope observations require message and scope identities");
    }
  }
  if (eventType.startsWith("mail.subscription.")) {
    if (
      providerMessageId !== null
      || providerThreadId !== null
      || providerScopeId !== null
    ) {
      throw new RangeError(
        "Mailbox subscription observations cannot bind message, thread, or scope identities",
      );
    }
  }
}

function mailboxProvider(value: unknown): MailboxProvider {
  return enumValue(value, "Mailbox provider", ["gmail", "outlook"] as const);
}

function gmailHistoryId(value: unknown, label: string): string {
  return exactText(value, label, 40, historyIdPattern);
}

function boundedIdentity(value: unknown, label: string): string {
  return credentialSafe(exactText(value, label, 1_024, identityPattern), label);
}

function boundedOpaqueReference(value: unknown, label: string): string {
  return credentialSafe(exactText(value, label, 4_096, opaqueReferencePattern), label);
}

function optionalIdentity(value: unknown, label: string): string | null {
  return value === null ? null : boundedIdentity(value, label);
}

function exactText(
  value: unknown,
  label: string,
  maximumLength: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || unsafeTextPattern.test(value)
    || (pattern && !pattern.test(value))
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function credentialSafe(value: string, label: string): string {
  if (credentialPattern.test(value)) {
    throw new RangeError(`${label} cannot be credential-shaped`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError(`${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} is invalid`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new RangeError(`${label} must be canonical ISO time`);
  return canonical;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : canonicalTimestamp(value, label);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
