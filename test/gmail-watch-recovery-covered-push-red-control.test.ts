import { expect, test } from "bun:test";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import {
  parseGmailPubSubNotification,
  reconcileGmailMailbox,
  type GmailHistoryClient,
} from "../src/gmail-mailbox-intake.ts";

const now = "2026-08-15T12:00:00.000Z";
const mailboxAddress = "operator@example.com";
const subscription = "projects/stensibly/subscriptions/gmail-mailbox";

test("an already-covered push cannot declare expired-watch recovery before history catch-up", async () => {
  const state = createMailboxSubscriptionState({
    mailboxBindingId: "mailbox_operator_primary",
    provider: "gmail",
    scope: { kind: "label", externalId: "Label_5" },
    cursor: { kind: "gmail_history_id", value: "105" },
    coverage: "continuous",
    subscription: {
      externalId: subscription,
      expiresAt: "2026-08-15T11:59:59.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: null,
    lastSuccessfulReconciliationAt: "2026-08-15T11:00:00.000Z",
  });
  const notification = parseGmailPubSubNotification({
    message: {
      data: Buffer.from(JSON.stringify({
        emailAddress: mailboxAddress,
        historyId: "104",
      }), "utf8").toString("base64url"),
      messageId: "pubsub-delayed-covered",
      publishTime: "2026-08-15T11:59:58.000Z",
    },
    subscription,
  }, {
    expectedMailboxAddress: mailboxAddress,
    expectedSubscription: subscription,
    mailboxBindingId: state.mailboxBindingId,
    receivedAt: now,
  });

  let historyReads = 0;
  const client: GmailHistoryClient = {
    async renewWatch() {
      return {
        historyId: "120",
        expiration: String(Date.parse("2026-08-22T12:00:00.000Z")),
      };
    },
    async listHistory(request) {
      historyReads += 1;
      expect(request).toEqual({
        startHistoryId: "105",
        labelId: "Label_5",
      });
      return {
        historyId: "120",
        history: [],
      };
    },
  };

  const result = await reconcileGmailMailbox({
    state,
    notification,
    client,
    now,
  });

  expect(historyReads).toBe(1);
  expect(result.complete).toBe(true);
  expect(result.state.cursor.value).toBe("120");
  expect(result.state.subscription.health).toBe("healthy");
  expect(result.observations.map((entry) => entry.eventType)).toEqual([
    "mail.subscription.degraded",
    "mail.subscription.recovered",
  ]);
});
