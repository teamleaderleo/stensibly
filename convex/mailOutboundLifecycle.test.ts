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
  outboundService,
  seedWorkspace,
  serviceSecret,
  mailbox,
} from "./mailOutbound.testSupport";

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret));

describe("hosted outbound lifecycle parity", () => {
  test("fresh clients preserve replay, same-thread material update, split ancestry, and provider-message lookup", async () => {
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
});
