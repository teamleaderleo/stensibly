import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import type {
  CurrentDurableStnMailboxState,
  GmailMailboxDispositionEffect,
  GmailMailboxDispositionEffectRecord,
  GmailMailboxDispositionReconciliationPhase,
  GmailMailboxDispositionReserveResult,
  GmailMailboxDispositionSettledOutcome,
  GmailMailboxLabelClient,
  GmailMessageLabelSnapshot,
  SettledGmailMessageBinding,
} from "../src/gmail-mailbox-disposition-effect.ts";
import type { GmailOutboundClient } from "../src/gmail-mail-provider.ts";
import {
  HostedGmailOutboundService,
  type HostedGmailMailboxDispositionStore,
} from "../src/hosted-gmail-outbound-service.ts";
import type { MailDeliveryReceipt } from "../src/mail-provider.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

class FakeGmailClient implements GmailOutboundClient {
  sent = 0;
  async sendRaw(input: { raw: string; threadId?: string }) {
    this.sent += 1;
    return {
      id: `gmail_message_${this.sent}`,
      threadId: input.threadId ?? `gmail_thread_${this.sent}`,
      acceptedAt: `2026-08-15T08:10:${String(this.sent).padStart(2, "0")}.000Z`,
    };
  }
  async findMessagesByRfcMessageId() {
    return [];
  }
}

class MemoryDispositionStore implements HostedGmailMailboxDispositionStore {
  readonly states = new Map<string, CurrentDurableStnMailboxState>();
  readonly deliveries = new Map<string, MailDeliveryReceipt>();
  readonly effects = new Map<string, GmailMailboxDispositionEffectRecord>();
  failRecordSettledDeliveryOnce = false;

  async putCurrentState(state: CurrentDurableStnMailboxState) {
    const prior = this.states.get(state.stnThreadId);
    if (prior?.revision === state.revision && JSON.stringify(prior) !== JSON.stringify(state)) {
      throw new Error("state revision conflict");
    }
    this.states.set(state.stnThreadId, structuredClone(state));
    return structuredClone(state);
  }

  async readCurrentState(input: { stnThreadId: string }) {
    return structuredClone(this.states.get(input.stnThreadId) ?? null);
  }

  async recordSettledDelivery(receipt: MailDeliveryReceipt) {
    if (this.failRecordSettledDeliveryOnce) {
      this.failRecordSettledDeliveryOnce = false;
      throw new Error("simulated crash before disposition reservation");
    }
    const prior = this.deliveries.get(receipt.threadId);
    if (!prior || Date.parse(receipt.attemptedAt) >= Date.parse(prior.attemptedAt)) {
      this.deliveries.set(receipt.threadId, structuredClone(receipt));
    }
    return structuredClone(this.deliveries.get(receipt.threadId)!);
  }

  async getSettledDelivery(stnThreadId: string) {
    return structuredClone(this.deliveries.get(stnThreadId) ?? null);
  }

  async getEffectRecord(effectId: string) {
    return structuredClone(this.effects.get(effectId) ?? null);
  }

  async findOutstandingForTarget(target: SettledGmailMessageBinding) {
    for (const record of this.effects.values()) {
      if (
        record.status !== "settled"
        && record.effect.binding.accountBinding === target.accountBinding
        && record.effect.binding.mailboxAddress === target.mailboxAddress
        && record.effect.binding.providerThreadId === target.providerThreadId
        && record.effect.binding.providerMessageId === target.providerMessageId
      ) return structuredClone(record);
    }
    return null;
  }

  async reserveEffect(effect: GmailMailboxDispositionEffect): Promise<GmailMailboxDispositionReserveResult> {
    const existing = this.effects.get(effect.effectId);
    if (existing) return { status: "existing", record: structuredClone(existing) };
    this.effects.set(effect.effectId, {
      effect: structuredClone(effect),
      status: "reserved",
      reconciliationPhase: null,
      settledOutcome: null,
    });
    return { status: "reserved" };
  }

  async markReconciliationRequired(effectId: string, phase: GmailMailboxDispositionReconciliationPhase) {
    const record = this.required(effectId);
    this.effects.set(effectId, {
      ...record,
      status: "reconciliation_required",
      reconciliationPhase: phase,
      settledOutcome: null,
    });
  }

  async markSettled(effectId: string, outcome: GmailMailboxDispositionSettledOutcome) {
    const record = this.required(effectId);
    this.effects.set(effectId, {
      ...record,
      status: "settled",
      reconciliationPhase: null,
      settledOutcome: outcome,
    });
  }

  async releasePreconditionRetry(effectId: string) {
    this.required(effectId);
    this.effects.delete(effectId);
  }

  private required(effectId: string) {
    const record = this.effects.get(effectId);
    if (!record) throw new Error(`missing effect ${effectId}`);
    return record;
  }
}

type MutationMode = "success" | "apply_then_throw" | "throw_before_apply" | "partial_then_throw";

class FakeLabelClient implements GmailMailboxLabelClient {
  readonly labels = new Map<string, Set<string>>();
  initialLabels: readonly string[] = ["SENT"];
  mutations = 0;
  reads = 0;
  mutationMode: MutationMode = "success";

  async readMessageLabels(input: {
    accountBinding: string;
    mailboxAddress: string;
    providerThreadId: string;
    providerMessageId: string;
  }): Promise<GmailMessageLabelSnapshot> {
    this.reads += 1;
    return {
      source: "gmail_message_label_snapshot",
      provider: "gmail",
      accountBinding: input.accountBinding,
      mailboxAddress: input.mailboxAddress,
      providerThreadId: input.providerThreadId,
      providerMessageId: input.providerMessageId,
      labelIds: [...this.messageLabels(input.providerMessageId)],
      isDraft: false,
    };
  }

  async mutateMessageLabels(input: {
    providerMessageId: string;
    addLabelIds: readonly string[];
    removeLabelIds: readonly string[];
  }) {
    this.mutations += 1;
    if (this.mutationMode === "throw_before_apply") throw new Error("provider failed before apply");
    const labels = this.messageLabels(input.providerMessageId);
    if (this.mutationMode === "partial_then_throw") {
      if (input.addLabelIds[0]) labels.add(input.addLabelIds[0]);
      if (input.removeLabelIds[0]) labels.delete(input.removeLabelIds[0]);
      throw new Error("partial provider mutation");
    }
    for (const label of input.addLabelIds) labels.add(label);
    for (const label of input.removeLabelIds) labels.delete(label);
    if (this.mutationMode === "apply_then_throw") throw new Error("provider response lost");
  }

  messageLabels(providerMessageId: string) {
    let labels = this.labels.get(providerMessageId);
    if (!labels) {
      labels = new Set(this.initialLabels);
      this.labels.set(providerMessageId, labels);
    }
    return labels;
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
    nextAction: "Refresh GitHub issue 1522 and continue.",
    sourceObject: "github:teamleaderleo/stensibly#1522",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "Hosted outbound checkpoint is accepted.",
    threadState: "open" as const,
    currentMailboxState: {
      revision: "state-r1",
      state: "active" as const,
      operatorAttentionRequired: false,
    },
    references: [],
    continuesFromHandle: null,
    ...overrides,
  };
}

function serviceFixture() {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const gmailClient = new FakeGmailClient();
  const mailboxDispositionStore = new MemoryDispositionStore();
  const gmailLabelClient = new FakeLabelClient();
  const binding = {
    workspace: "test",
    project: "stensibly",
    accountBinding: "gmail_operator_primary",
    mailboxAddress: "operator@example.com",
    stensiblyLabelId: "Label_6",
  };
  const service = new HostedGmailOutboundService({
    store,
    gmailClient,
    mailboxDispositionStore,
    gmailLabelClient,
    binding,
    now: () => "2026-08-15T08:10:00.000Z",
  });
  return { store, gmailClient, mailboxDispositionStore, gmailLabelClient, binding, service };
}

describe("HostedGmailOutboundService automatic disposition", () => {
  test("routine delivery is quiet and exact replay sends/mutates nothing twice", async () => {
    const f = serviceFixture();
    const first = await f.service.publish(material());
    expect(first.outcome).toBe("sent");
    expect(first.mailboxDisposition?.status).toBe("settled");
    const messageId = first.receipt.providerMessageId!;
    expect(f.gmailLabelClient.messageLabels(messageId)).toEqual(new Set(["SENT", "Label_6"]));
    expect(f.gmailClient.sent).toBe(1);
    expect(f.gmailLabelClient.mutations).toBe(1);

    const replay = await f.service.publish(material());
    expect(replay.outcome).toBe("replayed");
    expect(replay.mailboxDisposition?.status).toBe("settled");
    expect(f.gmailClient.sent).toBe(1);
    expect(f.gmailLabelClient.mutations).toBe(1);
    f.store.close();
  });

  test("a crash after durable delivery but before disposition reservation recovers on service replay without duplicate mail", async () => {
    const f = serviceFixture();
    f.mailboxDispositionStore.failRecordSettledDeliveryOnce = true;
    await expect(f.service.publish(material({
      sourceIdentity: "attention:hosted:pre-reservation-crash",
      sourceFingerprint: sha256("hosted-pre-reservation-crash"),
    }))).rejects.toThrow("simulated crash before disposition reservation");
    expect(f.gmailClient.sent).toBe(1);
    expect(f.mailboxDispositionStore.effects.size).toBe(0);

    const restarted = new HostedGmailOutboundService({
      store: f.store,
      gmailClient: f.gmailClient,
      mailboxDispositionStore: f.mailboxDispositionStore,
      gmailLabelClient: f.gmailLabelClient,
      binding: f.binding,
      now: () => "2026-08-15T08:10:00.000Z",
    });
    const replay = await restarted.publish(material({
      sourceIdentity: "attention:hosted:pre-reservation-crash",
      sourceFingerprint: sha256("hosted-pre-reservation-crash"),
    }));
    expect(replay.outcome).toBe("replayed");
    expect(replay.mailboxDisposition?.status).toBe("settled");
    expect(f.gmailClient.sent).toBe(1);
    expect(f.gmailLabelClient.mutations).toBe(1);
    f.store.close();
  });

  test("current human attention is visible and a newer resolved state quiets the same provider message", async () => {
    const f = serviceFixture();
    const first = await f.service.publish(material({
      sourceIdentity: "attention:hosted:human",
      threadClass: "decision",
      canonicalSubject: "Operator decision required",
      sourceFingerprint: sha256("hosted-human-v1"),
      currentMailboxState: {
        revision: "state-human-r1",
        state: "active",
        operatorAttentionRequired: true,
      },
    }));
    const messageId = first.receipt.providerMessageId!;
    expect(f.gmailLabelClient.messageLabels(messageId)).toEqual(new Set(["SENT", "Label_6", "INBOX", "UNREAD"]));
    expect(f.gmailClient.sent).toBe(1);

    // Human browsing changes provider presentation only; durable coordination state stays active + required.
    f.gmailLabelClient.messageLabels(messageId).delete("UNREAD");
    const durable = await f.service.getCurrentMailboxState(first.thread.threadId);
    expect(durable?.operatorAttentionRequired).toBe(true);
    expect(durable?.state).toBe("active");

    const resolved = await f.service.updateCurrentMailboxState({
      source: "durable_stn_state",
      stnThreadId: first.thread.threadId,
      revision: "state-human-r2",
      attentionClass: "decision",
      operatorAttentionRequired: false,
      state: "resolved",
    });
    expect(resolved.status).toBe("settled");
    expect(f.gmailClient.sent).toBe(1);
    expect(f.gmailLabelClient.messageLabels(messageId)).toEqual(new Set(["SENT", "Label_6"]));

    const resolvedReplay = await f.service.updateCurrentMailboxState({
      source: "durable_stn_state",
      stnThreadId: first.thread.threadId,
      revision: "state-human-r2",
      attentionClass: "decision",
      operatorAttentionRequired: false,
      state: "resolved",
    });
    expect(resolvedReplay.status).toBe("settled");
    expect(f.gmailClient.sent).toBe(1);
    expect(f.gmailLabelClient.mutations).toBe(2);
    f.store.close();
  });

  test("response-lost mutation settles by exact readback and restart replay is mutation-free", async () => {
    const f = serviceFixture();
    f.gmailLabelClient.mutationMode = "apply_then_throw";
    const first = await f.service.publish(material({
      sourceIdentity: "attention:hosted:ambiguous",
      sourceFingerprint: sha256("hosted-ambiguous-v1"),
    }));
    expect(first.mailboxDisposition).toMatchObject({ status: "settled", outcome: "reconciled" });
    expect(f.gmailLabelClient.mutations).toBe(1);
    expect(f.gmailClient.sent).toBe(1);

    f.gmailLabelClient.mutationMode = "success";
    const restarted = new HostedGmailOutboundService({
      store: f.store,
      gmailClient: f.gmailClient,
      mailboxDispositionStore: f.mailboxDispositionStore,
      gmailLabelClient: f.gmailLabelClient,
      binding: f.binding,
      now: () => "2026-08-15T08:10:00.000Z",
    });
    const replay = await restarted.publish(material({
      sourceIdentity: "attention:hosted:ambiguous",
      sourceFingerprint: sha256("hosted-ambiguous-v1"),
    }));
    expect(replay.outcome).toBe("replayed");
    expect(f.gmailClient.sent).toBe(1);
    expect(f.gmailLabelClient.mutations).toBe(1);
    f.store.close();
  });

  test("same-revision unapplied ambiguity stays fenced", async () => {
    const f = serviceFixture();
    f.gmailLabelClient.mutationMode = "throw_before_apply";
    const first = await f.service.publish(material({
      sourceIdentity: "attention:hosted:fenced",
      sourceFingerprint: sha256("hosted-fenced-v1"),
    }));
    expect(first.mailboxDisposition?.status).toBe("reconciliation_required");
    expect(f.gmailLabelClient.mutations).toBe(1);
    const replay = await f.service.publish(material({
      sourceIdentity: "attention:hosted:fenced",
      sourceFingerprint: sha256("hosted-fenced-v1"),
    }));
    expect(replay.mailboxDisposition?.status).toBe("reconciliation_required");
    expect(f.gmailLabelClient.mutations).toBe(1);
    f.store.close();
  });

  test("newer genuine attention safely supersedes an older partially applied quiet mutation", async () => {
    const f = serviceFixture();
    f.gmailLabelClient.initialLabels = ["SENT", "INBOX", "UNREAD"];
    f.gmailLabelClient.mutationMode = "partial_then_throw";
    const first = await f.service.publish(material({
      sourceIdentity: "attention:hosted:partial-quiet",
      sourceFingerprint: sha256("hosted-partial-quiet-v1"),
    }));
    expect(first.mailboxDisposition?.status).toBe("reconciliation_required");
    const messageId = first.receipt.providerMessageId!;
    expect(f.gmailLabelClient.messageLabels(messageId)).toEqual(new Set(["SENT", "Label_6", "UNREAD"]));
    expect(f.gmailLabelClient.mutations).toBe(1);

    f.gmailLabelClient.mutationMode = "success";
    const attention = await f.service.updateCurrentMailboxState({
      source: "durable_stn_state",
      stnThreadId: first.thread.threadId,
      revision: "state-partial-r2",
      attentionClass: "handoff",
      operatorAttentionRequired: true,
      state: "active",
    });
    expect(attention.status).toBe("settled");
    expect(f.gmailClient.sent).toBe(1);
    expect(f.gmailLabelClient.mutations).toBe(2);
    expect(f.gmailLabelClient.messageLabels(messageId)).toEqual(new Set(["SENT", "Label_6", "UNREAD", "INBOX"]));
    f.store.close();
  });
});
