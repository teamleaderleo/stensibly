import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  GmailMailProvider,
  type GmailOutboundClient,
} from "../src/gmail-mail-provider.ts";
import {
  MailProviderAmbiguousFailure,
  freezeMailProviderProjection,
  type MailProviderMessage,
} from "../src/mail-provider.ts";

const binding = Object.freeze({
  provider: "gmail",
  accountBinding: "gmail_operator_primary",
  mailboxAddress: "operator@example.com",
});

function message(overrides: Partial<MailProviderMessage> = {}): MailProviderMessage {
  return {
    outboundEffectId: "mailfx_1234567890abcdef",
    threadId: "mail_thread_1492",
    handle: "STN-HANDOFF:7K3Q",
    contentFingerprint: sha256("mail-content-1"),
    rfcMessageId: "<stn.1234567890abcdef@mail.stensibly.com>",
    subject: "[STN-HANDOFF:7K3Q] Continue outbound mail threads",
    body: "What changed\nCandidate ready.\n\nContinue STN-HANDOFF:7K3Q.",
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

function decodeRaw(raw: string): string {
  const normalized = raw.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

describe("Gmail mail provider", () => {
  test("creates a raw MIME thread then replies through exact Gmail thread identity and RFC ancestry", async () => {
    const sends: Array<{ raw: string; threadId?: string }> = [];
    const client: GmailOutboundClient = {
      async sendRaw(input) {
        sends.push(input);
        return sends.length === 1
          ? {
              id: "gmail_message_root",
              threadId: "gmail_thread_1",
              requestId: "gmail_request_1",
              acceptedAt: "2026-08-15T06:00:01.000Z",
            }
          : {
              id: "gmail_message_reply",
              threadId: "gmail_thread_1",
              requestId: "gmail_request_2",
              acceptedAt: "2026-08-15T06:00:02.000Z",
            };
      },
      async findMessagesByRfcMessageId() {
        return [];
      },
    };
    const provider = new GmailMailProvider(client);

    const rootMessage = message();
    const root = await provider.createThread(binding, rootMessage);
    expect(root.providerThreadId).toBe("gmail_thread_1");
    expect(root.providerMessageId).toBe("gmail_message_root");
    expect(sends[0]!.threadId).toBeUndefined();
    const rootMime = decodeRaw(sends[0]!.raw);
    expect(rootMime).toContain("To: operator@example.com\r\n");
    expect(rootMime).toContain(`Message-ID: ${rootMessage.rfcMessageId}\r\n`);
    expect(rootMime).toContain("Auto-Submitted: auto-generated\r\n");
    expect(rootMime).toContain("X-Stensibly-Thread: mail_thread_1492\r\n");
    expect(rootMime).toContain("X-Stensibly-Handle: STN-HANDOFF:7K3Q\r\n");
    expect(rootMime).not.toContain("In-Reply-To:");

    const projection = freezeMailProviderProjection({
      version: 1,
      threadId: "mail_thread_1492",
      provider: "gmail",
      accountBinding: "gmail_operator_primary",
      providerThreadId: "gmail_thread_1",
      rootProviderMessageId: "gmail_message_root",
      latestProviderMessageId: "gmail_message_root",
      rootRfcMessageId: rootMessage.rfcMessageId,
      latestRfcMessageId: rootMessage.rfcMessageId,
      latestSentFingerprint: rootMessage.contentFingerprint,
      lastVerifiedSubject: rootMessage.subject,
      lastVerifiedReferences: [],
      verifiedAt: "2026-08-15T06:00:01.000Z",
    });
    const replyMessage = message({
      outboundEffectId: "mailfx_abcdef1234567890",
      contentFingerprint: sha256("mail-content-2"),
      rfcMessageId: "<stn.abcdef1234567890@mail.stensibly.com>",
      body: "What changed\nCandidate repaired.\n\nContinue STN-HANDOFF:7K3Q.",
      inReplyTo: rootMessage.rfcMessageId,
      references: [rootMessage.rfcMessageId],
    });
    const reply = await provider.replyThread(binding, projection, replyMessage);
    expect(reply.providerThreadId).toBe("gmail_thread_1");
    expect(sends[1]!.threadId).toBe("gmail_thread_1");
    const replyMime = decodeRaw(sends[1]!.raw);
    expect(replyMime).toContain(`In-Reply-To: ${rootMessage.rfcMessageId}\r\n`);
    expect(replyMime).toContain(`References: ${rootMessage.rfcMessageId}\r\n`);
    expect(replyMime).toContain(`Message-ID: ${replyMessage.rfcMessageId}\r\n`);
  });

  test("treats a lost or malformed Gmail send response as ambiguous", async () => {
    const throwing = new GmailMailProvider({
      async sendRaw() {
        throw new Error("connection reset");
      },
      async findMessagesByRfcMessageId() {
        return [];
      },
    });
    await expect(throwing.createThread(binding, message())).rejects.toBeInstanceOf(
      MailProviderAmbiguousFailure,
    );

    let getterReads = 0;
    const hostile = new GmailMailProvider({
      async sendRaw() {
        return Object.defineProperty({}, "id", {
          enumerable: true,
          get() {
            getterReads += 1;
            return "gmail_message";
          },
        });
      },
      async findMessagesByRfcMessageId() {
        return [];
      },
    });
    await expect(hostile.createThread(binding, message())).rejects.toBeInstanceOf(
      MailProviderAmbiguousFailure,
    );
    expect(getterReads).toBe(0);
  });

  test("reconciles by deterministic RFC Message-ID plus outbound effect identity and reports ambiguity explicitly", async () => {
    let candidates: readonly unknown[] = [{
      id: "gmail_message_root",
      threadId: "gmail_thread_1",
      rfcMessageId: "<stn.1234567890abcdef@mail.stensibly.com>",
      outboundEffectId: "mailfx_1234567890abcdef",
      subject: "[STN-HANDOFF:7K3Q] Continue outbound mail threads",
      requestId: "gmail_request_1",
      acceptedAt: "2026-08-15T06:00:01.000Z",
    }];
    const provider = new GmailMailProvider({
      async sendRaw() {
        throw new Error("unused");
      },
      async findMessagesByRfcMessageId() {
        return candidates;
      },
    });
    const lookup = {
      outboundEffectId: "mailfx_1234567890abcdef",
      rfcMessageId: "<stn.1234567890abcdef@mail.stensibly.com>",
      expectedProviderThreadId: null,
    };

    const found = await provider.getDeliveryProjection(binding, lookup);
    expect(found.status).toBe("found");
    if (found.status === "found") {
      expect(found.result.providerThreadId).toBe("gmail_thread_1");
      expect(found.result.providerMessageId).toBe("gmail_message_root");
    }

    candidates = [candidates[0]!, { ...candidates[0] as object, id: "gmail_message_duplicate" }];
    expect(await provider.getDeliveryProjection(binding, lookup)).toEqual({
      status: "ambiguous",
      candidateCount: 2,
    });

    candidates = [];
    expect(await provider.getDeliveryProjection(binding, lookup)).toEqual({
      status: "missing",
      coverage: "complete",
    });
  });
});
