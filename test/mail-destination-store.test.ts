import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  freezeMailDeliveryReceipt,
  type MailDeliveryReceipt,
  type MailOutboundEffectRecord,
} from "../src/mail-provider.ts";
import {
  createMailThreadHandle,
  createMailThreadRecord,
} from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

function thread(id: string, token: string) {
  return createMailThreadRecord({
    threadId: id,
    handle: createMailThreadHandle("handoff", token),
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    canonicalSubject: "Destination identity regression",
    sourceIdentity: `attention:stensibly:${id}`,
    resolutionCondition: "Exact mailbox destination remains bound.",
    createdAt: "2026-08-15T07:00:00.000Z",
  });
}

function effect(
  canonicalThread: ReturnType<typeof thread>,
  overrides: Partial<MailOutboundEffectRecord> = {},
): MailOutboundEffectRecord {
  return {
    version: 1,
    outboundEffectId: `mailfx_${sha256(`${canonicalThread.threadId}:effect`).slice(-40)}`,
    threadId: canonicalThread.threadId,
    handle: canonicalThread.handle,
    provider: "fake",
    accountBinding: "operator_primary",
    mailboxAddress: "operator@example.com",
    attemptNumber: 1,
    contentFingerprint: sha256(`${canonicalThread.threadId}:material`),
    rfcMessageId: `<stn.${sha256(canonicalThread.threadId).slice(-32)}@mail.stensibly.com>`,
    reservedAt: "2026-08-15T07:00:01.000Z",
    state: "reserved",
    receipt: null,
    ...overrides,
  };
}

function failedReceipt(
  delivery: MailOutboundEffectRecord,
  overrides: Partial<MailDeliveryReceipt> = {},
): MailDeliveryReceipt {
  return freezeMailDeliveryReceipt({
    version: 1,
    outboundEffectId: delivery.outboundEffectId,
    threadId: delivery.threadId,
    handle: delivery.handle,
    provider: delivery.provider,
    accountBinding: delivery.accountBinding,
    mailboxAddress: delivery.mailboxAddress,
    attemptNumber: delivery.attemptNumber,
    contentFingerprint: delivery.contentFingerprint,
    rfcMessageId: delivery.rfcMessageId,
    providerRequestId: null,
    providerThreadId: null,
    providerMessageId: null,
    attemptedAt: delivery.reservedAt,
    result: "failed",
    failureClass: "mail_provider_rejected",
    recoveryAction: "retry_new_attempt",
    containsSecrets: false,
    ...overrides,
  });
}

describe("durable outbound mailbox identity", () => {
  test("rejects destination drift after an earlier failed attempt", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const canonicalThread = thread("mail_thread_destination_1", "K8R4");
    await store.reserveThread(canonicalThread);

    const first = effect(canonicalThread);
    expect((await store.reserveDeliveryEffect(first)).outcome).toBe("reserved");
    await store.settleDeliveryEffect({
      effect: first,
      receipt: failedReceipt(first),
    });

    const redirected = effect(canonicalThread, {
      outboundEffectId: `mailfx_${sha256("redirected-effect").slice(-40)}`,
      mailboxAddress: "operator+other@example.com",
      contentFingerprint: sha256("redirected-material"),
      rfcMessageId: "<stn.redirected@mail.stensibly.com>",
    });
    const reservation = await store.reserveDeliveryEffect(redirected);
    expect(reservation.outcome).toBe("conflict");
    expect(reservation.effect.mailboxAddress).toBe("operator@example.com");
    store.close();
  });

  test("rejects a receipt whose mailbox destination differs from its reserved effect", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const canonicalThread = thread("mail_thread_destination_2", "M7Q3");
    await store.reserveThread(canonicalThread);

    const reserved = effect(canonicalThread);
    expect((await store.reserveDeliveryEffect(reserved)).outcome).toBe("reserved");
    await expect(store.settleDeliveryEffect({
      effect: reserved,
      receipt: failedReceipt(reserved, {
        mailboxAddress: "operator+other@example.com",
      }),
    })).rejects.toThrow("does not match its outbound effect");
    store.close();
  });

  test("rejects header-injection text in a persisted mailbox identity", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const canonicalThread = thread("mail_thread_destination_3", "N6P4");
    await store.reserveThread(canonicalThread);

    await expect(store.reserveDeliveryEffect(effect(canonicalThread, {
      mailboxAddress: "operator@example.com\r\nBcc: attacker@example.com",
    }))).rejects.toThrow("Mail provider mailbox address is invalid");
    store.close();
  });
});
