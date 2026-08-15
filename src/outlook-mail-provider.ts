import {
  MailProviderAmbiguousFailure,
  MailProviderDefiniteFailure,
  freezeMailboxBinding,
  freezeMailProviderMessage,
  freezeMailProviderProjection,
  freezeMailProviderSendResult,
  optionalRfcMessageId,
  type MailboxBinding,
  type MailProvider,
  type MailProviderDeliveryLookup,
  type MailProviderMessage,
  type MailProviderProjection,
  type MailProviderSendResult,
} from "./mail-provider.js";
import {
  exactMailThreadIdentifier,
  exactMailThreadTimestamp,
} from "./mail-thread-contract.js";

export interface OutlookSendResult {
  id: string;
  conversationId: string;
  internetMessageId?: string | null;
  requestId?: string | null;
  acceptedAt?: string | null;
}

export interface OutlookLocatedMessage extends OutlookSendResult {
  outboundEffectId: string;
}

export interface OutlookOutboundClient {
  sendMessage(input: {
    to: string;
    subject: string;
    body: string;
    outboundEffectId: string;
  }): Promise<unknown>;
  replyMessage(input: {
    messageId: string;
    subject: string;
    body: string;
    outboundEffectId: string;
  }): Promise<unknown>;
  findMessagesByOutboundEffectId(input: {
    outboundEffectId: string;
  }): Promise<readonly unknown[]>;
}

const maximumReconciliationCandidates = 64;

export class OutlookMailProvider implements MailProvider {
  readonly provider = "outlook";
  readonly rfcMessageIdMode = "provider_assigned" as const;
  readonly #client: OutlookOutboundClient;
  readonly #now: () => string;

  constructor(client: OutlookOutboundClient, options: { now?: () => string } = {}) {
    this.#client = client;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async createThread(
    bindingInput: MailboxBinding,
    messageInput: MailProviderMessage,
  ): Promise<MailProviderSendResult> {
    const binding = this.#binding(bindingInput);
    const message = this.#message(messageInput);
    let raw: unknown;
    try {
      raw = await this.#client.sendMessage({
        to: binding.mailboxAddress,
        subject: message.subject,
        body: message.body,
        outboundEffectId: message.outboundEffectId,
      });
    } catch {
      throw new MailProviderAmbiguousFailure("outlook_send_outcome_ambiguous");
    }
    return this.#admitSendResult(raw, "Outlook send result");
  }

  async replyThread(
    bindingInput: MailboxBinding,
    projectionInput: MailProviderProjection,
    messageInput: MailProviderMessage,
  ): Promise<MailProviderSendResult> {
    const binding = this.#binding(bindingInput);
    const projection = freezeMailProviderProjection(projectionInput);
    const message = this.#message(messageInput);
    if (
      projection.provider !== "outlook"
      || projection.accountBinding !== binding.accountBinding
      || projection.mailboxAddress !== binding.mailboxAddress
    ) {
      throw new MailProviderDefiniteFailure("outlook_projection_binding_mismatch");
    }
    if (message.subject !== projection.lastVerifiedSubject) {
      throw new MailProviderDefiniteFailure("outlook_reply_subject_changed");
    }

    let raw: unknown;
    try {
      raw = await this.#client.replyMessage({
        messageId: projection.latestProviderMessageId,
        subject: message.subject,
        body: message.body,
        outboundEffectId: message.outboundEffectId,
      });
    } catch {
      throw new MailProviderAmbiguousFailure("outlook_reply_outcome_ambiguous");
    }
    const result = this.#admitSendResult(raw, "Outlook reply result");
    if (result.providerThreadId !== projection.providerThreadId) {
      throw new MailProviderAmbiguousFailure("outlook_reply_conversation_mismatch");
    }
    return result;
  }

  async getDeliveryProjection(
    bindingInput: MailboxBinding,
    input: {
      outboundEffectId: string;
      rfcMessageId: string | null;
      expectedProviderThreadId: string | null;
    },
  ): Promise<MailProviderDeliveryLookup> {
    this.#binding(bindingInput);
    const outboundEffectId = exactMailThreadIdentifier(
      input.outboundEffectId,
      "Outlook reconciliation outbound effect ID",
      240,
    );
    if (input.rfcMessageId !== null) {
      throw new MailProviderDefiniteFailure(
        "outlook_reconciliation_uses_provider_assigned_rfc_identity",
      );
    }
    const expectedProviderThreadId = input.expectedProviderThreadId === null
      ? null
      : exactMailThreadIdentifier(
          input.expectedProviderThreadId,
          "Outlook reconciliation conversation ID",
          320,
        );

    let rawCandidates: readonly unknown[];
    try {
      rawCandidates = await this.#client.findMessagesByOutboundEffectId({ outboundEffectId });
    } catch {
      return { status: "missing", coverage: "unknown" };
    }
    if (!Array.isArray(rawCandidates)) return { status: "missing", coverage: "unknown" };
    if (rawCandidates.length > maximumReconciliationCandidates) {
      return { status: "ambiguous", candidateCount: rawCandidates.length };
    }

    const candidates: OutlookLocatedMessage[] = [];
    for (const candidate of rawCandidates) {
      try {
        const located = admitLocatedMessage(candidate, this.#now);
        if (located.outboundEffectId === outboundEffectId) candidates.push(located);
      } catch {
        return { status: "ambiguous", candidateCount: Math.max(2, rawCandidates.length) };
      }
    }
    if (candidates.length === 0) return { status: "missing", coverage: "complete" };
    if (candidates.length > 1) return { status: "ambiguous", candidateCount: candidates.length };
    const candidate = candidates[0]!;
    if (expectedProviderThreadId !== null && candidate.conversationId !== expectedProviderThreadId) {
      return { status: "ambiguous", candidateCount: 1 };
    }
    return {
      status: "found",
      result: freezeMailProviderSendResult({
        providerThreadId: candidate.conversationId,
        providerMessageId: candidate.id,
        providerRequestId: candidate.requestId ?? null,
        rfcMessageId: candidate.internetMessageId ?? null,
        acceptedAt: candidate.acceptedAt ?? exactMailThreadTimestamp(
          this.#now(),
          "Outlook reconciliation time",
        ),
      }),
    };
  }

  #admitSendResult(value: unknown, label: string): MailProviderSendResult {
    const admitted = admitSendResult(value, this.#now, label);
    return freezeMailProviderSendResult({
      providerThreadId: admitted.conversationId,
      providerMessageId: admitted.id,
      providerRequestId: admitted.requestId ?? null,
      rfcMessageId: admitted.internetMessageId ?? null,
      acceptedAt: admitted.acceptedAt ?? exactMailThreadTimestamp(
        this.#now(),
        "Outlook acceptance time",
      ),
    });
  }

  #binding(input: MailboxBinding): MailboxBinding {
    const binding = freezeMailboxBinding(input);
    if (binding.provider !== "outlook") {
      throw new MailProviderDefiniteFailure("outlook_provider_binding_mismatch");
    }
    return binding;
  }

  #message(input: MailProviderMessage): MailProviderMessage {
    const message = freezeMailProviderMessage(input);
    if (
      message.rfcMessageId !== null
      || message.inReplyTo !== null
      || message.references.length !== 0
    ) {
      throw new MailProviderDefiniteFailure(
        "outlook_requires_provider_assigned_rfc_identity",
      );
    }
    return message;
  }
}

function admitSendResult(
  value: unknown,
  now: () => string,
  label: string,
): OutlookSendResult {
  const record = snapshotRecord(value, label);
  rejectUnknownKeys(
    record,
    new Set(["id", "conversationId", "internetMessageId", "requestId", "acceptedAt"]),
    label,
  );
  return Object.freeze({
    id: exactMailThreadIdentifier(record.id, `${label} message ID`, 320),
    conversationId: exactMailThreadIdentifier(
      record.conversationId,
      `${label} conversation ID`,
      320,
    ),
    internetMessageId: record.internetMessageId === undefined
      ? null
      : optionalRfcMessageId(record.internetMessageId),
    requestId: record.requestId === undefined || record.requestId === null
      ? null
      : exactMailThreadIdentifier(record.requestId, `${label} request ID`, 320),
    acceptedAt: record.acceptedAt === undefined || record.acceptedAt === null
      ? exactMailThreadTimestamp(now(), `${label} time`)
      : exactMailThreadTimestamp(record.acceptedAt, `${label} time`),
  });
}

function admitLocatedMessage(
  value: unknown,
  now: () => string,
): OutlookLocatedMessage {
  const record = snapshotRecord(value, "Outlook located message");
  rejectUnknownKeys(
    record,
    new Set([
      "id",
      "conversationId",
      "internetMessageId",
      "outboundEffectId",
      "requestId",
      "acceptedAt",
    ]),
    "Outlook located message",
  );
  return Object.freeze({
    id: exactMailThreadIdentifier(record.id, "Outlook located message ID", 320),
    conversationId: exactMailThreadIdentifier(
      record.conversationId,
      "Outlook located conversation ID",
      320,
    ),
    internetMessageId: record.internetMessageId === undefined
      ? null
      : optionalRfcMessageId(record.internetMessageId),
    outboundEffectId: exactMailThreadIdentifier(
      record.outboundEffectId,
      "Outlook located outbound effect ID",
      240,
    ),
    requestId: record.requestId === undefined || record.requestId === null
      ? null
      : exactMailThreadIdentifier(record.requestId, "Outlook located request ID", 320),
    acceptedAt: record.acceptedAt === undefined || record.acceptedAt === null
      ? exactMailThreadTimestamp(now(), "Outlook located message time")
      : exactMailThreadTimestamp(record.acceptedAt, "Outlook located message time"),
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
  const entries: [string, unknown][] = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
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
