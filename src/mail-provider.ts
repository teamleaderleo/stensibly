import {
  exactMailDisplayText,
  exactMailThreadIdentifier,
  exactMailThreadSha256,
  exactMailThreadTimestamp,
} from "./mail-thread-contract.js";

export interface MailboxBinding {
  provider: string;
  accountBinding: string;
  mailboxAddress: string;
}

export type MailProviderRfcMessageIdMode = "caller_assigned" | "provider_assigned";

export interface MailProviderMessage {
  outboundEffectId: string;
  threadId: string;
  handle: string;
  contentFingerprint: string;
  rfcMessageId: string | null;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: readonly string[];
}

export interface MailProviderSendResult {
  providerThreadId: string;
  providerMessageId: string;
  providerRequestId: string | null;
  rfcMessageId: string | null;
  acceptedAt: string;
}

export interface MailProviderProjection {
  version: 1;
  threadId: string;
  provider: string;
  accountBinding: string;
  providerThreadId: string;
  rootProviderMessageId: string;
  latestProviderMessageId: string;
  rootRfcMessageId: string | null;
  latestRfcMessageId: string | null;
  latestSentFingerprint: string;
  lastVerifiedSubject: string;
  lastVerifiedReferences: readonly string[];
  verifiedAt: string;
}

export type MailProviderDeliveryLookup =
  | {
      status: "found";
      result: MailProviderSendResult;
    }
  | {
      status: "missing";
      coverage: "complete" | "unknown";
    }
  | {
      status: "ambiguous";
      candidateCount: number;
    };

export interface MailProvider {
  readonly provider: string;
  readonly rfcMessageIdMode: MailProviderRfcMessageIdMode;
  createThread(
    binding: MailboxBinding,
    message: MailProviderMessage,
  ): Promise<MailProviderSendResult>;
  replyThread(
    binding: MailboxBinding,
    projection: MailProviderProjection,
    message: MailProviderMessage,
  ): Promise<MailProviderSendResult>;
  getDeliveryProjection(
    binding: MailboxBinding,
    input: {
      outboundEffectId: string;
      rfcMessageId: string | null;
      expectedProviderThreadId: string | null;
    },
  ): Promise<MailProviderDeliveryLookup>;
}

export type MailDeliveryResult = "sent" | "ambiguous" | "failed" | "reconciled";

export interface MailDeliveryReceipt {
  version: 1;
  outboundEffectId: string;
  threadId: string;
  handle: string;
  provider: string;
  accountBinding: string;
  attemptNumber: number;
  contentFingerprint: string;
  rfcMessageId: string | null;
  providerRequestId: string | null;
  providerThreadId: string | null;
  providerMessageId: string | null;
  attemptedAt: string;
  result: MailDeliveryResult;
  failureClass: string | null;
  recoveryAction: "none" | "reconcile_before_retry" | "retry_new_attempt";
  containsSecrets: false;
}

export interface MailOutboundEffectRecord {
  version: 1;
  outboundEffectId: string;
  threadId: string;
  handle: string;
  provider: string;
  accountBinding: string;
  attemptNumber: number;
  contentFingerprint: string;
  rfcMessageId: string | null;
  reservedAt: string;
  state: "reserved" | MailDeliveryResult;
  receipt: MailDeliveryReceipt | null;
}

export interface MailDeliveryReservation {
  outcome: "reserved" | "replay" | "conflict" | "blocked";
  effect: MailOutboundEffectRecord;
}

export class MailProviderDefiniteFailure extends Error {
  readonly code: string;

  constructor(code: string, message = "Mail provider rejected the delivery before an ambiguous effect") {
    super(message);
    this.name = "MailProviderDefiniteFailure";
    this.code = exactMailThreadIdentifier(code, "Mail provider failure code", 160);
  }
}

export class MailProviderAmbiguousFailure extends Error {
  readonly code: string;

  constructor(code: string, message = "Mail provider delivery outcome is ambiguous") {
    super(message);
    this.name = "MailProviderAmbiguousFailure";
    this.code = exactMailThreadIdentifier(code, "Mail provider ambiguity code", 160);
  }
}

export function freezeMailboxBinding(input: MailboxBinding): MailboxBinding {
  return Object.freeze({
    provider: exactProvider(input.provider),
    accountBinding: exactMailThreadIdentifier(
      input.accountBinding,
      "Mail provider account binding",
      240,
    ),
    mailboxAddress: exactMailboxAddress(input.mailboxAddress),
  });
}

export function freezeMailProviderMessage(input: MailProviderMessage): MailProviderMessage {
  if (!Array.isArray(input.references) || input.references.length > 32) {
    throw new TypeError("Mail provider references are invalid");
  }
  const references = input.references.map((value) => exactRfcMessageId(value));
  const rfcMessageId = optionalRfcMessageId(input.rfcMessageId);
  const inReplyTo = input.inReplyTo === null ? null : exactRfcMessageId(input.inReplyTo);
  if (rfcMessageId === null && (inReplyTo !== null || references.length !== 0)) {
    throw new TypeError("Provider-assigned RFC identity cannot carry caller-assigned reply ancestry");
  }
  if (inReplyTo === null && references.length !== 0) {
    throw new TypeError("Root mail provider message cannot carry reply references");
  }
  if (inReplyTo !== null && references.at(-1) !== inReplyTo) {
    throw new TypeError("Mail provider reply references must end at In-Reply-To");
  }
  const body = exactMailBody(input.body);
  return Object.freeze({
    outboundEffectId: exactMailThreadIdentifier(
      input.outboundEffectId,
      "Mail outbound effect ID",
      240,
    ),
    threadId: exactMailThreadIdentifier(input.threadId, "Mail provider thread ID", 240),
    handle: exactMailThreadIdentifier(input.handle, "Mail provider handle", 80),
    contentFingerprint: exactMailThreadSha256(
      input.contentFingerprint,
      "Mail provider content fingerprint",
    ),
    rfcMessageId,
    subject: exactMailDisplayText(input.subject, "Mail provider subject", 320),
    body,
    inReplyTo,
    references: Object.freeze(references),
  });
}

export function freezeMailProviderSendResult(
  input: MailProviderSendResult,
): MailProviderSendResult {
  return Object.freeze({
    providerThreadId: exactMailThreadIdentifier(
      input.providerThreadId,
      "Provider mail thread ID",
      320,
    ),
    providerMessageId: exactMailThreadIdentifier(
      input.providerMessageId,
      "Provider mail message ID",
      320,
    ),
    providerRequestId: input.providerRequestId === null
      ? null
      : exactMailThreadIdentifier(
          input.providerRequestId,
          "Provider mail request ID",
          320,
        ),
    rfcMessageId: optionalRfcMessageId(input.rfcMessageId),
    acceptedAt: exactMailThreadTimestamp(input.acceptedAt, "Provider mail acceptance time"),
  });
}

export function freezeMailProviderProjection(
  input: MailProviderProjection,
): MailProviderProjection {
  if (input.version !== 1) throw new TypeError("Mail provider projection version is invalid");
  if (!Array.isArray(input.lastVerifiedReferences) || input.lastVerifiedReferences.length > 32) {
    throw new TypeError("Mail provider projection references are invalid");
  }
  const references = input.lastVerifiedReferences.map((value) => exactRfcMessageId(value));
  return Object.freeze({
    version: 1,
    threadId: exactMailThreadIdentifier(input.threadId, "Mail projection thread ID", 240),
    provider: exactProvider(input.provider),
    accountBinding: exactMailThreadIdentifier(
      input.accountBinding,
      "Mail projection account binding",
      240,
    ),
    providerThreadId: exactMailThreadIdentifier(
      input.providerThreadId,
      "Mail projection provider thread ID",
      320,
    ),
    rootProviderMessageId: exactMailThreadIdentifier(
      input.rootProviderMessageId,
      "Mail projection root message ID",
      320,
    ),
    latestProviderMessageId: exactMailThreadIdentifier(
      input.latestProviderMessageId,
      "Mail projection latest message ID",
      320,
    ),
    rootRfcMessageId: optionalRfcMessageId(input.rootRfcMessageId),
    latestRfcMessageId: optionalRfcMessageId(input.latestRfcMessageId),
    latestSentFingerprint: exactMailThreadSha256(
      input.latestSentFingerprint,
      "Mail projection latest fingerprint",
    ),
    lastVerifiedSubject: exactMailDisplayText(
      input.lastVerifiedSubject,
      "Mail projection verified subject",
      320,
    ),
    lastVerifiedReferences: Object.freeze(references),
    verifiedAt: exactMailThreadTimestamp(input.verifiedAt, "Mail projection verification time"),
  });
}

export function freezeMailDeliveryReceipt(
  input: MailDeliveryReceipt,
): MailDeliveryReceipt {
  if (input.version !== 1 || !Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new TypeError("Mail delivery receipt is invalid");
  }
  const result = exactDeliveryResult(input.result);
  const providerThreadId = input.providerThreadId === null
    ? null
    : exactMailThreadIdentifier(input.providerThreadId, "Receipt provider thread ID", 320);
  const providerMessageId = input.providerMessageId === null
    ? null
    : exactMailThreadIdentifier(input.providerMessageId, "Receipt provider message ID", 320);
  if ((result === "sent" || result === "reconciled") && (providerThreadId === null || providerMessageId === null)) {
    throw new TypeError("Successful mail delivery receipt requires provider identities");
  }
  return Object.freeze({
    version: 1,
    outboundEffectId: exactMailThreadIdentifier(
      input.outboundEffectId,
      "Mail receipt outbound effect ID",
      240,
    ),
    threadId: exactMailThreadIdentifier(input.threadId, "Mail receipt thread ID", 240),
    handle: exactMailThreadIdentifier(input.handle, "Mail receipt handle", 80),
    provider: exactProvider(input.provider),
    accountBinding: exactMailThreadIdentifier(
      input.accountBinding,
      "Mail receipt account binding",
      240,
    ),
    attemptNumber: input.attemptNumber,
    contentFingerprint: exactMailThreadSha256(
      input.contentFingerprint,
      "Mail receipt content fingerprint",
    ),
    rfcMessageId: optionalRfcMessageId(input.rfcMessageId),
    providerRequestId: input.providerRequestId === null
      ? null
      : exactMailThreadIdentifier(input.providerRequestId, "Mail receipt provider request ID", 320),
    providerThreadId,
    providerMessageId,
    attemptedAt: exactMailThreadTimestamp(input.attemptedAt, "Mail receipt attempt time"),
    result,
    failureClass: input.failureClass === null
      ? null
      : exactMailThreadIdentifier(input.failureClass, "Mail receipt failure class", 160),
    recoveryAction: exactRecoveryAction(input.recoveryAction),
    containsSecrets: false,
  });
}

export function exactRfcMessageId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 5
    || value.length > 320
    || value !== value.trim()
    || !/^<[^<>\s@]+@[^<>\s@]+>$/u.test(value)
    || /[\r\n]/u.test(value)
  ) {
    throw new TypeError("RFC Message-ID is invalid");
  }
  return value;
}

export function optionalRfcMessageId(value: unknown): string | null {
  return value === null ? null : exactRfcMessageId(value);
}

function exactProvider(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value)
  ) {
    throw new TypeError("Mail provider name is invalid");
  }
  return value;
}

function exactMailboxAddress(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 320
    || value !== value.trim()
    || /[\r\n]/u.test(value)
    || !/^[^\s<>@]+@[^\s<>@]+$/u.test(value)
  ) {
    throw new TypeError("Mail provider mailbox address is invalid");
  }
  return value;
}

function exactMailBody(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > 12 * 1024
    || /\u0000/u.test(value)
  ) {
    throw new TypeError("Mail provider body is invalid");
  }
  return value;
}

function exactDeliveryResult(value: unknown): MailDeliveryResult {
  if (value === "sent" || value === "ambiguous" || value === "failed" || value === "reconciled") {
    return value;
  }
  throw new TypeError("Mail delivery result is invalid");
}

function exactRecoveryAction(
  value: unknown,
): MailDeliveryReceipt["recoveryAction"] {
  if (value === "none" || value === "reconcile_before_retry" || value === "retry_new_attempt") {
    return value;
  }
  throw new TypeError("Mail delivery recovery action is invalid");
}
