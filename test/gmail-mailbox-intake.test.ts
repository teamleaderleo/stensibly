import { describe, expect, test } from "bun:test";
import {
  createMailboxSubscriptionState,
  type MailboxSubscriptionState,
} from "../src/mailbox-intake-contract.ts";
import {
  GmailHistoryCursorExpiredError,
  parseGmailPubSubNotification,
  reconcileGmailMailbox,
  type GmailHistoryClient,
  type GmailHistoryPage,
} from "../src/gmail-mailbox-intake.ts";

const mailboxAddress = "operator@example.com";
const mailboxBindingId = "mailbox_operator_primary";
const labelId = "Label_Stensibly";
const now = "2026-08-15T12:00:00.000Z";
const subscription = "projects/stensibly/subscriptions/gmail-mailbox";

function state(overrides: Partial<MailboxSubscriptionState> = {}): MailboxSubscriptionState {
  return createMailboxSubscriptionState({
    mailboxBindingId,
    provider: "gmail",
    scope: { kind: "label", externalId: labelId },
    cursor: { kind: "gmail_history_id", value: "100" },
    coverage: "continuous",
    subscription: {
      externalId: null,
      expiresAt: "2026-08-17T12:00:00.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: null,
    lastSuccessfulReconciliationAt: "2026-08-15T11:00:00.000Z",
    ...overrides,
  });
}

function notification(historyId = "105", messageId = "pubsub-1") {
  const data = Buffer.from(JSON.stringify({
    emailAddress: mailboxAddress,
    historyId,
  }), "utf8").toString("base64url");
  return parseGmailPubSubNotification({
    message: {
      data,
      messageId,
      publishTime: "2026-08-15T12:00:01.000Z",
    },
    subscription,
  }, {
    expectedMailboxAddress: mailboxAddress,
    expectedSubscription: subscription,
    mailboxBindingId,
    receivedAt: "2026-08-15T12:00:02.000Z",
  });
}

function historyClient(input: {
  pages?: GmailHistoryPage[];
  renewal?: { historyId: string; expiration: string };
  cursorExpired?: boolean;
}) {
  const calls: Array<{ startHistoryId: string; labelId: string; pageToken: string | null }> = [];
  let page = 0;
  const client: GmailHistoryClient = {
    async listHistory(request) {
      calls.push({
        startHistoryId: request.startHistoryId,
        labelId: request.labelId,
        pageToken: request.pageToken ?? null,
      });
      if (input.cursorExpired) throw new GmailHistoryCursorExpiredError();
      const result = input.pages?.[page];
      page += 1;
      if (!result) throw new Error("unexpected history read");
      return result;
    },
    async renewWatch(request) {
      expect(request.labelIds).toEqual([labelId]);
      expect(request.labelFilterBehavior).toBe("include");
      if (!input.renewal) throw new Error("unexpected watch renewal");
      return input.renewal;
    },
  };
  return { client, calls };
}

describe("Gmail mailbox intake", () => {
  test("decodes Pub/Sub into a bounded wake hint without retaining mailbox PII", () => {
    const parsed = notification();

    expect(parsed).toEqual({
      provider: "gmail",
      mailboxBindingId,
      notificationId: "pubsub-1",
      targetHistoryId: "105",
      publishedAt: "2026-08-15T12:00:01.000Z",
      receivedAt: "2026-08-15T12:00:02.000Z",
    });
    expect(JSON.stringify(parsed)).not.toContain(mailboxAddress);
  });

  test("reconciles label-scoped history, suppresses self-echo wake, and advances once complete", async () => {
    const { client, calls } = historyClient({
      pages: [{
        historyId: "105",
        history: [{
          id: "101",
          messagesAdded: [{
            message: { id: "m_self", threadId: "t_self", labelIds: [labelId, "INBOX"] },
          }, {
            message: { id: "m_unrelated", threadId: "t_other", labelIds: ["INBOX"] },
          }],
        }, {
          id: "102",
          labelsAdded: [{
            message: { id: "m_label", threadId: "t_label", labelIds: [labelId, "INBOX"] },
            labelIds: [labelId],
          }],
        }, {
          id: "103",
          labelsRemoved: [{
            message: { id: "m_removed", threadId: "t_removed", labelIds: ["INBOX"] },
            labelIds: [labelId],
          }],
        }, {
          id: "104",
          messagesDeleted: [{
            message: { id: "m_deleted", threadId: "t_deleted", labelIds: [labelId] },
          }],
        }],
      }],
    });

    const result = await reconcileGmailMailbox({
      state: state(),
      notification: notification(),
      client,
      now,
      knownOutboundProviderMessageIds: new Set(["m_self"]),
    });

    expect(calls).toEqual([{ startHistoryId: "100", labelId, pageToken: null }]);
    expect(result.complete).toBe(true);
    expect(result.duplicateNotification).toBe(false);
    expect(result.state.cursor).toEqual({ kind: "gmail_history_id", value: "105" });
    expect(result.state.lastNotificationId).toBe("pubsub-1");
    expect(result.state.lastSuccessfulReconciliationAt).toBe(now);
    expect(result.observations.map((entry) => entry.eventType)).toEqual([
      "mail.message.created",
      "mail.scope.added",
      "mail.scope.removed",
      "mail.message.deleted",
    ]);
    expect(result.observations.some((entry) => entry.providerMessageId === "m_unrelated")).toBe(false);

    const selfEcho = result.observations.find((entry) => entry.providerMessageId === "m_self");
    expect(selfEcho).toMatchObject({
      wakeEligible: false,
      loopDisposition: "self_echo",
      grantsAuthority: false,
      containsRawContent: false,
    });
    expect(JSON.stringify(result.observations)).not.toContain("operator@example.com");
  });

  test("replays duplicate and delayed notifications without another provider read", async () => {
    const base = state({
      cursor: { kind: "gmail_history_id", value: "105" },
      lastNotificationId: "pubsub-1",
    });
    const client: GmailHistoryClient = {
      async listHistory() {
        throw new Error("duplicate notification must not read history");
      },
      async renewWatch() {
        throw new Error("duplicate notification must not renew watch");
      },
    };

    const duplicate = await reconcileGmailMailbox({
      state: base,
      notification: notification("105", "pubsub-1"),
      client,
      now,
    });
    expect(duplicate).toMatchObject({
      complete: true,
      duplicateNotification: true,
      observations: [],
    });

    const delayed = await reconcileGmailMailbox({
      state: base,
      notification: notification("104", "pubsub-old"),
      client,
      now,
    });
    expect(delayed.complete).toBe(true);
    expect(delayed.observations).toEqual([]);
    expect(delayed.state.cursor.value).toBe("105");
    expect(delayed.state.lastNotificationId).toBe("pubsub-old");
  });

  test("periodic reconciliation catches changes even when the push notification was missed", async () => {
    const { client } = historyClient({
      pages: [{
        historyId: "110",
        history: [{
          id: "109",
          messagesAdded: [{
            message: { id: "m_missed", threadId: "t_missed", labelIds: [labelId] },
          }],
        }],
      }],
    });

    const result = await reconcileGmailMailbox({
      state: state(),
      notification: null,
      client,
      now,
    });

    expect(result.complete).toBe(true);
    expect(result.state.cursor.value).toBe("110");
    expect(result.state.lastNotificationId).toBeNull();
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      eventType: "mail.message.created",
      providerMessageId: "m_missed",
      wakeEligible: true,
    });
  });

  test("renews an expired watch without skipping the durable cursor and records recovery", async () => {
    const expired = state({
      subscription: {
        externalId: null,
        expiresAt: "2026-08-15T11:59:59.000Z",
        health: "healthy",
        recoveryReason: null,
      },
    });
    const { client, calls } = historyClient({
      renewal: {
        historyId: "120",
        expiration: String(Date.parse("2026-08-22T12:00:00.000Z")),
      },
      pages: [{ historyId: "120", history: [] }],
    });

    const result = await reconcileGmailMailbox({
      state: expired,
      notification: null,
      client,
      now,
    });

    expect(calls[0]?.startHistoryId).toBe("100");
    expect(result.state.cursor.value).toBe("120");
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

  test("marks coverage unknown when Gmail can no longer reconcile the durable history cursor", async () => {
    const { client } = historyClient({ cursorExpired: true });

    const result = await reconcileGmailMailbox({
      state: state(),
      notification: notification("150", "pubsub-gap"),
      client,
      now,
    });

    expect(result.complete).toBe(false);
    expect(result.recoveryAction).toBe("full_sync_required");
    expect(result.state.cursor.value).toBe("100");
    expect(result.state.coverage).toBe("unknown");
    expect(result.state.subscription).toMatchObject({
      health: "degraded",
      recoveryReason: "history_cursor_expired",
    });
    expect(result.state.lastNotificationId).toBeNull();
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      eventType: "mail.subscription.degraded",
      wakeEligible: false,
      providerMessageId: null,
    });
  });

  test("refuses a provider cursor regression", async () => {
    const { client } = historyClient({
      pages: [{ historyId: "99", history: [] }],
    });

    await expect(reconcileGmailMailbox({
      state: state(),
      notification: null,
      client,
      now,
    })).rejects.toThrow("Gmail history cursor regressed");
  });
});
