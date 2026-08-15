import { describe, expect, test } from "bun:test";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import {
  reconcileGmailMailbox,
  type GmailHistoryClient,
} from "../src/gmail-mailbox-intake.ts";

function gmailState() {
  return createMailboxSubscriptionState({
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
}

function client(): GmailHistoryClient {
  return {
    async listHistory() {
      return {
        historyId: "105",
        history: [{
          id: "101",
          labelsAdded: [{
            message: { id: "m_ordinary", threadId: "t_ordinary" },
            labelIds: ["Label_5"],
          }, {
            message: { id: "m_self", threadId: "t_self" },
            labelIds: ["Label_5"],
          }],
        }, {
          id: "102",
          labelsRemoved: [{
            message: { id: "m_removed", threadId: "t_removed" },
            labelIds: ["Label_5"],
          }],
        }],
      };
    },
    async renewWatch() {
      throw new Error("watch renewal is outside this fixture");
    },
  };
}

describe("Gmail watched-label wake eligibility", () => {
  test("wakes when an ordinary message enters scope and suppresses self echo", async () => {
    const result = await reconcileGmailMailbox({
      state: gmailState(),
      notification: null,
      client: client(),
      now: "2026-08-15T12:00:00.000Z",
      knownOutboundProviderMessageIds: new Set(["m_self"]),
    });

    const ordinary = result.observations.find(
      (entry) => entry.providerMessageId === "m_ordinary",
    );
    const selfEcho = result.observations.find(
      (entry) => entry.providerMessageId === "m_self",
    );
    const removed = result.observations.find(
      (entry) => entry.providerMessageId === "m_removed",
    );

    expect(ordinary).toMatchObject({
      eventType: "mail.scope.added",
      providerScopeId: "Label_5",
      wakeEligible: true,
      loopDisposition: "ordinary",
    });
    expect(selfEcho).toMatchObject({
      eventType: "mail.scope.added",
      providerScopeId: "Label_5",
      wakeEligible: false,
      loopDisposition: "self_echo",
    });
    expect(removed).toMatchObject({
      eventType: "mail.scope.removed",
      providerScopeId: "Label_5",
      wakeEligible: false,
    });
  });
});
