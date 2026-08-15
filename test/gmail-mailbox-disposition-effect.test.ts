import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
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
  accountBinding: "operator-primary",
  mailboxAddress: "operator@example.com",
  providerThreadId: "thread_H7MK",
  providerMessageId: "message_H7MK",
  stensiblyLabelId: "Label_6",
};

function receipt(overrides: Partial<MailDeliveryReceipt> = {}): MailDeliveryReceipt {
  return {
    version: 1,
    outboundEffectId: "mail_effect_H7MK",
    threadId: binding.stnThreadId,
    handle: "STN-DECISION:H7MK",
    provider: "gmail",
    accountBinding: binding.accountBinding,
    mailboxAddress: binding.mailboxAddress,
    attemptNumber: 1,
    contentFingerprint: sha256("h7mk-disposition-receipt"),
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
      ) return record;
    }
    return null;
  }

  async reserveEffect(
    effect: GmailMailboxDispositionEffect,
  ): Promise<GmailMailboxDispositionReserveResult> {
    const existing = this.records.get(effect.effectId);
    if (existing) return { status: "existing", record: existing };
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
    if (!record) throw new Error(`missing effect ${effectId}`);
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
    expect(input).toMatchObject({
      accountBinding: binding.accountBinding,
      mailboxAddress: binding.mailboxAddress,
      providerThreadId: binding.providerThreadId,
      providerMessageId: binding.providerMessageId,
    });
    this.mutations.push({
      dispositionEffectId: input.dispositionEffectId,
      addLabelIds: [...input.addLabelIds],
      removeLabelIds: [...input.removeLabelIds],
    });
    if (this.mutationMode === "throw_before_apply") throw new Error("ambiguous mutation");
    for (const label of input.addLabelIds) this.labels.add(label);
    for (const label of input.removeLabelIds) this.labels.delete(label);
    if (this.mutationMode === "apply_then_throw") throw new Error("response lost after apply");
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

function fixture() {
  return {
    stateReader: new MutableStateReader(),
    labelClient: new FakeLabelClient(),
    effectStore: new MemoryEffectStore(),
  };
}

describe("Gmail mailbox disposition effect", () => {
  test("consumes merged outbound delivery evidence", () => {
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

  test("full #1522 matrix keeps class independent from human visibility", () => {
    const classes: MailAttentionClass[] = ["handoff", "review", "decision", "incident"];
    for (const attentionClass of classes) {
      const quiet = buildGmailMailboxDispositionEffect(binding, state({
        attentionClass,
        operatorAttentionRequired: false,
      }));
      expect(quiet.disposition.reason).toBe("routine");
      expect(quiet.requiredLabelIds).toEqual(["Label_6"]);
      expect(quiet.forbiddenLabelIds).toEqual(["INBOX", "UNREAD"]);
      expect(quiet.authorizesMailSend).toBe(false);
    }
    const visible = buildGmailMailboxDispositionEffect(binding, state({
      attentionClass: "handoff",
      operatorAttentionRequired: true,
    }));
    expect(visible.disposition.reason).toBe("operator_attention");
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

  test("active attention applies once and exact replay is mutation-free", async () => {
    const f = fixture();
    const first = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(first.status).toBe("applied");
    if (first.status !== "applied") throw new Error("expected applied");
    expect(f.labelClient.labels).toEqual(new Set(["SENT", "Label_6", "INBOX", "UNREAD"]));
    expect(f.labelClient.mutations).toHaveLength(1);

    const replay = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(replay.status).toBe("replayed");
    if (replay.status !== "replayed") throw new Error("expected replayed");
    expect(replay.effect.effectId).toBe(first.effect.effectId);
    expect(f.labelClient.mutations).toHaveLength(1);
  });

  test("active true to resolved keeps exact provider identity and repeated resolved is a no-op", async () => {
    const f = fixture();
    const active = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(active.status).toBe("applied");
    if (active.status !== "applied") throw new Error("expected active applied");

    f.stateReader.current = state({
      revision: "state-r2-resolved",
      state: "resolved",
      operatorAttentionRequired: true,
    });
    const resolved = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(resolved.status).toBe("applied");
    if (resolved.status !== "applied") throw new Error("expected resolved applied");
    expect(resolved.effect.effectId).not.toBe(active.effect.effectId);
    expect(resolved.effect.binding.providerThreadId).toBe(binding.providerThreadId);
    expect(resolved.effect.binding.providerMessageId).toBe(binding.providerMessageId);
    expect(f.labelClient.labels).toEqual(new Set(["SENT", "Label_6"]));
    expect(f.labelClient.mutations).toHaveLength(2);

    const replay = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(replay.status).toBe("replayed");
    expect(f.labelClient.mutations).toHaveLength(2);
  });

  test("draft-only provider object is excluded and never mutated", async () => {
    const f = fixture();
    f.labelClient.isDraft = true;
    f.labelClient.labels = new Set(["DRAFT"]);
    const result = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(result.status).toBe("ignored_draft");
    expect(f.labelClient.labels).toEqual(new Set(["DRAFT"]));
    expect(f.labelClient.mutations).toHaveLength(0);
  });

  test("ambiguous applied mutation reconciles before replay", async () => {
    const f = fixture();
    f.labelClient.mutationMode = "apply_then_throw";
    const first = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(first.status).toBe("reconciliation_required");
    if (first.status !== "reconciliation_required") throw new Error("expected reconciliation");
    expect(first.phase).toBe("mutation_outcome");
    expect(f.labelClient.mutations).toHaveLength(1);

    const replay = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(replay.status).toBe("reconciliation_required");
    expect(f.labelClient.mutations).toHaveLength(1);
    const reconciled = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...f,
    });
    expect(reconciled.status).toBe("reconciled");
  });

  test("newer durable state waits for unresolved old mutation reconciliation", async () => {
    const f = fixture();
    f.labelClient.mutationMode = "throw_before_apply";
    const first = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(first.status).toBe("reconciliation_required");
    if (first.status !== "reconciliation_required") throw new Error("expected reconciliation");

    f.stateReader.current = state({
      revision: "state-r2-resolved",
      state: "resolved",
      operatorAttentionRequired: false,
    });
    const newer = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(newer.status).toBe("blocked_by_prior_reconciliation");
    expect(f.labelClient.mutations).toHaveLength(1);

    const pending = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...f,
    });
    expect(pending.status).toBe("superseded");
    if (pending.status !== "superseded") throw new Error("expected superseded");
    expect(pending.priorEffectCleared).toBe(false);

    f.labelClient.labels = new Set(["SENT", "Label_6", "INBOX", "UNREAD"]);
    const proved = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...f,
    });
    expect(proved.status).toBe("superseded");
    if (proved.status !== "superseded") throw new Error("expected superseded");
    expect(proved.priorEffectCleared).toBe(true);

    f.labelClient.mutationMode = "success";
    const resolved = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(resolved.status).toBe("applied");
    expect(f.labelClient.labels).toEqual(new Set(["SENT", "Label_6"]));
    expect(f.labelClient.mutations).toHaveLength(2);
  });

  test("precondition read failure is reconciled before a safe retry", async () => {
    const f = fixture();
    f.labelClient.failReadNumbers.add(1);
    const first = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(first.status).toBe("reconciliation_required");
    if (first.status !== "reconciliation_required") throw new Error("expected reconciliation");
    expect(first.phase).toBe("precondition_read");
    expect(f.labelClient.mutations).toHaveLength(0);

    const replay = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(replay.status).toBe("reconciliation_required");
    const reconcile = await reconcileGmailMailboxDispositionEffect({
      effect: first.effect,
      phase: first.phase,
      ...f,
    });
    expect(reconcile.status).toBe("retry_safe");
    const retry = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(retry.status).toBe("applied");
    expect(f.labelClient.mutations).toHaveLength(1);
  });

  test("durable state provenance and exact provider identity fail closed", async () => {
    const f = fixture();
    f.stateReader.current = {
      ...state({ operatorAttentionRequired: false }),
      source: "mail_body" as "durable_stn_state",
    };
    const untrusted = await executeGmailMailboxDispositionEffect({ binding, ...f });
    expect(untrusted.status).toBe("blocked");
    if (untrusted.status !== "blocked") throw new Error("expected blocked");
    expect(untrusted.reason).toBe("current_state_identity_conflict");
    expect(f.labelClient.reads).toBe(0);

    f.stateReader.current = state({ operatorAttentionRequired: false });
    f.labelClient.mismatchMessageId = "different_message";
    const wrong = await executeGmailMailboxDispositionEffect({
      binding,
      stateReader: f.stateReader,
      labelClient: f.labelClient,
      effectStore: new MemoryEffectStore(),
    });
    expect(wrong.status).toBe("blocked");
    if (wrong.status !== "blocked") throw new Error("expected blocked");
    expect(wrong.reason).toBe("provider_identity_conflict");
    expect(f.labelClient.mutations).toHaveLength(0);
  });

  test("state change creates a new label-only effect on the same provider message", () => {
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
