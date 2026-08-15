import { describe, expect, test } from "bun:test";
import { parseGmailPubSubNotification } from "../src/gmail-mailbox-intake.ts";

const expectedSubscription = "projects/stensibly/subscriptions/gmail-mailbox";

function envelope(subscription = expectedSubscription) {
  return {
    message: {
      data: Buffer.from(JSON.stringify({
        emailAddress: "operator@example.com",
        historyId: "105",
      }), "utf8").toString("base64url"),
      messageId: "pubsub-1",
      publishTime: "2026-08-15T12:00:01.000Z",
    },
    subscription,
  };
}

describe("Gmail Pub/Sub subscription binding", () => {
  test("accepts the configured subscription while dropping its provider path from the hint", () => {
    const parsed = parseGmailPubSubNotification(envelope(), {
      expectedMailboxAddress: "operator@example.com",
      expectedSubscription,
      mailboxBindingId: "mailbox_operator_primary",
      receivedAt: "2026-08-15T12:00:02.000Z",
    });

    expect(parsed.notificationId).toBe("pubsub-1");
    expect(JSON.stringify(parsed)).not.toContain(expectedSubscription);
  });

  test("rejects a Pub/Sub envelope from a different subscription", () => {
    expect(() => parseGmailPubSubNotification(
      envelope("projects/stensibly/subscriptions/other-mailbox"),
      {
        expectedMailboxAddress: "operator@example.com",
        expectedSubscription,
        mailboxBindingId: "mailbox_operator_primary",
        receivedAt: "2026-08-15T12:00:02.000Z",
      },
    )).toThrow("Gmail Pub/Sub subscription binding mismatch");
  });
});
