import { describe, expect, test } from "bun:test";
import {
  createMailboxObservation,
  createMailboxSubscriptionState,
} from "../src/mailbox-intake-contract.ts";

describe("Outlook-compatible mailbox intake contract", () => {
  test("accepts opaque Graph folder and message IDs without storing a delta token", () => {
    const state = createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "outlook",
      scope: {
        kind: "folder",
        externalId: "AAMkAGI2THVSAAA=",
      },
      cursor: {
        kind: "outlook_delta_ref",
        value: "cursor_ref_delta_1",
      },
      coverage: "continuous",
      subscription: {
        externalId: "subscription_graph_1",
        expiresAt: "2026-08-16T12:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    });
    expect(state.scope.externalId).toBe("AAMkAGI2THVSAAA=");
    expect(state.cursor.value).toBe("cursor_ref_delta_1");

    const observation = createMailboxObservation({
      provider: "outlook",
      mailboxBindingId: "mailbox_operator_primary",
      sourceSchema: "outlook-delta",
      sourceEventId: "delta_event_1",
      eventType: "mail.scope.added",
      providerCursor: "cursor_ref_delta_2",
      providerMessageId: "AAMkAGI2THVSBBB=",
      providerThreadId: "AAQkAGI2THVSCCC=",
      providerScopeId: "AAMkAGI2THVSAAA=",
      observedAt: "2026-08-15T12:01:00.000Z",
      receivedAt: "2026-08-15T12:01:01.000Z",
      wakeEligible: true,
      loopDisposition: "ordinary",
    });
    expect(observation).toMatchObject({
      provider: "outlook",
      eventType: "mail.scope.added",
      providerMessageId: "AAMkAGI2THVSBBB=",
      providerThreadId: "AAQkAGI2THVSCCC=",
      providerScopeId: "AAMkAGI2THVSAAA=",
      containsRawContent: false,
      grantsAuthority: false,
    });
  });

  test("keeps subscription health events free of message, thread, and scope identities", () => {
    expect(() => createMailboxObservation({
      provider: "outlook",
      mailboxBindingId: "mailbox_operator_primary",
      sourceSchema: "outlook-subscription",
      sourceEventId: "subscription_recovery_1",
      eventType: "mail.subscription.recovered",
      providerCursor: "cursor_ref_delta_2",
      providerMessageId: null,
      providerThreadId: "AAQkAGI2THVSCCC=",
      providerScopeId: null,
      observedAt: "2026-08-15T12:01:00.000Z",
      receivedAt: "2026-08-15T12:01:01.000Z",
      wakeEligible: false,
      loopDisposition: "automatic",
    })).toThrow(
      "Mailbox subscription observations cannot bind message, thread, or scope identities",
    );
  });
});
