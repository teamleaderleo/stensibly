import { expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import {
  MailDeliveryPendingReconciliationError,
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service.ts";
import { createMailThreadHandle } from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const mailbox = Object.freeze({
  provider: "fake",
  accountBinding: "operator_primary",
  mailboxAddress: "operator@example.com",
});

function command(version: string): PublishMailThreadCommand {
  return {
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity: "attention:stensibly:1492:race",
    canonicalSubject: "Continue outbound mail threads",
    sourceFingerprint: sha256(`attention-${version}`),
    whatChanged: `Candidate ${version} is current.`,
    attentionReason: "The continuation needs one exact provider update.",
    nextAction: `Review candidate ${version}.`,
    sourceObject: "github:teamleaderleo/stensibly#1492",
    sourceRevision: version.repeat(40),
    blocker: null,
    resolutionCondition: "Exact candidate is accepted or one repair is recorded.",
    threadState: "open",
    mailbox,
  };
}

test("reconciles the exact held effect even after canonical material advances", async () => {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const provider = new InMemoryMailProvider();
  let tick = 0;
  const service = new MailOutboundService({
    store,
    provider,
    now: () => new Date(Date.UTC(2026, 7, 15, 7, 0, tick++)).toISOString(),
    threadIdFactory: () => "mail_thread_race_1",
    handleFactory: () => createMailThreadHandle("handoff", "7K3Q"),
  });

  const first = await service.publish(command("a"));
  expect(first.outcome).toBe("sent");
  expect(provider.sentMessageCount).toBe(1);

  provider.setMode("ambiguous_after_send");
  let pending: MailDeliveryPendingReconciliationError | null = null;
  try {
    await service.publish(command("b"));
  } catch (error) {
    if (error instanceof MailDeliveryPendingReconciliationError) pending = error;
    else throw error;
  }
  expect(pending).not.toBeNull();
  expect(provider.sentMessageCount).toBe(2);
  const heldFingerprint = pending!.effect.contentFingerprint;

  await expect(service.publish(command("c"))).rejects.toBeInstanceOf(
    MailDeliveryPendingReconciliationError,
  );
  expect(provider.sentMessageCount).toBe(2);
  const advanced = await service.getThreadByHandle("STN-HANDOFF:7K3Q");
  expect(advanced?.currentMaterialFingerprint).not.toBe(heldFingerprint);

  provider.setMode("normal");
  const reconciled = await service.reconcile({
    outboundEffectId: pending!.effect.outboundEffectId,
    mailbox,
  });
  expect(reconciled?.outcome).toBe("reconciled");
  expect(reconciled?.projection?.latestSentFingerprint).toBe(heldFingerprint);
  expect(provider.sentMessageCount).toBe(2);

  const newest = await service.publish(command("c"));
  expect(newest.outcome).toBe("sent");
  expect(newest.receipt.providerThreadId).toBe(first.receipt.providerThreadId);
  expect(newest.receipt.contentFingerprint).not.toBe(heldFingerprint);
  expect(provider.sentMessageCount).toBe(3);
  store.close();
});
