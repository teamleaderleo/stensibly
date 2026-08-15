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

function command(sourceIdentity: string): PublishMailThreadCommand {
  return {
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity,
    canonicalSubject: "Continue bounded outbound mail",
    sourceFingerprint: sha256(sourceIdentity),
    whatChanged: "One exact continuation is ready.",
    attentionReason: "A fresh worker can continue it.",
    nextAction: "Refresh the exact source and continue.",
    sourceObject: "github:teamleaderleo/stensibly#1492",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "The continuation is accepted.",
    threadState: "open",
    mailbox,
  };
}

test("durable replay identity includes the exact mailbox destination", async () => {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const provider = new InMemoryMailProvider();
  const service = new MailOutboundService({
    store,
    provider,
    now: () => "2026-08-15T07:02:00.000Z",
    threadIdFactory: () => "mail_thread_destination_replay",
    handleFactory: () => createMailThreadHandle("handoff", "K8R4"),
  });

  const sent = await service.publish(command("attention:destination-replay"));
  const effect = await store.getDeliveryEffect(sent.receipt.outboundEffectId);
  expect(effect?.state).toBe("sent");

  const drifted = {
    ...effect!,
    mailboxAddress: "operator+other@example.com",
    state: "reserved" as const,
    receipt: null,
  };
  const reservation = await store.reserveDeliveryEffect(drifted);
  expect(reservation.outcome).toBe("conflict");
  expect(reservation.effect.mailboxAddress).toBe(mailbox.mailboxAddress);

  await expect(store.reserveDeliveryEffect({
    ...drifted,
    mailboxAddress: "operator\n@example.com",
  })).rejects.toThrow("Mail provider mailbox address is invalid");
  store.close();
});

test("durable settlement cannot rewrite effect or projection destination", async () => {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const provider = new InMemoryMailProvider();
  provider.setMode("ambiguous_after_send");
  const service = new MailOutboundService({
    store,
    provider,
    now: () => "2026-08-15T07:03:00.000Z",
    threadIdFactory: () => "mail_thread_destination_settlement",
    handleFactory: () => createMailThreadHandle("handoff", "Q7MP"),
  });

  let pending: MailDeliveryPendingReconciliationError | null = null;
  try {
    await service.publish(command("attention:destination-settlement"));
  } catch (error) {
    if (error instanceof MailDeliveryPendingReconciliationError) pending = error;
    else throw error;
  }
  expect(pending).not.toBeNull();
  const effect = pending!.effect;
  expect(effect.state).toBe("ambiguous");
  expect(effect.receipt?.result).toBe("ambiguous");

  const driftedReceipt = Object.freeze({
    ...effect.receipt!,
    mailboxAddress: "operator+other@example.com",
  });
  const driftedEffect = Object.freeze({
    ...effect,
    mailboxAddress: "operator+other@example.com",
    receipt: driftedReceipt,
  });
  await expect(store.settleDeliveryEffect({
    effect: driftedEffect,
    receipt: driftedReceipt,
  })).rejects.toThrow("Mail delivery effect identity changed before settlement");

  const reconciledReceipt = Object.freeze({
    ...effect.receipt!,
    result: "reconciled" as const,
    failureClass: null,
    recoveryAction: "none" as const,
    providerRequestId: "fake_request_reconciled",
    providerThreadId: "fake_thread_reconciled",
    providerMessageId: "fake_message_reconciled",
  });
  const wrongDestinationProjection = Object.freeze({
    version: 1 as const,
    threadId: effect.threadId,
    provider: effect.provider,
    accountBinding: effect.accountBinding,
    mailboxAddress: "operator+other@example.com",
    providerThreadId: "fake_thread_reconciled",
    rootProviderMessageId: "fake_message_reconciled",
    latestProviderMessageId: "fake_message_reconciled",
    rootRfcMessageId: effect.rfcMessageId,
    latestRfcMessageId: effect.rfcMessageId,
    latestSentFingerprint: effect.contentFingerprint,
    lastVerifiedSubject: `[${effect.handle}] Continue bounded outbound mail`,
    lastVerifiedReferences: Object.freeze([]),
    verifiedAt: "2026-08-15T07:03:01.000Z",
  });
  await expect(store.settleDeliveryEffect({
    effect,
    receipt: reconciledReceipt,
    projection: wrongDestinationProjection,
  })).rejects.toThrow("Mail provider projection does not match its outbound effect");
  store.close();
});
