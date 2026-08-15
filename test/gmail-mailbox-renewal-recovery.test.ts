import { describe, expect, test } from "bun:test";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import {
  parseGmailPubSubNotification,
  reconcileGmailMailbox,
  type GmailHistoryClient,
} from "../src/gmail-mailbox-intake.ts";

const now = "2026-08-15T12:00:00.000Z";
const mailboxAddress = "operator@example.com";
const subscription = "projects/stensibly/subscriptions/gmail-mailbox";

function expiredState() {
  return createMailboxSubscriptionState({
    mailboxBindingId: "mailbox_operator_primary",
    provider: "gmail",
    scope: { kind: "label", externalId: "Label_5" },
    cursor: { kind: "gmail_history_id", value: "105" },
    coverage: "continuous",
    subscription: {
      externalId: null,
      expiresAt: "2026-08-15T11:59:59.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: null,
    lastSuccessfulReconciliationAt: "2026-08-15T11:00:00.000Z",
  });
}

function notification(historyId: string, messageId: string) {
  return parseGmailPubSubNotification({
    message: {
      data: Buffer.from(JSON.stringify({
        emailAddress: mailboxAddress,
        historyId,
      }), "utf8").toString("base64url"),
      messageId,
      publishTime: "2026-08-15T11:59:58.000Z",
    },
    subscription,
  }, {
    expectedMailboxAddress: mailboxAddress,
    expectedSubscription: subscription,
    mailboxBindingId: "mailbox_operator_primary",
    receivedAt: now,
  });
}

describe("Gmail watch renewal recovery", () => {
  test("returns a durable degraded state when watch renewal fails", async () => {
    let historyReads = 0;
    const client: GmailHistoryClient = {
      async listHistory() {
        historyReads += 1;
        throw new Error("history must wait for watch recovery");
      },
      async renewWatch() {
        throw new Error("provider failure with private details");
      },
    };

    const result = await reconcileGmailMailbox({
      state: expiredState(),
      notification: notification("110", "pubsub-renewal-failed"),
      client,
      now,
    });

    expect(historyReads).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.recoveryAction).toBe("renew_watch");
    expect(result.state.cursor.value).toBe("105");
    expect(result.state.coverage).toBe("continuous");
    expect(result.state.lastNotificationId).toBeNull();
    expect(result.state.subscription).toMatchObject({
      health: "degraded",
      recoveryReason: "watch_renewal_failed",
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      eventType: "mail.subscription.degraded",
      wakeEligible: false,
      loopDisposition: "automatic",
    });
    expect(JSON.stringify(result)).not.toContain("private details");
  });

  test("renews an expired watch even when the Pub/Sub notification is already covered", async () => {
    let historyReads = 0;
    let renewals = 0;
    const client: GmailHistoryClient = {
      async listHistory() {
        historyReads += 1;
        throw new Error("covered notification must not reread history");
      },
      async renewWatch(request) {
        renewals += 1;
        expect(request).toEqual({
          labelIds: ["Label_5"],
          labelFilterBehavior: "include",
        });
        return {
          historyId: "105",
          expiration: String(Date.parse("2026-08-22T12:00:00.000Z")),
        };
      },
    };

    const result = await reconcileGmailMailbox({
      state: expiredState(),
      notification: notification("104", "pubsub-delayed"),
      client,
      now,
    });

    expect(renewals).toBe(1);
    expect(historyReads).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.state.cursor.value).toBe("105");
    expect(result.state.lastNotificationId).toBe("pubsub-delayed");
    expect(result.state.subscription).toEqual({
      externalId: null,
      expiresAt: "2026-08-22T12:00:00.000Z",
      health: "healthy",
      recoveryReason: null,
    });
    expect(result.observations.map((entry) => entry.eventType)).toEqual([
      "mail.subscription.degraded",
      "mail.subscription.recovered",
    ]);
  });
});
