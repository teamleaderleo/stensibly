import {
  MailProviderAmbiguousFailure,
  MailProviderDefiniteFailure,
  exactRfcMessageId,
  freezeMailboxBinding,
  freezeMailProviderMessage,
  freezeMailProviderProjection,
  freezeMailProviderSendResult,
  type MailboxBinding,
  type MailProvider,
  type MailProviderDeliveryLookup,
  type MailProviderMessage,
  type MailProviderProjection,
  type MailProviderSendResult,
} from "./mail-provider.js";
import {
  exactMailDisplayText,
  exactMailThreadIdentifier,
  exactMailThreadTimestamp,
} from "./mail-thread-contract.js";

export interface GmailSendRawResult {
  id: string;
  threadId: string;
  requestId?: string | null;
  acceptedAt?: string | null;
}

export interface GmailLocatedMessage {
  id: string;
  threadId: string;
  rfcMessageId: string;
  outboundEffectId: string;
  subject: string;
  references?: readonly string[];
  requestId?: string | null;
  acceptedAt?: string | null;
}

export interface GmailOutboundClient {
  sendRaw(input: {
    raw: string;
    threadId?: string;
  }): Promise<unknown>;
  findMessagesByRfcMessageId(input: {
    rfcMessageId: string;
  }): Promise<readonly unknown[]>;
}

const maximumReconciliationCandidates = 64;

export class GmailMailProvider implements MailProvider {
  readonly provider = "gmail";
  readonly #client: GmailOutboundClient;
  readonly #now: () => string;

  constructor(
    client: GmailOutboundClient,
    options: { now?: () => string } = {},
  ) {
    this.#client = client;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async createThread(
    bindingInput: MailboxBinding,
    messageInput: MailProviderMessage,
  ): Promise<MailProviderSendResult> {
    const binding = this.#binding(bindingInput);
    const message = freezeMailProviderMessage(messageInput);
    if (message.inReplyTo !== null || message.references.length !== 0) {
      throw new MailProviderDefiniteFailure("gmail_root_has_reply_ancestry");
    }
    return this.#dispatch(binding, message, null);
  }

  async replyThread(
    bindingInput: MailboxBinding,
    projectionInput: MailProviderProjection,
    messageInput: MailProviderMessage,
  ): Promise<MailProviderSendResult> {
    const binding = this.#binding(bindingInput);
    const projection = freezeMailProviderProjection(projectionInput);
    const message = freezeMailProviderMessage(messageInput);
    if (
      projection.provider !== "gmail"
      || projection.accountBinding !== binding.accountBinding
      || projection.mailboxAddress !== binding.mailboxAddress
    ) {
      throw new MailProviderDefiniteFailure("gmail_projection_binding_mismatch");
    }
    if (message.subject !== projection.lastVerifiedSubject) {
      throw new MailProviderDefiniteFailure("gmail_reply_subject_changed");
    }
    if (
      message.inReplyTo !== projection.latestRfcMessageId
      || message.references.at(-1) !== projection.latestRfcMessageId
    ) {
      throw new MailProviderDefiniteFailure("gmail_reply_ancestry_mismatch");
    }
    return this.#dispatch(binding, message, projection.providerThreadId);
  }

  async getDeliveryProjection(
    bindingInput: MailboxBinding,
    input: {
      outboundEffectId: string;
      rfcMessageId: string;
      expectedProviderThreadId: string | null;
    },
  ): Promise<MailProviderDeliveryLookup> {
    this.#binding(bindingInput);
    const outboundEffectId = exactMailThreadIdentifier(
      input.outboundEffectId,
      "Gmail reconciliation outbound effect ID",
      240,
    );
    const rfcMessageId = exactRfcMessageId(input.rfcMessageId);
    const expectedProviderThreadId = input.expectedProviderThreadId === null
      ? null
      : exactMailThreadIdentifier(
          input.expectedProviderThreadId,
          "Gmail reconciliation provider thread ID",
          320,
        );
    let rawCandidates: readonly unknown[];
    try {
      rawCandidates = await this.#client.findMessagesByRfcMessageId({ rfcMessageId });
    } catch {
      return { status: "missing", coverage: "unknown" };
    }
    if (!Array.isArray(rawCandidates)) {
      return { status: "missing", coverage: "unknown" };
    }
    if (rawCandidates.length > maximumReconciliationCandidates) {
      return { status: "ambiguous", candidateCount: rawCandidates.length };
    }
    const candidates: GmailLocatedMessage[] = [];
    for (const candidate of rawCandidates) {
      try {
        const located = admitLocatedMessage(candidate, this.#now);
        if (
          located.rfcMessageId === rfcMessageId
          && located.outboundEffectId === outboundEffectId
        ) {
          candidates.push(located);
        }
      } catch {
        return { status: "ambiguous", candidateCount: Math.max(2, rawCandidates.length) };
      }
    }
    if (candidates.length === 0) return { status: "missing", coverage: "complete" };
    if (candidates.length > 1) {
      return { status: "ambiguous", candidateCount: candidates.length };
    }
    const candidate = candidates[0]!;
    if (
      expectedProviderThreadId !== null
      && candidate.threadId !== expectedProviderThreadId
    ) {
      return { status: "ambiguous", candidateCount: 1 };
    }
    return {
      status: "found",
      result: freezeMailProviderSendResult({
        providerThreadId: candidate.threadId,
        providerMessageId: candidate.id,
        providerRequestId: candidate.requestId ?? null,
        rfcMessageId: candidate.rfcMessageId,
        acceptedAt: candidate.acceptedAt ?? exactMailThreadTimestamp(
          this.#now(),
          "Gmail reconciliation time",
        ),
      }),
    };
  }

  async #dispatch(
    binding: MailboxBinding,
    message: MailProviderMessage,
    providerThreadId: string | null,
  ): Promise<MailProviderSendResult> {
    const raw = buildGmailRawMessage(binding, message);
    let providerResult: unknown;
    try {
      providerResult = await this.#client.sendRaw({
        raw,
        ...(providerThreadId === null ? {} : { threadId: providerThreadId }),
      });
    } catch {
      throw new MailProviderAmbiguousFailure("gmail_send_outcome_ambiguous");
    }
    let admitted: GmailSendRawResult;
    try {
      admitted = admitSendResult(providerResult, this.#now);
    } catch {
      throw new MailProviderAmbiguousFailure("gmail_send_result_invalid");
    }
    if (providerThreadId !== null && admitted.threadId !== providerThreadId) {
      throw new MailProviderAmbiguousFailure("gmail_reply_thread_mismatch");
    }
    return freezeMailProviderSendResult({
      providerThreadId: admitted.threadId,
      providerMessageId: admitted.id,
      providerRequestId: admitted.requestId ?? null,
      rfcMessageId: message.rfcMessageId,
      acceptedAt: admitted.acceptedAt ?? exactMailThreadTimestamp(
        this.#now(),
        "Gmail acceptance time",
      ),
    });
  }

  #binding(input: MailboxBinding): MailboxBinding {
    const binding = freezeMailboxBinding(input);
    if (binding.provider !== "gmail") {
      throw new MailProviderDefiniteFailure("gmail_provider_binding_mismatch");
    }
    return binding;
  }
}

export function buildGmailRawMessage(
  bindingInput: MailboxBinding,
  messageInput: MailProviderMessage,
): string {
  const binding = freezeMailboxBinding(bindingInput);
  if (binding.provider !== "gmail") {
    throw new TypeError("Gmail raw message requires a Gmail mailbox binding");
  }
  const message = freezeMailProviderMessage(messageInput);
  const headers = [
    `To: ${binding.mailboxAddress}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Message-ID: ${message.rfcMessageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "Auto-Submitted: auto-generated",
    `X-Stensibly-Thread: ${message.threadId}`,
    `X-Stensibly-Handle: ${message.handle}`,
    `X-Stensibly-Effect: ${message.outboundEffectId}`,
    `X-Stensibly-Fingerprint: ${message.contentFingerprint}`,
  ];
  if (message.inReplyTo !== null) headers.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references.length > 0) headers.push(`References: ${message.references.join(" ")}`);
  const mime = `${headers.join("\r\n")}\r\n\r\n${message.body.replace(/\r?\n/gu, "\r\n")}`;
  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7E]+$/u.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function admitSendResult(value: unknown, now: () => string): GmailSendRawResult {
  const record = snapshotRecord(value, "Gmail send result");
  const allowed = new Set(["id", "threadId", "requestId", "acceptedAt"]);
  rejectUnknownKeys(record, allowed, "Gmail send result");
  return Object.freeze({
    id: exactMailThreadIdentifier(record.id, "Gmail message ID", 320),
    threadId: exactMailThreadIdentifier(record.threadId, "Gmail thread ID", 320),
    requestId: record.requestId === undefined || record.requestId === null
      ? null
      : exactMailThreadIdentifier(record.requestId, "Gmail request ID", 320),
    acceptedAt: record.acceptedAt === undefined || record.acceptedAt === null
      ? exactMailThreadTimestamp(now(), "Gmail acceptance time")
      : exactMailThreadTimestamp(record.acceptedAt, "Gmail acceptance time"),
  });
}

function admitLocatedMessage(value: unknown, now: () => string): GmailLocatedMessage {
  const record = snapshotRecord(value, "Gmail located message");
  const allowed = new Set([
    "id",
    "threadId",
    "rfcMessageId",
    "outboundEffectId",
    "subject",
    "references",
    "requestId",
    "acceptedAt",
  ]);
  rejectUnknownKeys(record, allowed, "Gmail located message");
  const referencesRaw = record.references ?? [];
  if (!Array.isArray(referencesRaw) || referencesRaw.length > 32) {
    throw new TypeError("Gmail located message references are invalid");
  }
  return Object.freeze({
    id: exactMailThreadIdentifier(record.id, "Gmail located message ID", 320),
    threadId: exactMailThreadIdentifier(record.threadId, "Gmail located thread ID", 320),
    rfcMessageId: exactRfcMessageId(record.rfcMessageId),
    outboundEffectId: exactMailThreadIdentifier(
      record.outboundEffectId,
      "Gmail located effect ID",
      240,
    ),
    subject: exactMailDisplayText(record.subject, "Gmail located subject", 320),
    references: Object.freeze(referencesRaw.map((entry) => exactRfcMessageId(entry))),
    requestId: record.requestId === undefined || record.requestId === null
      ? null
      : exactMailThreadIdentifier(record.requestId, "Gmail located request ID", 320),
    acceptedAt: record.acceptedAt === undefined || record.acceptedAt === null
      ? exactMailThreadTimestamp(now(), "Gmail located message time")
      : exactMailThreadTimestamp(record.acceptedAt, "Gmail located message time"),
  });
}

function snapshotRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must use the ordinary object prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} cannot contain symbol fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: [string, unknown][] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} contains an unsupported field`);
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains an unsupported field`);
  }
}
