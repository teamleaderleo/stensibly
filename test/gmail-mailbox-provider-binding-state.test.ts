import { describe, expect, test } from "bun:test";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import {
  parseGmailPubSubNotification,
  reconcileGmailMailbox,
  type GmailHistoryClient,
} from "../src/gmail-mailbox-intake.ts";

const mailboxAddress = "operator@example.com";
const subscription = "projects/stensibly/subscriptions/gmail-mailbox";

function notification() {
  return parseGmailPubSubNotification({
    message: {
      data: Buffer.from(JSON.stringify({
        emailAddress: mailboxAddress,
        historyId: "105",
      }), "utf8").toString("base64url"),
      messageId: "pubsub-timing-1",
      publishTime: "2026-08-15T12:00:01.000Z",
    },
    subscription,
  }, {
    expectedMailboxAddress: mailboxAddress,
    expectedSubscription: subscription,
    mailboxBindingId: "mailbox_operator_primary",
    receivedAt: "2026-08-15T12:00:02.000Z",
  });
}

describe("Gmail provider binding state", () => {
  test("uses Pub/Sub publish and receipt times for push-derived observations", async () => {
    const state = createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "gmail",
      scope: { kind: "label", externalId: "Label_5" },
      cursor: { kind: "gmail_history_id", value: "100" },
      coverage: "continuous",
      subscription: {
        externalId: subscription,
        expiresAt: "2026-08-17T12:30:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    });
    const client: GmailHistoryClient = {
      async listHistory() {
        return {
          historyId: "105",
          history: [{
            id: "101",
            messagesAdded: [{
              message: { id: "m_timing", threadId: "t_timing" },
            }],
          }],
        };
      },
      async renewWatch() {
        throw new Error("watch renewal is outside this fixture");
      },
    };

    const result = await reconcileGmailMailbox({
      state,
      notification: notification(),
      client,
      now: "2026-08-15T12:00:30.000Z",
    });

    expect(result.observations[0]).toMatchObject({
      observedAt: "2026-08-15T12:00:01.000Z",
      receivedAt: "2026-08-15T12:00:02.000Z",
    });
    expect(result.state.lastSuccessfulReconciliationAt)
      .toBe("2026-08-15T12:00:30.000Z");
  });

  test("preserves the durable Pub/Sub subscription identity across watch renewal", async () => {
    const state = createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "gmail",
      scope: { kind: "label", externalId: "Label_5" },
      cursor: { kind: "gmail_history_id", value: "100" },
      coverage: "continuous",
      subscription: {
        externalId: subscription,
        expiresAt: "2026-08-15T11:59:59.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    });
    const client: GmailHistoryClient = {
      async listHistory() {
        return { historyId: "120", history: [] };
      },
      async renewWatch() {
        return {
          historyId: "120",
          expiration: String(Date.parse("2026-08-22T12:00:00.000Z")),
        };
      },
    };

    const result = await reconcileGmailMailbox({
      state,
      notification: null,
      client,
      now: "2026-08-15T12:00:00.000Z",
    });

    expect(result.complete).toBe(true);
    expect(result.state.subscription.externalId).toBe(subscription);
    expect(result.state.cursor.value).toBe("120");
  });
});
