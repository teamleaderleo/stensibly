import { describe, expect, test } from "bun:test";
import {
  admitOutlookMailboxNotification,
  type OutlookMailboxNotification,
} from "../src/outlook-mailbox-intake.ts";

function notification(
  clientStateVerified: boolean,
): OutlookMailboxNotification {
  return {
    provider: "outlook",
    mailboxBindingId: "mailbox_outlook_primary",
    notificationId: "graph_notification_1",
    subscriptionId: "graph_subscription_1",
    clientStateVerified,
    lifecycleEvent: "change",
    observedAt: "2026-08-15T06:44:59.000Z",
    receivedAt: "2026-08-15T06:45:00.000Z",
  };
}

describe("Outlook notification client-state verification", () => {
  test("admits only notifications whose Microsoft clientState was verified before reconciliation", () => {
    expect(() => admitOutlookMailboxNotification(notification(false))).toThrow(
      "Outlook notification client state was not verified",
    );

    expect(admitOutlookMailboxNotification(notification(true))).toMatchObject({
      provider: "outlook",
      mailboxBindingId: "mailbox_outlook_primary",
      subscriptionId: "graph_subscription_1",
      clientStateVerified: true,
    });
  });
});
