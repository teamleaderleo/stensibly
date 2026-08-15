import { expect, test } from "bun:test";
import {
  executeGmailMailboxDispositionEffect,
  reconcileGmailMailboxDispositionEffect,
  type CurrentDurableStnMailboxState,
  type CurrentDurableStnMailboxStateReader,
  type GmailMailboxDispositionEffect,
  type GmailMailboxDispositionEffectRecord,
  type GmailMailboxDispositionEffectStore,
  type GmailMailboxDispositionReconciliationPhase,
  type GmailMailboxDispositionSettledOutcome,
  type GmailMailboxLabelClient,
  type SettledGmailMessageBinding,
} from "../src/gmail-mailbox-disposition-effect.ts";

const binding: SettledGmailMessageBinding = {
  source: "settled_gmail_message_binding",
  provider: "gmail",
  stnThreadId: "attn_R6K9",
  accountBinding: "operator-primary",
  mailboxAddress: "operator@example.com",
  providerThreadId: "thread_R6K9",
  providerMessageId: "message_R6K9",
  stensiblyLabelId: "Label_6",
};

class StateReader implements CurrentDurableStnMailboxStateReader {
  current: CurrentDurableStnMailboxState = {
    source: "durable_stn_state",
    stnThreadId: binding.stnThreadId,
    revision: "state-r1-quiet",
    attentionClass: "handoff",
    operatorAttentionRequired: false,
    state: "active",
  };

  async readCurrentState() {
    return this.current;
  }
}

class EffectStore implements GmailMailboxDispositionEffectStore {
  readonly records = new Map<string, GmailMailboxDispositionEffectRecord>();

  async findOutstandingForTarget(target: SettledGmailMessageBinding) {
    for (const record of this.records.values()) {
      if (
        record.status !== "settled"
        && record.effect.binding.accountBinding === target.accountBinding
        && record.effect.binding.mailboxAddress === target.mailboxAddress
        && record.effect.binding.providerThreadId === target.providerThreadId
        && record.effect.binding.providerMessageId === target.providerMessageId
      ) return record;
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
    phase: GmailMailboxDispositionReconciliationPhase,
  ) {
    const record = this.required(effectId);
    this.records.set(effectId, {
      ...record,
      status: "reconciliation_required",
      reconciliationPhase: phase,
      settledOutcome: null,
    });
  }

  async markSettled(
    effectId: string,
    outcome: GmailMailboxDispositionSettledOutcome,
  ) {
    const record = this.required(effectId);
    this.records.set(effectId, {
      ...record,
      status: "settled",
      reconciliationPhase: null,
      settledOutcome: outcome,
    });
  }

  async releasePreconditionRetry(effectId: string) {
    this.required(effectId);
    this.records.delete(effectId);
  }

  private required(effectId: string) {
    const record = this.records.get(effectId);
    if (!record) throw new Error(`missing effect ${effectId}`);
    return record;
  }
}

class PartialLabelClient implements GmailMailboxLabelClient {
  labels = new Set(["Label_6", "INBOX", "UNREAD"]);
  mutations = 0;

  async readMessageLabels() {
    return {
      source: "gmail_message_label_snapshot" as const,
      provider: "gmail" as const,
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
    this.mutations += 1;
    if (this.mutations === 1) {
      expect(input.removeLabelIds).toContain("INBOX");
      expect(input.removeLabelIds).toContain("UNREAD");
      this.labels.delete("INBOX");
      throw new Error("response lost after partial label application");
    }
    for (const label of input.addLabelIds) this.labels.add(label);
    for (const label of input.removeLabelIds) this.labels.delete(label);
  }
}

test("new operator attention escapes a partially applied ambiguous quiet-mail mutation", async () => {
  const stateReader = new StateReader();
  const effectStore = new EffectStore();
  const labelClient = new PartialLabelClient();

  const quiet = await executeGmailMailboxDispositionEffect({
    binding,
    stateReader,
    effectStore,
    labelClient,
  });
  expect(quiet.status).toBe("reconciliation_required");
  if (quiet.status !== "reconciliation_required") throw new Error("expected reconciliation");
  expect(quiet.phase).toBe("mutation_outcome");
  expect(labelClient.labels).toEqual(new Set(["Label_6", "UNREAD"]));

  stateReader.current = {
    source: "durable_stn_state",
    stnThreadId: binding.stnThreadId,
    revision: "state-r2-attention",
    attentionClass: "handoff",
    operatorAttentionRequired: true,
    state: "active",
  };

  const reconciled = await reconcileGmailMailboxDispositionEffect({
    effect: quiet.effect,
    phase: quiet.phase,
    stateReader,
    effectStore,
    labelClient,
  });
  expect(reconciled.status).toBe("superseded");
  if (reconciled.status !== "superseded") throw new Error("expected superseded");
  expect(reconciled.priorEffectCleared).toBe(true);
  expect(reconciled.recoveryAction).toBe("apply_current_state_effect");

  const visible = await executeGmailMailboxDispositionEffect({
    binding,
    stateReader,
    effectStore,
    labelClient,
  });
  expect(visible.status).toBe("applied");
  expect(labelClient.labels).toEqual(new Set(["Label_6", "INBOX", "UNREAD"]));
  expect(labelClient.mutations).toBe(2);
});
