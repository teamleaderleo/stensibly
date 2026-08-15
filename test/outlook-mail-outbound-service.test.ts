import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service.ts";
import { OutlookMailProvider } from "../src/outlook-mail-provider.ts";
import { createMailThreadHandle } from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const mailbox = Object.freeze({
  provider: "outlook",
  accountBinding: "outlook_operator_primary",
  mailboxAddress: "cheerleaderleo@outlook.com",
});

function command(
  overrides: Partial<PublishMailThreadCommand> = {},
): PublishMailThreadCommand {
  return {
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity: "github:teamleaderleo/stensibly#1490",
    canonicalSubject: "Outlook parity relay for #1488 / #1490",
    sourceFingerprint: sha256("outlook-parity-1"),
    whatChanged: "Outlook continuation is under parity validation.",
    attentionReason: "The same canonical handoff must survive provider differences.",
    nextAction: "Continue STN-HANDOFF:O8R2 from the newest Outlook checkpoint.",
    sourceObject: "github:teamleaderleo/stensibly#1490",
    sourceRevision: "d".repeat(40),
    blocker: null,
    resolutionCondition: "Outlook create/reply continuation preserves provider-neutral identity.",
    threadState: "open",
    mailbox,
    ...overrides,
  };
}

describe("Outlook outbound continuation parity", () => {
  test("keeps canonical effect identity separate from provider-owned RFC and conversation ancestry", async () => {
    const sent: unknown[] = [];
    const replied: unknown[] = [];
    const provider = new OutlookMailProvider({
      async sendMessage(input) {
        sent.push(input);
        return {
          id: "AAMk_root_immutable",
          conversationId: "AAQk_conversation_1",
          internetMessageId: "<outlook-root@provider.example>",
          acceptedAt: "2026-08-15T07:10:00.000Z",
        };
      },
      async replyMessage(input) {
        replied.push(input);
        return {
          id: "AAMk_reply_immutable",
          conversationId: "AAQk_conversation_1",
          internetMessageId: "<outlook-reply@provider.example>",
          acceptedAt: "2026-08-15T07:11:00.000Z",
        };
      },
      async findMessagesByOutboundEffectId() {
        return [];
      },
    });
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const service = new MailOutboundService({
      store,
      provider,
      now: () => "2026-08-15T07:09:00.000Z",
      threadIdFactory: () => "mail_thread_outlook_1490",
      handleFactory: () => createMailThreadHandle("handoff", "O8R2"),
    });

    const root = await service.publish(command());
    expect(root.outcome).toBe("sent");
    expect(root.receipt.rfcMessageId).toBeNull();
    expect(root.projection).toMatchObject({
      provider: "outlook",
      providerThreadId: "AAQk_conversation_1",
      rootProviderMessageId: "AAMk_root_immutable",
      latestProviderMessageId: "AAMk_root_immutable",
      rootRfcMessageId: "<outlook-root@provider.example>",
      latestRfcMessageId: "<outlook-root@provider.example>",
    });
    expect(sent).toHaveLength(1);

    const reply = await service.publish(command({
      sourceFingerprint: sha256("outlook-parity-2"),
      whatChanged: "The newest Outlook checkpoint now carries the parity result.",
      sourceRevision: "e".repeat(40),
    }));
    expect(reply.outcome).toBe("sent");
    expect(reply.receipt.rfcMessageId).toBeNull();
    expect(reply.receipt.providerThreadId).toBe(root.receipt.providerThreadId);
    expect(reply.projection).toMatchObject({
      providerThreadId: "AAQk_conversation_1",
      rootProviderMessageId: "AAMk_root_immutable",
      latestProviderMessageId: "AAMk_reply_immutable",
      rootRfcMessageId: "<outlook-root@provider.example>",
      latestRfcMessageId: "<outlook-reply@provider.example>",
    });
    expect(replied).toEqual([expect.objectContaining({
      messageId: "AAMk_root_immutable",
    })]);

    const selfEchoEffect = await store.getDeliveryEffectByProviderMessageId(
      "outlook",
      "outlook_operator_primary",
      "AAMk_reply_immutable",
    );
    expect(selfEchoEffect?.outboundEffectId).toBe(reply.receipt.outboundEffectId);
    store.close();
  });
});
