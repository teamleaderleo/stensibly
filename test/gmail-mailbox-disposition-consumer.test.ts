import { describe, expect, test } from "bun:test";
import { consumeGmailMailboxDisposition } from "../src/gmail-mailbox-disposition-consumer.ts";
import type {
  GmailMailboxDispositionEffect,
  GmailMailboxDispositionEffectRecord,
  GmailMailboxDispositionEffectStore,
  GmailMailboxDispositionReconciliationPhase,
  GmailMailboxDispositionReserveResult,
  GmailMailboxDispositionSettledOutcome,
} from "../src/gmail-mailbox-disposition-effect.ts";
import type { MailDeliveryReceipt } from "../src/mail-provider.ts";

const providerThreadId = "thread_receipt_bound";
const providerMessageId = "message_receipt_bound";
const receipt: MailDeliveryReceipt = {
  version: 1,
  outboundEffectId: "mail_effect_receipt_bound",
  threadId: "attn_receipt_bound",
  handle: "STN-REVIEW:J7MP",
  provider: "gmail",
  accountBinding: "operator-primary",
  mailboxAddress: "operator@example.com",
  attemptNumber: 1,
  contentFingerprint: "b".repeat(64),
  rfcMessageId: "<receipt-bound@stensibly.local>",
  providerRequestId: "request_receipt_bound",
  providerThreadId,
  providerMessageId,
  attemptedAt: "2026-08-15T07:20:00.000Z",
  result: "sent",
  failureClass: null,
  recoveryAction: "none",
  containsSecrets: false,
};

class OneEffectStore implements GmailMailboxDispositionEffectStore {
  record: GmailMailboxDispositionEffectRecord | null = null;

  async findOutstandingForTarget() {
    return this.record?.status === "settled" ? null : this.record;
  }

  async reserveEffect(
    effect: GmailMailboxDispositionEffect,
  ): Promise<GmailMailboxDispositionReserveResult> {
    if (this.record) return { status: "existing", record: this.record };
    this.record = {
      effect,
      status: "reserved",
      reconciliationPhase: null,
      settledOutcome: null,
    };
    return { status: "reserved" };
  }

  async markReconciliationRequired(
    effectId: string,
    phase: GmailMailboxDispositionReconciliationPhase,
  ) {
    if (!this.record || this.record.effect.effectId !== effectId) throw new Error("missing effect");
    this.record = { ...this.record, status: "reconciliation_required", reconciliationPhase: phase };
  }

  async markSettled(
    effectId: string,
    outcome: GmailMailboxDispositionSettledOutcome,
  ) {
    if (!this.record || this.record.effect.effectId !== effectId) throw new Error("missing effect");
    this.record = {
      ...this.record,
      status: "settled",
      reconciliationPhase: null,
      settledOutcome: outcome,
    };
  }

  async releasePreconditionRetry(effectId: string) {
    if (!this.record || this.record.effect.effectId !== effectId) throw new Error("missing effect");
    this.record = null;
  }
}

describe("receipt-bound Gmail mailbox disposition consumer", () => {
  test("derives the exact provider target from delivery evidence and keeps an agent review quiet", async () => {
    const labels = new Set(["SENT", "INBOX", "UNREAD"]);
    let mutations = 0;
    const store = new OneEffectStore();

    const result = await consumeGmailMailboxDisposition({
      deliveryReceipt: receipt,
      stensiblyLabelId: "Label_6",
      stateReader: {
        async readCurrentState(input) {
          expect(input).toEqual({ stnThreadId: receipt.threadId });
          return {
            source: "durable_stn_state",
            stnThreadId: receipt.threadId,
            revision: "review-state-r1",
            attentionClass: "review",
            operatorAttentionRequired: false,
            state: "active",
          };
        },
      },
      labelClient: {
        async readMessageLabels(input) {
          expect(input).toEqual({
            accountBinding: receipt.accountBinding,
            mailboxAddress: receipt.mailboxAddress,
            providerThreadId,
            providerMessageId,
          });
          return {
            source: "gmail_message_label_snapshot",
            provider: "gmail",
            ...input,
            labelIds: [...labels],
            isDraft: false,
          };
        },
        async mutateMessageLabels(input) {
          mutations += 1;
          expect(input.accountBinding).toBe(receipt.accountBinding);
          expect(input.mailboxAddress).toBe(receipt.mailboxAddress);
          expect(input.providerThreadId).toBe(providerThreadId);
          expect(input.providerMessageId).toBe(providerMessageId);
          expect(input.addLabelIds).toEqual(["Label_6"]);
          expect(input.removeLabelIds).toEqual(["INBOX", "UNREAD"]);
          for (const label of input.addLabelIds) labels.add(label);
          for (const label of input.removeLabelIds) labels.delete(label);
        },
      },
      effectStore: store,
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied disposition");
    expect(result.effect.binding).toMatchObject({
      stnThreadId: receipt.threadId,
      accountBinding: receipt.accountBinding,
      mailboxAddress: receipt.mailboxAddress,
      providerThreadId,
      providerMessageId,
    });
    expect(result.effect.authorizesMailSend).toBe(false);
    expect(labels).toEqual(new Set(["SENT", "Label_6"]));
    expect(mutations).toBe(1);

    const replay = await consumeGmailMailboxDisposition({
      deliveryReceipt: receipt,
      stensiblyLabelId: "Label_6",
      stateReader: {
        async readCurrentState() {
          return {
            source: "durable_stn_state",
            stnThreadId: receipt.threadId,
            revision: "review-state-r1",
            attentionClass: "review",
            operatorAttentionRequired: false,
            state: "active",
          };
        },
      },
      labelClient: {
        async readMessageLabels() {
          throw new Error("settled replay must not reread provider labels");
        },
        async mutateMessageLabels() {
          throw new Error("settled replay must not mutate provider labels");
        },
      },
      effectStore: store,
    });
    expect(replay.status).toBe("replayed");
    expect(mutations).toBe(1);
  });
});
