import { expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import { GmailMailProvider } from "../src/gmail-mail-provider.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import type { MailProviderMessage } from "../src/mail-provider.ts";

const rfcMessageId = "<stn.reconcile-drift@mail.stensibly.com>";
const outboundEffectId = "mailfx_reconcile_drift";

function message(): MailProviderMessage {
  return {
    outboundEffectId,
    threadId: "mail_thread_reconcile_drift",
    handle: "STN-HANDOFF:7K3Q",
    contentFingerprint: sha256("reconcile-drift"),
    rfcMessageId,
    subject: "[STN-HANDOFF:7K3Q] Reconcile provider drift",
    body: "Continue STN-HANDOFF:7K3Q.",
    inReplyTo: null,
    references: [],
  };
}

test("Gmail reconciliation reports an exact effect in the wrong provider thread as ambiguous", async () => {
  const provider = new GmailMailProvider({
    async sendRaw() {
      throw new Error("unused");
    },
    async findMessagesByRfcMessageId() {
      return [{
        id: "gmail_message_drift",
        threadId: "gmail_thread_drift",
        rfcMessageId,
        outboundEffectId,
        subject: "[STN-HANDOFF:7K3Q] Reconcile provider drift",
        acceptedAt: "2026-08-15T06:30:00.000Z",
      }];
    },
  });

  expect(await provider.getDeliveryProjection({
    provider: "gmail",
    accountBinding: "gmail_operator_primary",
    mailboxAddress: "operator@example.com",
  }, {
    outboundEffectId,
    rfcMessageId,
    expectedProviderThreadId: "gmail_thread_expected",
  })).toEqual({ status: "ambiguous", candidateCount: 1 });
});

test("provider conformance fake keeps the same thread-drift case ambiguous", async () => {
  const provider = new InMemoryMailProvider();
  const binding = {
    provider: "fake",
    accountBinding: "operator_primary",
    mailboxAddress: "operator@example.com",
  };
  await provider.createThread(binding, message());

  expect(await provider.getDeliveryProjection(binding, {
    outboundEffectId,
    rfcMessageId,
    expectedProviderThreadId: "fake_thread_expected",
  })).toEqual({ status: "ambiguous", candidateCount: 1 });
});
