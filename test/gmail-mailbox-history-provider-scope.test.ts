import { describe, expect, test } from "bun:test";
import {
  createMailboxSubscriptionState,
} from "../src/mailbox-intake-contract.ts";
import {
  reconcileGmailMailbox,
  type GmailHistoryClient,
} from "../src/gmail-mailbox-intake.ts";

describe("Gmail provider label scope", () => {
  test("admits message changes when history refs omit labelIds after a label-scoped read", async () => {
    const calls: Array<{ startHistoryId: string; labelId: string }> = [];
    const client: GmailHistoryClient = {
      async listHistory(request) {
        calls.push({
          startHistoryId: request.startHistoryId,
          labelId: request.labelId,
        });
        return {
          historyId: "105",
          history: [{
            id: "101",
            messagesAdded: [{
              message: { id: "m_1", threadId: "t_1" },
            }],
          }, {
            id: "102",
            messagesDeleted: [{
              message: { id: "m_2", threadId: "t_2" },
            }],
          }],
        };
      },
      async renewWatch() {
        throw new Error("watch renewal is outside this fixture");
      },
    };
    const state = createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "gmail",
      scope: { kind: "label", externalId: "Label_5" },
      cursor: { kind: "gmail_history_id", value: "100" },
      coverage: "continuous",
      subscription: {
        externalId: null,
        expiresAt: "2026-08-17T12:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    });

    const result = await reconcileGmailMailbox({
      state,
      notification: null,
      client,
      now: "2026-08-15T12:00:00.000Z",
    });

    expect(calls).toEqual([{ startHistoryId: "100", labelId: "Label_5" }]);
    expect(result.state.cursor.value).toBe("105");
    expect(result.observations.map((entry) => [
      entry.eventType,
      entry.providerMessageId,
    ])).toEqual([
      ["mail.message.created", "m_1"],
      ["mail.message.deleted", "m_2"],
    ]);
  });

  test("still rejects an explicitly contradictory message label list", async () => {
    const client: GmailHistoryClient = {
      async listHistory() {
        return {
          historyId: "105",
          history: [{
            id: "101",
            messagesAdded: [{
              message: { id: "m_other", threadId: "t_other", labelIds: ["INBOX"] },
            }],
          }],
        };
      },
      async renewWatch() {
        throw new Error("watch renewal is outside this fixture");
      },
    };
    const state = createMailboxSubscriptionState({
      mailboxBindingId: "mailbox_operator_primary",
      provider: "gmail",
      scope: { kind: "label", externalId: "Label_5" },
      cursor: { kind: "gmail_history_id", value: "100" },
      coverage: "continuous",
      subscription: {
        externalId: null,
        expiresAt: "2026-08-17T12:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: null,
    });

    const result = await reconcileGmailMailbox({
      state,
      notification: null,
      client,
      now: "2026-08-15T12:00:00.000Z",
    });

    expect(result.observations).toEqual([]);
    expect(result.state.cursor.value).toBe("105");
  });
});
