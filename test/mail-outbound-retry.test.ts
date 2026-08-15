import { expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import { MailOutboundService } from "../src/mail-outbound-service.ts";
import { createMailThreadHandle } from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const mailbox = Object.freeze({
  provider: "fake",
  accountBinding: "operator_primary",
  mailboxAddress: "operator@example.com",
});

const command = Object.freeze({
  workspace: "workspace_main",
  project: "stensibly",
  threadClass: "handoff" as const,
  sourceIdentity: "attention:stensibly:1492:retry",
  canonicalSubject: "Retry outbound mail delivery",
  sourceFingerprint: sha256("retry-material-1"),
  whatChanged: "The first provider attempt failed definitively.",
  attentionReason: "The same admitted material still needs delivery.",
  nextAction: "Retry the exact material under a new durable attempt identity.",
  sourceObject: "github:teamleaderleo/stensibly#1492",
  sourceRevision: "retry-revision-1",
  blocker: null,
  resolutionCondition: "One provider delivery succeeds and exact replay is suppressed.",
  threadState: "open" as const,
  mailbox,
});

test("a definite failure retries with a new durable effect and indexes the delivered provider message", async () => {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const provider = new InMemoryMailProvider();
  provider.setMode("definite_failure");
  let tick = 0;
  const service = new MailOutboundService({
    store,
    provider,
    now: () => new Date(Date.UTC(2026, 7, 15, 7, 0, tick++)).toISOString(),
    threadIdFactory: () => "mail_thread_retry_1",
    handleFactory: () => createMailThreadHandle("handoff", "7K3Q"),
  });

  const failed = await service.publish(command);
  expect(failed.outcome).toBe("failed");
  expect(failed.receipt.result).toBe("failed");
  expect(failed.receipt.attemptNumber).toBe(1);
  expect(provider.sentMessageCount).toBe(0);

  provider.setMode("normal");
  const sent = await service.publish(command);
  expect(sent.outcome).toBe("sent");
  expect(sent.receipt.attemptNumber).toBe(2);
  expect(sent.receipt.outboundEffectId).not.toBe(failed.receipt.outboundEffectId);
  expect(sent.receipt.rfcMessageId).not.toBe(failed.receipt.rfcMessageId);
  expect(provider.sentMessageCount).toBe(1);

  const providerMessageId = sent.receipt.providerMessageId;
  expect(providerMessageId).toBeTruthy();
  const durable = await store.getDeliveryEffectByProviderMessageId(
    mailbox.provider,
    mailbox.accountBinding,
    providerMessageId!,
  );
  expect(durable?.outboundEffectId).toBe(sent.receipt.outboundEffectId);
  expect(durable?.attemptNumber).toBe(2);
  expect(durable?.receipt?.providerMessageId).toBe(providerMessageId);

  const replay = await service.publish(command);
  expect(replay.outcome).toBe("replayed");
  expect(replay.receipt.outboundEffectId).toBe(sent.receipt.outboundEffectId);
  expect(provider.sentMessageCount).toBe(1);
  store.close();
});
