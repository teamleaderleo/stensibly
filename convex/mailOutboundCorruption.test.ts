import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sha256 } from "../src/canonical-json";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider";
import { MailDeliveryPendingReconciliationError } from "../src/mail-outbound-service";
import schema from "./schema";
import { modules } from "./test.setup";
import {
  command,
  hostedStore,
  mailbox,
  outboundService,
  seedWorkspace,
  serviceSecret,
  workspace,
} from "./mailOutbound.testSupport";

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret));

describe("hosted outbound ambiguity and corruption fences", () => {
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

  test("altered durable effect JSON fails closed with a bounded conflict", async () => {
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
      .rejects.toThrow(/MAIL_OUTBOUND_EFFECT_(?:RECEIPT|ROW)_CONFLICT/);
  });
});
