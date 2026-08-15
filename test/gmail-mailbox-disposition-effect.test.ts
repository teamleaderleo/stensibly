import { describe, expect, test } from "bun:test";
import {
  buildGmailMailboxDispositionEffect,
  executeGmailMailboxDispositionEffect,
  reconcileGmailMailboxDispositionEffect,
  settledGmailMessageBindingFromDeliveryReceipt,
  type CurrentDurableStnMailboxState,
  type CurrentDurableStnMailboxStateReader,
  type GmailMailboxDispositionEffect,
  type GmailMailboxDispositionEffectRecord,
  type GmailMailboxDispositionEffectStore,
  type GmailMailboxDispositionReconciliationPhase,
  type GmailMailboxDispositionReserveResult,
  type GmailMailboxDispositionSettledOutcome,
  type GmailMailboxLabelClient,
  type GmailMessageLabelSnapshot,
  type SettledGmailMessageBinding,
} from "../src/gmail-mailbox-disposition-effect.ts";
import type { MailDeliveryReceipt } from "../src/mail-provider.ts";
import type { MailAttentionClass } from "../src/mail-ux-projection.ts";

const binding: SettledGmailMessageBinding = {
  source: "settled_gmail_message_binding",
  provider: "gmail",
  stnThreadId: "attn_H7MK",
  accountBinding: "gmail:operator-primary",
  mailboxAddress: "operator@example.com",
  providerThreadId: "thread_H7MK",
  providerMessageId: "message_H7MK",
  stensiblyLabelId: "Label_6",
};

function receipt(
  overrides: Partial<MailDeliveryReceipt> = {},
): MailDeliveryReceipt {
  return {
    version: 1,
    outboundEffectId: "mail_effect_H7MK",
    threadId: binding.stnThreadId,
    handle: "STN-DECISION:H7MK",
    provider: "gmail",
    accountBinding: binding.accountBinding,
    mailboxAddress: binding.mailboxAddress,
    attemptNumber: 1,
    contentFingerprint: "a".repeat(64),
    rfcMessageId: "<h7mk@stensibly.local>",
    providerRequestId: "request_H7MK",
    providerThreadId: binding.providerThreadId,
    providerMessageId: binding.providerMessageId,
    attemptedAt: "2026-08-15T07:00:00.000Z",
    result: "sent",
    failureClass: null,
    recoveryAction: "none",
    containsSecrets: false,
    ...overrides,
  };
}

function state(
  overrides: Partial<CurrentDurableStnMailboxState> = {},
): CurrentDurableStnMailboxState {
  return {
    source: "durable_stn_state",
    stnThreadId: binding.stnThreadId,
    revision: "state-r1",
    attentionClass: "decision",
    operatorAttentionRequired: true,
    state: "active",
    ...overrides,
  };
}

class MutableStateReader implements CurrentDurableStnMailboxStateReader {
  current: CurrentDurableStnMailboxState | null = state();
  throwOnRead = false;
  reads = 0;

  async readCurrentState(input: { stnThreadId: string }) {
    this.reads += 1;
    if (this.throwOnRead) throw new Error("state unavailable");
    expect(input.stnThreadId).toBe(binding.stnThreadId);
    return this.current;
  }
}

class MemoryEffectStore implements GmailMailboxDispositionEffectStore {
  readonly records = new Map<string, GmailMailboxDispositionEffectRecord>();

  async findOutstandingForTarget(target: SettledGmailMessageBinding) {
    for (const record of this.records.values()) {
      if (
        record.status !== "settled"
        && record.effect.binding.accountBinding === target.accountBinding
        && record.effect.binding.mailboxAddress === target.mailboxAddress
        && record.effect.binding.providerThreadId === target.providerThreadId
        && record.effect.binding.providerMessageId === target.providerMessageId
      ) {
        return record;
      }
    }
    return null;
  }

  async reserveEffect(
    effect: GmailMailboxDispositionEffect,
  ): Promise<GmailMailboxDispositionReserveResult> {
    const existing = this.records.get(effect.effectId);
    if (existing !== undefined) return { status: "existing", record: existing };
    this.records.set(effect.effectId, {
      effect,
      status: "reserved",
      reconciliationPhase: null,
      settledOutcome: null,
    });
    return { status: "reserved" };
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
    if (record === undefined) throw new Error(`missing effect ${effectId}`);
    return record;
  }
}

type MutationMode = "success" | "throw_before_apply" | "apply_then_throw";

class FakeLabelClient implements GmailMailboxLabelClient {
  labels = new Set<string>(["SENT"]);
  isDraft = false;
  reads = 0;
  mutations: Array<{
    dispositionEffectId: string;
    addLabelIds: readonly string[];
    removeLabelIds: readonly string[];
  }> = [];
  failReadNumbers = new Set<number>();
  mutationMode: MutationMode = "success";
  mismatchMessageId: string | null = null;

  async readMessageLabels() {
    this.reads += 1;
    if (this.failReadNumbers.has(this.reads)) throw new Error("read failed");
    return this.snapshot();
  }

  async mutateMessageLabels(input: {
    accountBinding: string;
    mailboxAddress: string;
    providerThreadId: string;
    providerMessageId: string;
    dispositionEffectId: string;
    addLabelIds: readonly string[];
    removeLabelIds: readonly string[];
  }) {
    expect(input.accountBinding).toBe(binding.accountBinding);
    expect(input.mailboxAddress).toBe(binding.mailboxAddress);
    expect(input.providerThreadId).toBe(binding.providerThreadId);
    expect(input.providerMessageId).toBe(binding.providerMessageId);
    this.mutations.push({
      dispositionEffectId: input.dispositionEffectId,
      addLabelIds: [...input.addLabelIds],
      removeLabelIds: [...input.removeLabelIds],
    });
    if (this.mutationMode === "throw_before_apply") {
      throw new Error("ambiguous mutation");
    }
    for (const label of input.addLabelIds) this.labels.add(label);
    for (const label of input.removeLabelIds) this.labels.delete(label);
    if (this.mutationMode === "apply_then_throw") {
      throw new Error("response lost after apply");
    }
  }

  private snapshot(): GmailMessageLabelSnapshot {
    return {
      source: "gmail_message_label_snapshot",
      provider: "gmail",
      accountBinding: binding.accountBinding,
      mailboxAddress: binding.mailboxAddress,
      providerThreadId: binding.providerThreadId,
      providerMessageId: this.mismatchMessageId ?? binding.providerMessageId,
      labelIds: [...this.labels],
      isDraft: this.isDraft,
    };
  }
}

function executionFixture() {
  return {
    stateReader: new MutableStateReader(),
    labelClient: new FakeLabelClient(),
    effectStore: new MemoryEffectStore(),
  };
}

describe("Gmail mailbox disposition effect", () => {
  test("consumes the merged outbound delivery receipt instead of inventing provider identity", () => {
    expect(settledGmailMessageBindingFromDeliveryReceipt({
      receipt: receipt(),
      stensiblyLabelId: "Label_6",
    })).toEqual(binding);

    expect(() => settledGmailMessageBindingFromDeliveryReceipt({
      receipt: receipt({
        result: "ambiguous",
        providerThreadId: null,
        providerMessageId: null,
        recoveryAction: "reconcile_before_retry",
      }),
      stensiblyLabelId: "Label_6",
    })).toThrow("settled successful Gmail delivery receipt");
  });

  test("full #1522 matrix keeps semantic class independent from human visibility", () => {
    const classes: MailAttentionClass[] = ["handoff", "review", "decision", "incident"];
    for (const attentionClass of classes) {
      const quiet = buildGmailMailboxDispositionEffect(binding, state({
        attentionClass,
        operatorAttentionRequired: false,
      }));
      expect(quiet.disposition).toEqual({
        label: "Stensibly",
        archive: true,
        markRead: true,
        reason: "routine",
      });
      expect(quiet.requiredLabelIds).toEqual(["Label_6"]);
      expect(quiet.forbiddenLabelIds).toEqual(["INBOX", "UNREAD"]);
      expect(quiet.authorizesMailSend).toBe(false);
    }

    const visible = buildGmailMailboxDispositionEffect(binding, state({
      attentionClass: "handoff",
      operatorAttentionRequired: true,
    }));
    expect(visible.disposition).toEqual({
      label: "Stensibly",
      archive: false,
      markRead: false,
      reason: "operator_attention",
    });
    expect(visible.requiredLabelIds).toEqual(["Label_6", "INBOX", "UNREAD"]);
    expect(visible.forbiddenLabelIds).toEqual([]);

    for (const lifecycle of ["waiting", "resolved"] as const) {
      const quiet = buildGmailMailboxDispositionEffect(binding, state({
        state: lifecycle,
        operatorAttentionRequired: true,
      }));
      expect(quiet.requiredLabelIds).toEqual(["Label_6"]);
      expect(quiet.forbiddenLabelIds).toEqual(["INBOX", "UNREAD"]);
      expect(quiet.disposition.reason).toBe(lifecycle);
    }
  });

  test("active explicit human attention is applied once and exact replay sends no second mutation", async () => {
    const fixture = executionFixture();
    const first = await executeGmailMailboxDispositionEffect({
      binding,
      ...fixture,
    });
    expect(first.status).toBe("applied");
    expect(fixture.labelClient.labels).toEqual(
      new Set(["SENT", "Label_6", "INBOX", "UNREAD"]),
    );
    expect(fixture.labelClient.mutations).toHaveLength(1);
    expect(fixture.labelClient.mutations[0]?.addLabelIds).toEqual([
      "Label_6",
      "INBOX",
      "UNREAD",
    ]);
    expect(fixture.labelClient.mutations[0]?.removeLabelIds).toEqual([]);

    const replay = await executeGmailMailboxDispositionEffect({
      binding,
      ...fixture,
    });
    expect(replay.status).toBe("replayed");
    expect(replay.effect.effectId).toBe(first.effect?.effectId);
    expect(fixture.labelClient.mutations).toHaveLength(1);
  });

  test("active true to resolved changes only disposition effect and keeps the same provider message searchable", async () => {
    const fixture = executionFixture();
    const active = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(active.status).toBe("applied");
    const activeEffectId = active.effect?.effectId;

    fixture.stateReader.current = state({
      revision: "state-r2-resolved",
      state: "resolved",
      operatorAttentionRequired: true,
    });
    const resolved = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(resolved.status).toBe("applied");
    expect(resolved.effect.effectId).not.toBe(activeEffectId);
    expect(resolved.effect.binding.providerThreadId).toBe(binding.providerThreadId);
    expect(resolved.effect.binding.providerMessageId).toBe(binding.providerMessageId);
    expect(fixture.labelClient.labels).toEqual(new Set(["SENT", "Label_6"]));
    expect(fixture.labelClient.mutations).toHaveLength(2);
    expect(fixture.labelClient.mutations[1]?.addLabelIds).toEqual([]);
    expect(fixture.labelClient.mutations[1]?.removeLabelIds).toEqual(["INBOX", "UNREAD"]);

    const repeatedResolved = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(repeatedResolved.status).toBe("replayed");
    expect(fixture.labelClient.mutations).toHaveLength(2);
  });

  test("draft-only provider object is excluded from surfaced attention and never mutated", async () => {
    const fixture = executionFixture();
    fixture.labelClient.isDraft = true;
    fixture.labelClient.labels = new Set(["DRAFT"]);

    const result = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(result.status).toBe("ignored_draft");
    expect(fixture.labelClient.labels).toEqual(new Set(["DRAFT"]));
    expect(fixture.labelClient.mutations).toHaveLength(0);
  });

  test("ambiguous mutation enters reconciliation and exact replay cannot blindly mutate", async () => {
    const fixture = executionFixture();
    fixture.labelClient.mutationMode = "apply_then_throw";

    const first = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(first.status).toBe("reconciliation_required");
    if (first.status !== "reconciliation_required") throw new Error("expected reconciliation");
    expect(first.phase).toBe("mutation_outcome");
    expect(fixture.labelClient.mutations).toHaveLength(1);

    const replay = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(replay.status).toBe("reconciliation_required");
    expect(fixture.labelClient.mutations).toHaveLength(1);

    const reconciled = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...fixture,
    });
    expect(reconciled.status).toBe("reconciled");

    const after = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(after.status).toBe("replayed");
    expect(fixture.labelClient.mutations).toHaveLength(1);
  });

  test("newer STN state is fenced behind an unresolved older mutation outcome", async () => {
    const fixture = executionFixture();
    fixture.labelClient.mutationMode = "throw_before_apply";

    const first = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(first.status).toBe("reconciliation_required");
    if (first.status !== "reconciliation_required") throw new Error("expected reconciliation");
    expect(fixture.labelClient.mutations).toHaveLength(1);

    fixture.stateReader.current = state({
      revision: "state-r2-resolved",
      state: "resolved",
      operatorAttentionRequired: false,
    });
    const newer = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(newer.status).toBe("blocked_by_prior_reconciliation");
    expect(fixture.labelClient.mutations).toHaveLength(1);

    const unresolved = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...fixture,
    });
    expect(unresolved.status).toBe("superseded");
    if (unresolved.status !== "superseded") throw new Error("expected superseded");
    expect(unresolved.priorEffectCleared).toBe(false);

    fixture.labelClient.labels = new Set(["SENT", "Label_6", "INBOX", "UNREAD"]);
    const oldOutcomeProved = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...fixture,
    });
    expect(oldOutcomeProved.status).toBe("superseded");
    if (oldOutcomeProved.status !== "superseded") throw new Error("expected superseded");
    expect(oldOutcomeProved.priorEffectCleared).toBe(true);

    fixture.labelClient.mutationMode = "success";
    const resolved = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(resolved.status).toBe("applied");
    expect(fixture.labelClient.labels).toEqual(new Set(["SENT", "Label_6"]));
    expect(fixture.labelClient.mutations).toHaveLength(2);
  });

  test("provider read failure is reconciled before a safe retry and never mutates blindly", async () => {
    const fixture = executionFixture();
    fixture.labelClient.failReadNumbers.add(1);

    const first = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(first.status).toBe("reconciliation_required");
    if (first.status !== "reconciliation_required") throw new Error("expected reconciliation");
    expect(first.phase).toBe("precondition_read");
    expect(fixture.labelClient.mutations).toHaveLength(0);

    const replay = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(replay.status).toBe("reconciliation_required");
    expect(fixture.labelClient.mutations).toHaveLength(0);

    const reconciled = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...fixture,
    });
    expect(reconciled.status).toBe("retry_safe");

    const retry = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(retry.status).toBe("applied");
    expect(fixture.labelClient.mutations).toHaveLength(1);
  });

  test("current durable STN state is authoritative and provider identity conflicts fail closed", async () => {
    const fixture = executionFixture();
    fixture.stateReader.current = {
      ...state({ operatorAttentionRequired: false }),
      source: "mail_body" as "durable_stn_state",
    };
    const untrustedState = await executeGmailMailboxDispositionEffect({ binding, ...fixture });
    expect(untrustedState.status).toBe("blocked");
    if (untrustedState.status !== "blocked") throw new Error("expected blocked");
    expect(untrustedState.reason).toBe("current_state_identity_conflict");
    expect(fixture.labelClient.reads).toBe(0);
    expect(fixture.labelClient.mutations).toHaveLength(0);

    fixture.stateReader.current = state({ operatorAttentionRequired: false });
    fixture.labelClient.mismatchMessageId = "different_message";
    const wrongMessage = await executeGmailMailboxDispositionEffect({
      binding,
      stateReader: fixture.stateReader,
      labelClient: fixture.labelClient,
      effectStore: new MemoryEffectStore(),
    });
    expect(wrongMessage.status).toBe("blocked");
    if (wrongMessage.status !== "blocked") throw new Error("expected blocked");
    expect(wrongMessage.reason).toBe("provider_identity_conflict");
    expect(fixture.labelClient.mutations).toHaveLength(0);
  });

  test("changed durable state creates a new label-only effect without any mail-send authority", () => {
    const first = buildGmailMailboxDispositionEffect(binding, state({
      revision: "state-r1",
      operatorAttentionRequired: false,
    }));
    const second = buildGmailMailboxDispositionEffect(binding, state({
      revision: "state-r2",
      operatorAttentionRequired: true,
    }));
    expect(first.effectId).not.toBe(second.effectId);
    expect(first.binding.providerMessageId).toBe(second.binding.providerMessageId);
    expect(first.authorizesMailSend).toBe(false);
    expect(second.authorizesMailSend).toBe(false);
  });
});
