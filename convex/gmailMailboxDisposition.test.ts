import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sha256 } from "../src/canonical-json";
import {
  ConvexGmailMailboxDispositionStore,
  GmailMailboxDispositionLaneBlockedError,
} from "../src/convex-gmail-mailbox-disposition-store";
import {
  buildGmailMailboxDispositionEffect,
  settledGmailMessageBindingFromDeliveryReceipt,
  type CurrentDurableStnMailboxState,
} from "../src/gmail-mailbox-disposition-effect";
import type { MailDeliveryReceipt } from "../src/mail-provider";
import schema from "./schema";
import { modules } from "./test.setup";
import { seedWorkspace, serviceSecret } from "./mailOutbound.testSupport";

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret));

function hostedStore(t: ReturnType<typeof convexTest>) {
  return new ConvexGmailMailboxDispositionStore({
    client: {
      query: (reference, args) => t.query(reference, args),
      mutation: (reference, args) => t.mutation(reference, args),
    },
    serviceSecret,
    workspace: "test",
  });
}

function state(revision = "state-r1", overrides: Partial<CurrentDurableStnMailboxState> = {}): CurrentDurableStnMailboxState {
  return {
    source: "durable_stn_state",
    stnThreadId: "mail_thread_disposition_hosted",
    revision,
    attentionClass: "handoff",
    operatorAttentionRequired: false,
    state: "active",
    ...overrides,
  };
}

function receipt(overrides: Partial<MailDeliveryReceipt> = {}): MailDeliveryReceipt {
  return {
    version: 1,
    outboundEffectId: "mailfx_disposition_hosted",
    threadId: "mail_thread_disposition_hosted",
    handle: "STN-HANDOFF:H7MK",
    provider: "gmail",
    accountBinding: "gmail_operator_primary",
    mailboxAddress: "operator@example.com",
    attemptNumber: 1,
    contentFingerprint: sha256("hosted-disposition-receipt"),
    rfcMessageId: "<hosted-disposition@mail.stensibly.com>",
    providerRequestId: "gmail_request_hosted",
    providerThreadId: "gmail_thread_hosted",
    providerMessageId: "gmail_message_hosted",
    attemptedAt: "2026-08-15T09:30:00.000Z",
    result: "sent",
    failureClass: null,
    recoveryAction: "none",
    containsSecrets: false,
    ...overrides,
  };
}

describe("durable Gmail mailbox disposition persistence", () => {
  test("current state and settled provider target survive fresh service instances", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = hostedStore(t);
    await first.putCurrentState(state());
    await first.recordSettledDelivery(receipt());

    const restarted = hostedStore(t);
    expect(await restarted.readCurrentState({ stnThreadId: state().stnThreadId })).toEqual(state());
    expect(await restarted.getSettledDelivery(state().stnThreadId)).toEqual(receipt());
  });

  test("same state revision is idempotent and altered replay conflicts", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const store = hostedStore(t);
    await store.putCurrentState(state());
    await store.putCurrentState(state());
    await expect(store.putCurrentState(state("state-r1", {
      operatorAttentionRequired: true,
    }))).rejects.toThrow("GMAIL_DISPOSITION_STATE_REVISION_CONFLICT");
  });

  test("two Worker instances converge on one logical effect and altered effect replay conflicts", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const left = hostedStore(t);
    const right = hostedStore(t);
    await left.putCurrentState(state());
    await left.recordSettledDelivery(receipt());
    const binding = settledGmailMessageBindingFromDeliveryReceipt({
      receipt: receipt(),
      stensiblyLabelId: "Label_6",
    });
    const effect = buildGmailMailboxDispositionEffect(binding, state());

    const results = await Promise.all([
      left.reserveEffect(effect),
      right.reserveEffect(effect),
    ]);
    expect(results.map((entry) => entry.status).sort()).toEqual(["existing", "reserved"]);

    const durable = await hostedStore(t).getEffectRecord(effect.effectId);
    expect(durable?.status).toBe("reserved");
    expect(durable?.effect.effectId).toBe(effect.effectId);

    await expect(left.reserveEffect({
      ...effect,
      requiredLabelIds: [...effect.requiredLabelIds, "UNREAD"],
    })).rejects.toThrow("GMAIL_DISPOSITION_EFFECT_IDENTITY_CONFLICT");
  });

  test("unresolved exact-message lane fences a newer revision across process restart", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = hostedStore(t);
    await first.putCurrentState(state());
    await first.recordSettledDelivery(receipt());
    const binding = settledGmailMessageBindingFromDeliveryReceipt({ receipt: receipt(), stensiblyLabelId: "Label_6" });
    const oldEffect = buildGmailMailboxDispositionEffect(binding, state());
    await first.reserveEffect(oldEffect);
    await first.markReconciliationRequired(oldEffect.effectId, "mutation_outcome");

    const newerState = state("state-r2", {
      attentionClass: "decision",
      operatorAttentionRequired: true,
    });
    const restarted = hostedStore(t);
    await restarted.putCurrentState(newerState);
    const newerEffect = buildGmailMailboxDispositionEffect(binding, newerState);
    await expect(restarted.reserveEffect(newerEffect)).rejects.toBeInstanceOf(GmailMailboxDispositionLaneBlockedError);
    const outstanding = await restarted.findOutstandingForTarget(binding);
    expect(outstanding?.effect.effectId).toBe(oldEffect.effectId);
    expect(outstanding?.status).toBe("reconciliation_required");
  });

  test("settlement survives caller loss and exact replay creates no second reservation", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = hostedStore(t);
    await first.putCurrentState(state());
    const binding = settledGmailMessageBindingFromDeliveryReceipt({ receipt: receipt(), stensiblyLabelId: "Label_6" });
    const effect = buildGmailMailboxDispositionEffect(binding, state());
    await first.reserveEffect(effect);
    await first.markSettled(effect.effectId, "applied");

    const restarted = hostedStore(t);
    const replay = await restarted.reserveEffect(effect);
    expect(replay.status).toBe("existing");
    if (replay.status !== "existing") throw new Error("expected durable replay");
    expect(replay.record.status).toBe("settled");
    expect(replay.record.settledOutcome).toBe("applied");
  });
});
