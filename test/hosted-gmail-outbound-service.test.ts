import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import type { GmailOutboundClient } from "../src/gmail-mail-provider.ts";
import { HostedGmailOutboundService } from "../src/hosted-gmail-outbound-service.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

class FakeGmailClient implements GmailOutboundClient {
  sent = 0;
  async sendRaw(input: { raw: string; threadId?: string }) {
    this.sent += 1;
    return {
      id: `gmail_message_${this.sent}`,
      threadId: input.threadId ?? "gmail_thread_1",
      acceptedAt: `2026-08-15T08:10:0${this.sent}.000Z`,
    };
  }
  async findMessagesByRfcMessageId() {
    return [];
  }
}

function material(overrides: Record<string, unknown> = {}) {
  return {
    threadClass: "handoff" as const,
    sourceIdentity: "attention:hosted:composition",
    canonicalSubject: "Hosted Gmail continuation",
    sourceFingerprint: sha256("hosted-composition-v1"),
    whatChanged: "The hosted Gmail continuation is ready.",
    attentionReason: "The unattended outbound lane has one material checkpoint.",
    nextAction: "Refresh GitHub issue 1518 and continue.",
    sourceObject: "github:teamleaderleo/stensibly#1518",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "Hosted outbound checkpoint is accepted.",
    threadState: "open" as const,
    references: [],
    continuesFromHandle: null,
    ...overrides,
  };
}

describe("HostedGmailOutboundService", () => {
  test("server-owned project/mailbox binding survives replay and material update on one Gmail thread", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const gmailClient = new FakeGmailClient();
    const service = new HostedGmailOutboundService({
      store,
      gmailClient,
      binding: {
        workspace: "test",
        project: "stensibly",
        accountBinding: "gmail_operator_primary",
        mailboxAddress: "operator@example.com",
      },
      now: () => "2026-08-15T08:10:00.000Z",
    });

    const first = await service.publish(material());
    expect(first.outcome).toBe("sent");
    expect(first.thread.workspace).toBe("test");
    expect(first.thread.project).toBe("stensibly");
    expect(first.receipt.provider).toBe("gmail");
    expect(first.receipt.accountBinding).toBe("gmail_operator_primary");
    expect(first.receipt.mailboxAddress).toBe("operator@example.com");
    expect(first.envelope.launchLine).toContain("In Gmail, continue STN-HANDOFF:");
    expect(gmailClient.sent).toBe(1);

    const replay = await service.publish(material());
    expect(replay.outcome).toBe("replayed");
    expect(gmailClient.sent).toBe(1);

    const changed = await service.publish(material({
      sourceFingerprint: sha256("hosted-composition-v2"),
      whatChanged: "The hosted Gmail continuation changed materially.",
      sourceRevision: "b".repeat(40),
    }));
    expect(changed.outcome).toBe("sent");
    expect(changed.receipt.providerThreadId).toBe(first.receipt.providerThreadId);
    expect(gmailClient.sent).toBe(2);

    const known = await service.getKnownOutboundProviderMessage(changed.receipt.providerMessageId!);
    expect(known?.outboundEffectId).toBe(changed.receipt.outboundEffectId);
    store.close();
  });
});
