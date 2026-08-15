import {
  MailProviderAmbiguousFailure,
  MailProviderDefiniteFailure,
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

export type InMemoryMailProviderMode =
  | "normal"
  | "ambiguous_after_send"
  | "definite_failure";

interface StoredMessage {
  binding: MailboxBinding;
  message: MailProviderMessage & { rfcMessageId: string };
  result: MailProviderSendResult;
}

export class InMemoryMailProvider implements MailProvider {
  readonly provider: string;
  readonly rfcMessageIdMode = "caller_assigned" as const;
  #mode: InMemoryMailProviderMode = "normal";
  #counter = 0;
  readonly #byRfcMessageId = new Map<string, StoredMessage[]>();
  readonly #threadMessages = new Map<string, StoredMessage[]>();

  constructor(provider = "fake") {
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(provider)) {
      throw new TypeError("In-memory mail provider name is invalid");
    }
    this.provider = provider;
  }

  setMode(mode: InMemoryMailProviderMode): void {
    this.#mode = mode;
  }

  get sentMessageCount(): number {
    let count = 0;
    for (const messages of this.#threadMessages.values()) count += messages.length;
    return count;
  }

  messagesForThread(providerThreadId: string): readonly MailProviderMessage[] {
    return Object.freeze(
      (this.#threadMessages.get(providerThreadId) ?? []).map((stored) => stored.message),
    );
  }

  async createThread(
    bindingInput: MailboxBinding,
    messageInput: MailProviderMessage,
  ): Promise<MailProviderSendResult> {
    const binding = freezeMailboxBinding(bindingInput);
    this.#assertProvider(binding);
    const message = this.#message(messageInput);
    if (message.inReplyTo !== null || message.references.length !== 0) {
      throw new MailProviderDefiniteFailure("mail_root_has_reply_ancestry");
    }
    return this.#send(binding, message, null);
  }

  async replyThread(
    bindingInput: MailboxBinding,
    projectionInput: MailProviderProjection,
    messageInput: MailProviderMessage,
  ): Promise<MailProviderSendResult> {
    const binding = freezeMailboxBinding(bindingInput);
    this.#assertProvider(binding);
    const projection = freezeMailProviderProjection(projectionInput);
    const message = this.#message(messageInput);
    if (
      projection.provider !== this.provider
      || projection.accountBinding !== binding.accountBinding
    ) {
      throw new MailProviderDefiniteFailure("mail_projection_binding_mismatch");
    }
    if (
      projection.latestRfcMessageId === null
      || message.inReplyTo !== projection.latestRfcMessageId
      || message.references.at(-1) !== projection.latestRfcMessageId
    ) {
      throw new MailProviderDefiniteFailure("mail_reply_ancestry_mismatch");
    }
    const known = this.#threadMessages.get(projection.providerThreadId);
    if (!known || known.length === 0) {
      throw new MailProviderDefiniteFailure("mail_provider_thread_missing");
    }
    return this.#send(binding, message, projection.providerThreadId);
  }

  async getDeliveryProjection(
    bindingInput: MailboxBinding,
    input: {
      outboundEffectId: string;
      rfcMessageId: string | null;
      expectedProviderThreadId: string | null;
    },
  ): Promise<MailProviderDeliveryLookup> {
    const binding = freezeMailboxBinding(bindingInput);
    this.#assertProvider(binding);
    if (input.rfcMessageId === null) {
      return { status: "missing", coverage: "unknown" };
    }
    const candidates = (this.#byRfcMessageId.get(input.rfcMessageId) ?? [])
      .filter((candidate) => candidate.binding.accountBinding === binding.accountBinding)
      .filter((candidate) => candidate.message.outboundEffectId === input.outboundEffectId);
    if (candidates.length === 0) return { status: "missing", coverage: "complete" };
    if (candidates.length > 1) {
      return { status: "ambiguous", candidateCount: candidates.length };
    }
    const candidate = candidates[0]!;
    if (
      input.expectedProviderThreadId !== null
      && candidate.result.providerThreadId !== input.expectedProviderThreadId
    ) {
      return { status: "ambiguous", candidateCount: 1 };
    }
    return { status: "found", result: candidate.result };
  }

  #send(
    binding: MailboxBinding,
    message: MailProviderMessage & { rfcMessageId: string },
    existingThreadId: string | null,
  ): MailProviderSendResult {
    if (this.#mode === "definite_failure") {
      throw new MailProviderDefiniteFailure("mail_provider_rejected");
    }
    this.#counter += 1;
    const providerThreadId = existingThreadId ?? `fake_thread_${this.#counter}`;
    const result = freezeMailProviderSendResult({
      providerThreadId,
      providerMessageId: `fake_message_${this.#counter}`,
      providerRequestId: `fake_request_${this.#counter}`,
      rfcMessageId: message.rfcMessageId,
      acceptedAt: new Date(Date.UTC(2026, 7, 15, 0, 0, this.#counter)).toISOString(),
    });
    const stored = Object.freeze({ binding, message, result });
    const byMessage = this.#byRfcMessageId.get(message.rfcMessageId) ?? [];
    byMessage.push(stored);
    this.#byRfcMessageId.set(message.rfcMessageId, byMessage);
    const threadMessages = this.#threadMessages.get(providerThreadId) ?? [];
    threadMessages.push(stored);
    this.#threadMessages.set(providerThreadId, threadMessages);
    if (this.#mode === "ambiguous_after_send") {
      throw new MailProviderAmbiguousFailure("mail_provider_response_lost");
    }
    return result;
  }

  #message(input: MailProviderMessage): MailProviderMessage & { rfcMessageId: string } {
    const message = freezeMailProviderMessage(input);
    if (message.rfcMessageId === null) {
      throw new MailProviderDefiniteFailure("mail_provider_requires_caller_assigned_rfc_message_id");
    }
    return message as MailProviderMessage & { rfcMessageId: string };
  }

  #assertProvider(binding: MailboxBinding): void {
    if (binding.provider !== this.provider) {
      throw new MailProviderDefiniteFailure("mail_provider_binding_mismatch");
    }
  }
}
