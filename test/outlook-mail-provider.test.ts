import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  OutlookMailProvider,
  type OutlookOutboundClient,
} from "../src/outlook-mail-provider.ts";
import {
  freezeMailProviderProjection,
  type MailProviderMessage,
} from "../src/mail-provider.ts";

const binding = Object.freeze({
  provider: "outlook",
  accountBinding: "outlook_operator_primary",
  mailboxAddress: "cheerleaderleo@outlook.com",
});

function message(overrides: Partial<MailProviderMessage> = {}): MailProviderMessage {
  return {
    outboundEffectId: "mailfx_outlook_root_1234",
    threadId: "mail_thread_outlook_1490",
    handle: "STN-HANDOFF:O8R2",
    contentFingerprint: sha256("outlook-mail-content-1"),
    rfcMessageId: null,
    subject: "[STN-HANDOFF:O8R2] Outlook parity relay for #1488 / #1490",
    body: "Handle: STN-HANDOFF:O8R2\n\nContinue the Outlook parity relay.",
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

describe("Outlook mail provider parity", () => {
  test("creates and replies through provider message/conversation identity without caller-assigned RFC ancestry", async () => {
    const sends: unknown[] = [];
    const replies: unknown[] = [];
    const client: OutlookOutboundClient = {
      async sendMessage(input) {
        sends.push(input);
        return {
          id: "AAMk_root_immutable",
          conversationId: "AAQk_conversation_1",
          internetMessageId: "<provider-root@outlook.com>",
          requestId: "graph_request_1",
          acceptedAt: "2026-08-15T07:00:01.000Z",
        };
      },
      async replyMessage(input) {
        replies.push(input);
        return {
          id: "AAMk_reply_immutable",
          conversationId: "AAQk_conversation_1",
          internetMessageId: "<provider-reply@outlook.com>",
          requestId: "graph_request_2",
          acceptedAt: "2026-08-15T07:00:02.000Z",
        };
      },
      async findMessagesByOutboundEffectId() {
        return [];
      },
    };
    const provider = new OutlookMailProvider(client);

    const rootMessage = message();
    const root = await provider.createThread(binding, rootMessage);
    expect(root).toMatchObject({
      providerThreadId: "AAQk_conversation_1",
      providerMessageId: "AAMk_root_immutable",
      rfcMessageId: "<provider-root@outlook.com>",
    });
    expect(sends).toEqual([{
      to: "cheerleaderleo@outlook.com",
      subject: rootMessage.subject,
      body: rootMessage.body,
      outboundEffectId: rootMessage.outboundEffectId,
    }]);

    const projection = freezeMailProviderProjection({
      version: 1,
      threadId: rootMessage.threadId,
      provider: "outlook",
      accountBinding: "outlook_operator_primary",
      mailboxAddress: "cheerleaderleo@outlook.com",
      providerThreadId: root.providerThreadId,
      rootProviderMessageId: root.providerMessageId,
      latestProviderMessageId: root.providerMessageId,
      rootRfcMessageId: root.rfcMessageId,
      latestRfcMessageId: root.rfcMessageId,
      latestSentFingerprint: rootMessage.contentFingerprint,
      lastVerifiedSubject: rootMessage.subject,
      lastVerifiedReferences: [],
      verifiedAt: root.acceptedAt,
    });
    const replyMessage = message({
      outboundEffectId: "mailfx_outlook_reply_5678",
      contentFingerprint: sha256("outlook-mail-content-2"),
      body: "Handle: STN-HANDOFF:O8R2\n\nNewest Outlook checkpoint is sufficient.",
    });
    const reply = await provider.replyThread(binding, projection, replyMessage);
    expect(reply).toMatchObject({
      providerThreadId: "AAQk_conversation_1",
      providerMessageId: "AAMk_reply_immutable",
      rfcMessageId: "<provider-reply@outlook.com>",
    });
    expect(replies).toEqual([{
      messageId: "AAMk_root_immutable",
      subject: replyMessage.subject,
      body: replyMessage.body,
      outboundEffectId: replyMessage.outboundEffectId,
    }]);
  });

  test("reconciles ambiguous delivery by canonical outbound effect and checks conversation drift", async () => {
    let candidates: readonly unknown[] = [{
      id: "AAMk_root_immutable",
      conversationId: "AAQk_conversation_1",
      internetMessageId: "<provider-root@outlook.com>",
      outboundEffectId: "mailfx_outlook_root_1234",
      requestId: "graph_request_1",
      acceptedAt: "2026-08-15T07:00:01.000Z",
    }];
    const provider = new OutlookMailProvider({
      async sendMessage() { throw new Error("unused"); },
      async replyMessage() { throw new Error("unused"); },
      async findMessagesByOutboundEffectId() { return candidates; },
    });

    const found = await provider.getDeliveryProjection(binding, {
      outboundEffectId: "mailfx_outlook_root_1234",
      rfcMessageId: null,
      expectedProviderThreadId: "AAQk_conversation_1",
    });
    expect(found.status).toBe("found");

    expect(await provider.getDeliveryProjection(binding, {
      outboundEffectId: "mailfx_outlook_root_1234",
      rfcMessageId: null,
      expectedProviderThreadId: "AAQk_other_conversation",
    })).toEqual({ status: "ambiguous", candidateCount: 1 });

    candidates = [];
    expect(await provider.getDeliveryProjection(binding, {
      outboundEffectId: "mailfx_outlook_root_1234",
      rfcMessageId: null,
      expectedProviderThreadId: null,
    })).toEqual({ status: "missing", coverage: "complete" });
  });
});
