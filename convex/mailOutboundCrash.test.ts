import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider";
import { MailDeliveryPendingReconciliationError } from "../src/mail-outbound-service";
import schema from "./schema";
import { modules } from "./test.setup";
import {
  command,
  FaultStore,
  hostedStore,
  mailbox,
  outboundService,
  seedWorkspace,
  serviceSecret,
} from "./mailOutbound.testSupport";

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret));

describe("hosted outbound crash recovery", () => {
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

  test("crash after reservation stays fenced until exact missing reconciliation, then attempt two sends", async () => {
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
});
