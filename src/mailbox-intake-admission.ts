import {
  canonicalJsonString,
  fingerprintCanonicalRequest,
} from "./idempotency-request-fingerprint.js";
import {
  createMailboxObservation,
  createMailboxSubscriptionState,
  type MailboxObservation,
  type MailboxSubscriptionState,
} from "./mailbox-intake-contract.js";

export const MAXIMUM_MAILBOX_INTAKE_JSON_BYTES = 64 * 1024;

const stateKeys = [
  "coverage",
  "cursor",
  "lastNotificationId",
  "lastSuccessfulReconciliationAt",
  "mailboxBindingId",
  "provider",
  "scope",
  "subscription",
  "version",
] as const;
const scopeKeys = ["externalId", "kind"] as const;
const cursorKeys = ["kind", "value"] as const;
const subscriptionKeys = [
  "expiresAt",
  "externalId",
  "health",
  "recoveryReason",
] as const;
const observationV2Keys = [
  "containsRawContent",
  "eventType",
  "grantsAuthority",
  "loopDisposition",
  "mailboxBindingId",
  "observationId",
  "observedAt",
  "provider",
  "providerCursor",
  "providerMessageId",
  "providerScopeId",
  "providerThreadId",
  "receivedAt",
  "semanticFingerprint",
  "sourceEventId",
  "sourceSchema",
  "version",
  "wakeEligible",
] as const;
const observationV1Keys = [
  "containsRawContent",
  "eventType",
  "grantsAuthority",
  "loopDisposition",
  "mailboxBindingId",
  "observationId",
  "observedAt",
  "provider",
  "providerCursor",
  "providerLabelId",
  "providerMessageId",
  "providerThreadId",
  "receivedAt",
  "semanticFingerprint",
  "sourceEventId",
  "sourceSchema",
  "version",
  "wakeEligible",
] as const;
const legacyObservationEventTypes = [
  "mail.message.created",
  "mail.message.updated",
  "mail.message.deleted",
  "mail.label.added",
  "mail.label.removed",
  "mail.subscription.degraded",
  "mail.subscription.recovered",
] as const;

export function admitMailboxSubscriptionStateJson(
  value: unknown,
): MailboxSubscriptionState {
  const decoded = parseCanonicalRecord(value, "Mailbox subscription state");
  requireExactKeys(decoded, stateKeys, "Mailbox subscription state");
  requireExactKeys(decoded.scope, scopeKeys, "Mailbox subscription scope");
  requireExactKeys(decoded.cursor, cursorKeys, "Mailbox subscription cursor");
  requireExactKeys(
    decoded.subscription,
    subscriptionKeys,
    "Mailbox subscription projection",
  );
  if (decoded.version !== 1) {
    throw new RangeError("Mailbox subscription state version is invalid");
  }

  return createMailboxSubscriptionState({
    mailboxBindingId: decoded.mailboxBindingId as never,
    provider: decoded.provider as never,
    scope: decoded.scope as never,
    cursor: decoded.cursor as never,
    coverage: decoded.coverage as never,
    subscription: decoded.subscription as never,
    lastNotificationId: decoded.lastNotificationId as never,
    lastSuccessfulReconciliationAt:
      decoded.lastSuccessfulReconciliationAt as never,
  });
}

export function admitMailboxObservationJson(value: unknown): MailboxObservation {
  const decoded = parseCanonicalRecord(value, "Mailbox observation");
  if (decoded.version === 1) return admitLegacyMailboxObservationV1(decoded);
  if (decoded.version !== 2) {
    throw new RangeError("Mailbox observation version is invalid");
  }
  requireExactKeys(decoded, observationV2Keys, "Mailbox observation");
  const recreated = createMailboxObservation({
    provider: decoded.provider as never,
    mailboxBindingId: decoded.mailboxBindingId as never,
    sourceSchema: decoded.sourceSchema as never,
    sourceEventId: decoded.sourceEventId as never,
    eventType: decoded.eventType as never,
    providerCursor: decoded.providerCursor as never,
    providerMessageId: decoded.providerMessageId as never,
    providerThreadId: decoded.providerThreadId as never,
    providerScopeId: decoded.providerScopeId as never,
    observedAt: decoded.observedAt as never,
    receivedAt: decoded.receivedAt as never,
    wakeEligible: decoded.wakeEligible as never,
    loopDisposition: decoded.loopDisposition as never,
  });
  if (
    decoded.observationId !== recreated.observationId
    || decoded.semanticFingerprint !== recreated.semanticFingerprint
    || decoded.containsRawContent !== false
    || decoded.grantsAuthority !== false
  ) {
    throw new RangeError("Mailbox observation identity is inconsistent");
  }
  return recreated;
}

function admitLegacyMailboxObservationV1(
  decoded: Record<string, unknown>,
): MailboxObservation {
  requireExactKeys(decoded, observationV1Keys, "Legacy mailbox observation");
  if (
    typeof decoded.eventType !== "string"
    || !legacyObservationEventTypes.includes(
      decoded.eventType as typeof legacyObservationEventTypes[number],
    )
  ) {
    throw new RangeError("Legacy mailbox observation event type is invalid");
  }
  if (decoded.containsRawContent !== false || decoded.grantsAuthority !== false) {
    throw new RangeError("Mailbox observation identity is inconsistent");
  }

  const legacySemantics = {
    version: 1 as const,
    provider: decoded.provider,
    mailboxBindingId: decoded.mailboxBindingId,
    sourceSchema: decoded.sourceSchema,
    sourceEventId: decoded.sourceEventId,
    eventType: decoded.eventType,
    providerCursor: decoded.providerCursor,
    providerMessageId: decoded.providerMessageId,
    providerThreadId: decoded.providerThreadId,
    providerLabelId: decoded.providerLabelId,
    observedAt: decoded.observedAt,
    receivedAt: decoded.receivedAt,
    wakeEligible: decoded.wakeEligible,
    loopDisposition: decoded.loopDisposition,
    containsRawContent: false as const,
    grantsAuthority: false as const,
  };
  const expectedSemanticFingerprint = fingerprintCanonicalRequest(legacySemantics);
  const identityDigest = fingerprintCanonicalRequest({
    version: 1,
    provider: decoded.provider,
    mailboxBindingId: decoded.mailboxBindingId,
    sourceSchema: decoded.sourceSchema,
    sourceEventId: decoded.sourceEventId,
    eventType: decoded.eventType,
  }).slice("sha256:".length);
  const expectedObservationId = `mail:${String(decoded.provider)}:${identityDigest}`;
  if (
    decoded.observationId !== expectedObservationId
    || decoded.semanticFingerprint !== expectedSemanticFingerprint
  ) {
    throw new RangeError("Mailbox observation identity is inconsistent");
  }

  return createMailboxObservation({
    provider: decoded.provider as never,
    mailboxBindingId: decoded.mailboxBindingId as never,
    sourceSchema: decoded.sourceSchema as never,
    sourceEventId: decoded.sourceEventId as never,
    eventType: decoded.eventType as never,
    providerCursor: decoded.providerCursor as never,
    providerMessageId: decoded.providerMessageId as never,
    providerThreadId: decoded.providerThreadId as never,
    providerLabelId: decoded.providerLabelId as never,
    observedAt: decoded.observedAt as never,
    receivedAt: decoded.receivedAt as never,
    wakeEligible: decoded.wakeEligible as never,
    loopDisposition: decoded.loopDisposition as never,
  });
}

function parseCanonicalRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new RangeError(`${label} must be canonical JSON text`);
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 2 || bytes > MAXIMUM_MAILBOX_INTAKE_JSON_BYTES) {
    throw new RangeError(`${label} exceeds the bounded JSON envelope`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new RangeError(`${label} must be valid JSON`);
  }
  if (!isRecord(decoded)) throw new RangeError(`${label} must be a record`);
  if (canonicalJsonString(decoded) !== value) {
    throw new RangeError(`${label} JSON must be canonical`);
  }
  return decoded;
}

function requireExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new RangeError(`${label} must be a record`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new RangeError(`${label} has noncanonical fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
