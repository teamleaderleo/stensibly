import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sha256 } from "../src/canonical-json";
import { ConvexMailThreadStore } from "../src/convex-mail-thread-store";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider";
import {
  MailDeliveryPendingReconciliationError,
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service";
import { createMailThreadHandle, type MailThreadClass } from "../src/mail-thread-contract";
import type {
  MailDeliveryReceipt,
  MailOutboundEffectRecord,
  MailProviderProjection,
} from "../src/mail-provider";
import type { MailThreadStore } from "../src/mail-thread-store";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "hosted-outbound-test-secret";
const workspace = "test";
const mailbox = Object.freeze({
  provider: "gmail",
  accountBinding: "gmail_operator_primary",
  mailboxAddress: "operator@example.com",
});

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

function caller(t: ReturnType<typeof convexTest>) {
  return {
    query: async (reference: any, args: Record<string, unknown>) => await t.query(reference, args),
    mutation: async (reference: any, args: Record<string, unknown>) => await t.mutation(reference, args),
  };
}

function hostedStore(t: ReturnType<typeof convexTest>): ConvexMailThreadStore {
  return new ConvexMailThreadStore({ client: caller(t), serviceSecret, workspace });
}

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: workspace,
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

function command(sourceIdentity: string, overrides: Partial<PublishMailThreadCommand> = {}): PublishMailThreadCommand {
  return {
    workspace,
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity,
    canonicalSubject: "Hosted outbound continuation",
    sourceFingerprint: sha256(`${sourceIdentity}:v1`),
    whatChanged: "The hosted continuation is ready.",
    attentionReason: "A durable worker continuation is ready.",
    nextAction: "Refresh the referenced GitHub state and continue.",
    sourceObject: "github:teamleaderleo/stensibly#1518",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "Hosted continuation is accepted.",
    threadState: "open",
    continuationRoute: { mailProvider: "Gmail", sourceSystem: "GitHub" },
    mailbox,
    ...overrides,
  };
}

function outboundService(
  store: MailThreadStore,
  provider: InMemoryMailProvider,
  input: { threadId?: string; handle?: string; now?: string } = {},
): MailOutboundService {
  return new MailOutboundService({
    store,
    provider,
    now: () => input.now ?? "2026-08-15T07:30:00.000Z",
    threadIdFactory: () => input.threadId ?? "mail_thread_hosted",
    handleFactory: (threadClass: MailThreadClass) =>
      createMailThreadHandle(threadClass, input.handle ?? "K8R4"),
  });
}

class FaultStore implements MailThreadStore {
  lastReservation: MailOutboundEffectRecord | null = null;
  fired = false;
  constructor(
    readonly inner: MailThreadStore,
    readonly mode: "before_reservation" | "after_reservation" | "before_sent_settlement" | "after_sent_settlement",
  ) {}

  reserveThread(...args: Parameters<MailThreadStore["reserveThread"]>) { return this.inner.reserveThread(...args); }
  getThreadByHandle(...args: Parameters<MailThreadStore["getThreadByHandle"]>) { return this.inner.getThreadByHandle(...args); }
  getThreadBySource(...args: Parameters<MailThreadStore["getThreadBySource"]>) { return this.inner.getThreadBySource(...args); }
  updateThread(...args: Parameters<MailThreadStore["updateThread"]>) { return this.inner.updateThread(...args); }
  getProviderProjection(...args: Parameters<MailThreadStore["getProviderProjection"]>) { return this.inner.getProviderProjection(...args); }
  getDeliveryEffect(...args: Parameters<MailThreadStore["getDeliveryEffect"]>) { return this.inner.getDeliveryEffect(...args); }
  getDeliveryEffectByProviderMessageId(...args: Parameters<MailThreadStore["getDeliveryEffectByProviderMessageId"]>) {
    return this.inner.getDeliveryEffectByProviderMessageId(...args);
  }

  async reserveDeliveryEffect(effect: MailOutboundEffectRecord) {
    if (!this.fired && this.mode === "before_reservation") {
      this.fired = true;
      throw new Error("simulated crash before reservation");
    }
    const reservation = await this.inner.reserveDeliveryEffect(effect);
    this.lastReservation = reservation.effect;
    if (!this.fired && this.mode === "after_reservation") {
      this.fired = true;
      throw new Error("simulated crash after reservation");
    }
    return reservation;
  }

  async settleDeliveryEffect(input: {
    effect: MailOutboundEffectRecord;
    receipt: MailDeliveryReceipt;
    projection?: MailProviderProjection | null;
  }) {
    const successful = input.receipt.result === "sent" || input.receipt.result === "reconciled";
    if (!this.fired && successful && this.mode === "before_sent_settlement") {
      this.fired = true;
      throw new Error("simulated crash before settlement");
    }
    const settled = await this.inner.settleDeliveryEffect(input);
    if (!this.fired && successful && this.mode === "after_sent_settlement") {
      this.fired = true;
      throw new Error("simulated crash after settlement");
    }
    return settled;
  }
}

describe("hosted outbound MailThreadStore parity", () => {
  test("fresh clients preserve lifecycle, replay, same-thread material update, split ancestry, and provider-message lookup", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");

    const first = await outboundService(hostedStore(t), provider).publish(command("attention:hosted:lifecycle"));
    expect(first.outcome).toBe("sent");
    const replay = await outboundService(hostedStore(t), provider).publish(command("attention:hosted:lifecycle"));
    expect(replay.outcome).toBe("replayed");
    expect(provider.sentMessageCount).toBe(1);

    const changed = await outboundService(hostedStore(t), provider).publish(command("attention:hosted:lifecycle", {
      sourceFingerprint: sha256("attention:hosted:lifecycle:v2"),
      whatChanged: "Hosted continuation material changed.",
      sourceRevision: "b".repeat(40),
    }));
    expect(changed.outcome).toBe("sent");
    expect(changed.receipt.providerThreadId).toBe(first.receipt.providerThreadId);
    expect(provider.sentMessageCount).toBe(2);

    const known = await hostedStore(t).getDeliveryEffectByProviderMessageId(
      "gmail",
      mailbox.accountBinding,
      changed.receipt.providerMessageId!,
    );
    expect(known?.outboundEffectId).toBe(changed.receipt.outboundEffectId);

    const child = await outboundService(hostedStore(t), provider, {
      threadId: "mail_thread_hosted_child",
      handle: "Q7MP",
    }).publish(command("attention:hosted:child", {
      threadClass: "decision",
      canonicalSubject: "Hosted follow-up decision",
      sourceFingerprint: sha256("attention:hosted:child:v1"),
      continuesFromHandle: first.thread.handle,
    }));
    expect(child.thread.continuesFromThreadId).toBe(first.thread.threadId);
    expect(child.receipt.providerThreadId).not.toBe(first.receipt.providerThreadId);
  });

  test("two Worker instances converge to one provider dispatch", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");
    const left = outboundService(hostedStore(t), provider, { threadId: "mail_thread_concurrent", handle: "M7Q4" });
    const right = outboundService(hostedStore(t), provider, { threadId: "mail_thread_concurrent", handle: "M7Q4" });
    const results = await Promise.allSettled([
      left.publish(command("attention:hosted:concurrent")),
      right.publish(command("attention:hosted:concurrent")),
    ]);
    expect(provider.sentMessageCount).toBe(1);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled") as PromiseFulfilledResult<any>[];
    expect(fulfilled.some((entry) => entry.value.outcome === "sent")).toBe(true);
    for (const rejected of results.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[]) {
      expect(rejected.reason).toBeInstanceOf(MailDeliveryPendingReconciliationError);
    }
  });

  test("crash before reservation restarts cleanly and sends once", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");
    const fault = new FaultStore(hostedStore(t), "before_reservation");
    await expect(outboundService(fault, provider, { threadId: "mail_thread_before_reserve", handle: "R7M4" })
      .publish(command("attention:hosted:before-reserve"))).rejects.toThrow("simulated crash before reservation");
    expect(provider.sentMessageCount).toBe(0);
    const recovered = await outboundService(hostedStore(t), provider).publish(command("attention:hosted:before-reserve"));
    expect(recovered.outcome).toBe("sent");
    expect(provider.sentMessageCount).toBe(1);
  });

  test("crash after reservation stays fenced until exact missing reconciliation, then deterministic attempt two sends", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");
    const fault = new FaultStore(hostedStore(t), "after_reservation");
    await expect(outboundService(fault, provider, { threadId: "mail_thread_after_reserve", handle: "T7M4" })
      .publish(command("attention:hosted:after-reserve"))).rejects.toThrow("simulated crash after reservation");
    expect(provider.sentMessageCount).toBe(0);

    const restarted = outboundService(hostedStore(t), provider);
    await expect(restarted.publish(command("attention:hosted:after-reserve")))
      .rejects.toBeInstanceOf(MailDeliveryPendingReconciliationError);
    const missing = await restarted.reconcile({ outboundEffectId: fault.lastReservation!.outboundEffectId, mailbox });
    expect(missing?.outcome).toBe("failed");
    const retried = await restarted.publish(command("attention:hosted:after-reserve"));
    expect(retried.outcome).toBe("sent");
    expect(retried.receipt.attemptNumber).toBe(2);
    expect(provider.sentMessageCount).toBe(1);
  });

  test("provider success before settlement reconciles after restart with zero duplicate dispatch", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");
    const fault = new FaultStore(hostedStore(t), "before_sent_settlement");
    await expect(outboundService(fault, provider, { threadId: "mail_thread_before_settle", handle: "W7M4" })
      .publish(command("attention:hosted:before-settle"))).rejects.toThrow("simulated crash before settlement");
    expect(provider.sentMessageCount).toBe(1);

    const restarted = outboundService(hostedStore(t), provider);
    const reconciled = await restarted.reconcile({ outboundEffectId: fault.lastReservation!.outboundEffectId, mailbox });
    expect(reconciled?.outcome).toBe("reconciled");
    const replay = await restarted.publish(command("attention:hosted:before-settle"));
    expect(replay.outcome).toBe("replayed");
    expect(provider.sentMessageCount).toBe(1);
  });

  test("settlement survives caller crash and provider-message lookup survives a new process", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");
    const fault = new FaultStore(hostedStore(t), "after_sent_settlement");
    await expect(outboundService(fault, provider, { threadId: "mail_thread_after_settle", handle: "Y7M4" })
      .publish(command("attention:hosted:after-settle"))).rejects.toThrow("simulated crash after settlement");
    expect(provider.sentMessageCount).toBe(1);

    const replay = await outboundService(hostedStore(t), provider).publish(command("attention:hosted:after-settle"));
    expect(replay.outcome).toBe("replayed");
    expect(provider.sentMessageCount).toBe(1);
    const known = await hostedStore(t).getDeliveryEffectByProviderMessageId(
      "gmail",
      mailbox.accountBinding,
      replay.receipt.providerMessageId!,
    );
    expect(known?.outboundEffectId).toBe(replay.receipt.outboundEffectId);
  });

  test("ambiguous provider success stays fenced, exact readback reconciles, and alias drift conflicts", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");
    provider.setMode("ambiguous_after_send");
    let pending: MailDeliveryPendingReconciliationError | null = null;
    try {
      await outboundService(hostedStore(t), provider, { threadId: "mail_thread_ambiguous", handle: "A7M4" })
        .publish(command("attention:hosted:ambiguous"));
    } catch (error) {
      if (error instanceof MailDeliveryPendingReconciliationError) pending = error;
      else throw error;
    }
    expect(pending).not.toBeNull();
    expect(provider.sentMessageCount).toBe(1);

    provider.setMode("normal");
    const restarted = outboundService(hostedStore(t), provider);
    const reconciled = await restarted.reconcile({ outboundEffectId: pending!.effect.outboundEffectId, mailbox });
    expect(reconciled?.outcome).toBe("reconciled");
    await expect(restarted.publish(command("attention:hosted:ambiguous", {
      sourceFingerprint: sha256("attention:hosted:ambiguous:v2"),
      whatChanged: "A later material update attempted destination drift.",
      mailbox: { ...mailbox, mailboxAddress: "operator+other@example.com" },
    }))).rejects.toThrow(/destination|conflict/i);
    expect(provider.sentMessageCount).toBe(1);
  });

  test("altered durable effect JSON fails closed", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const provider = new InMemoryMailProvider("gmail");
    const sent = await outboundService(hostedStore(t), provider, { threadId: "mail_thread_corrupt", handle: "C7M4" })
      .publish(command("attention:hosted:corrupt"));

    await t.run(async (ctx: any) => {
      const workspaceRow = await ctx.db.query("workspaces").withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
      const row = await ctx.db.query("mailOutboundEffects").withIndex("by_workspace_effect_id", (q: any) => q
        .eq("workspaceId", workspaceRow._id)
        .eq("outboundEffectId", sent.receipt.outboundEffectId)).unique();
      const value = JSON.parse(row.effectJson);
      value.contentFingerprint = sha256("tampered");
      await ctx.db.patch(row._id, { effectJson: JSON.stringify(value) });
    });

    await expect(hostedStore(t).getDeliveryEffect(sent.receipt.outboundEffectId))
      .rejects.toThrow("MAIL_OUTBOUND_EFFECT_ROW_CONFLICT");
  });
});
