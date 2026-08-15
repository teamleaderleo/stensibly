import { describe, expect, test } from "bun:test";
import {
  buildGmailMailboxDispositionEffect,
  executeGmailMailboxDispositionEffect,
  reconcileGmailMailboxDispositionEffect,
  type CurrentDurableStnMailboxState,
  type CurrentDurableStnMailboxStateReader,
  type GmailMailboxDispositionEffect,
  type GmailMailboxDispositionEffectRecord,
  type GmailMailboxDispositionEffectStore,
  type GmailMailboxLabelClient,
  type GmailMessageLabelSnapshot,
  type SettledGmailMessageBinding,
} from "../src/gmail-mailbox-disposition-effect.ts";

const binding: SettledGmailMessageBinding = {
  source: "settled_gmail_message_binding",
  provider: "gmail",
  stnThreadId: "stn_thread_review_1543",
  accountBinding: "gmail_primary",
  mailboxAddress: "operator@example.com",
  providerThreadId: "gmail-thread-1543",
  providerMessageId: "gmail-message-1543",
  stensiblyLabelId: "Label_6",
};

function state(
  revision: string,
  operatorAttentionRequired: boolean,
): CurrentDurableStnMailboxState {
  return {
    source: "durable_stn_state",
    stnThreadId: binding.stnThreadId,
    revision,
    attentionClass: "review",
    operatorAttentionRequired,
    state: "active",
  };
}

class Reader implements CurrentDurableStnMailboxStateReader {
  current = state("rev_quiet", false);

  async readCurrentState() {
    return this.current;
  }
}

class Store implements GmailMailboxDispositionEffectStore {
  records = new Map<string, GmailMailboxDispositionEffectRecord>();

  async findOutstandingForTarget() {
    for (const record of this.records.values()) {
      if (record.status !== "settled") return record;
    }
    return null;
  }

  async reserveEffect(effect: GmailMailboxDispositionEffect) {
    const existing = this.records.get(effect.effectId);
    if (existing) return { status: "existing" as const, record: existing };
    this.records.set(effect.effectId, {
      effect,
      status: "reserved",
      reconciliationPhase: null,
      settledOutcome: null,
    });
    return { status: "reserved" as const };
  }

  async markReconciliationRequired(
    effectId: string,
    phase: GmailMailboxDispositionEffectRecord["reconciliationPhase"],
  ) {
    const record = this.records.get(effectId)!;
    this.records.set(effectId, {
      ...record,
      status: "reconciliation_required",
      reconciliationPhase: phase,
    });
  }

  async markSettled(
    effectId: string,
    outcome: NonNullable<GmailMailboxDispositionEffectRecord["settledOutcome"]>,
  ) {
    const record = this.records.get(effectId)!;
    this.records.set(effectId, {
      ...record,
      status: "settled",
      reconciliationPhase: null,
      settledOutcome: outcome,
    });
  }

  async releasePreconditionRetry(effectId: string) {
    this.records.delete(effectId);
  }
}

class PartialQuietMutationClient implements GmailMailboxLabelClient {
  labels = new Set(["Label_6", "INBOX", "UNREAD"]);
  mutateCalls = 0;

  async readMessageLabels(): Promise<GmailMessageLabelSnapshot> {
    return {
      source: "gmail_message_label_snapshot",
      provider: "gmail",
      accountBinding: binding.accountBinding,
      mailboxAddress: binding.mailboxAddress,
      providerThreadId: binding.providerThreadId,
      providerMessageId: binding.providerMessageId,
      labelIds: [...this.labels],
      isDraft: false,
    };
  }

  async mutateMessageLabels(input: {
    addLabelIds: readonly string[];
    removeLabelIds: readonly string[];
  }) {
    this.mutateCalls += 1;
    if (this.mutateCalls === 1) {
      // The quiet effect partially applies and loses its provider response:
      // INBOX is removed, UNREAD remains, so exact old labels are neither
      // conclusively applied nor conclusively absent.
      this.labels.delete("INBOX");
      throw new Error("provider response lost after partial quiet mutation");
    }
    for (const id of input.addLabelIds) this.labels.add(id);
    for (const id of input.removeLabelIds) this.labels.delete(id);
  }
}

describe("Gmail disposition supersession preserves newer human attention", () => {
  test("an older ambiguous quiet mutation can settle once newer attention supersedes it", async () => {
    const reader = new Reader();
    const store = new Store();
    const client = new PartialQuietMutationClient();

    const quietAttempt = await executeGmailMailboxDispositionEffect({
      binding,
      stateReader: reader,
      labelClient: client,
      effectStore: store,
    });
    expect(quietAttempt.status).toBe("reconciliation_required");
    if (quietAttempt.status !== "reconciliation_required") return;
    expect(quietAttempt.phase).toBe("mutation_outcome");
    expect([...client.labels].sort()).toEqual(["Label_6", "UNREAD"]);

    // The canonical durable state advances before the old ambiguous effect is
    // reconciled. This now requires human attention and must be allowed to
    // restore both Inbox + unread even though the old quiet mutation was partial.
    reader.current = state("rev_attention", true);
    const attentionEffect = buildGmailMailboxDispositionEffect(
      binding,
      reader.current,
    );
    expect(attentionEffect.effectId).not.toBe(quietAttempt.effect.effectId);
    expect(attentionEffect.requiredLabelIds).toEqual(["Label_6", "INBOX", "UNREAD"]);

    const reconcileOld = await reconcileGmailMailboxDispositionEffect({
      effect: quietAttempt.effect,
      stateReader: reader,
      labelClient: client,
      effectStore: store,
      phase: quietAttempt.phase,
    });

    expect(reconcileOld).toMatchObject({
      status: "superseded",
      currentStateRevision: "rev_attention",
      priorEffectCleared: true,
      recoveryAction: "apply_current_state_effect",
    });

    const attentionApply = await executeGmailMailboxDispositionEffect({
      binding,
      stateReader: reader,
      labelClient: client,
      effectStore: store,
    });
    expect(attentionApply.status).toBe("applied");
    expect([...client.labels].sort()).toEqual(["INBOX", "Label_6", "UNREAD"]);
  });
});
