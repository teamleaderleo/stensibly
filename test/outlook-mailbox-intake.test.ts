import { describe, expect, test } from "bun:test";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import {
  OutlookDeltaCursorExpiredError,
  reconcileOutlookMailbox,
  type OutlookMailboxClient,
  type OutlookMailboxNotification,
} from "../src/outlook-mailbox-intake.ts";

const folderId = "AQMkADAwATY0MDAB-folder-stensibly-handoffs";
const bindingId = "mailbox_outlook_primary";
const now = "2026-08-15T06:45:00.000Z";

function state(input: {
  cursor?: string;
  expiresAt?: string | null;
  health?: "healthy" | "degraded" | "recovering";
  recoveryReason?: string | null;
  subscriptionId?: string | null;
  coverage?: "continuous" | "unknown";
  lastNotificationId?: string | null;
} = {}) {
  return createMailboxSubscriptionState({
    mailboxBindingId: bindingId,
    provider: "outlook",
    scope: { kind: "folder", externalId: folderId },
    cursor: { kind: "outlook_delta_ref", value: input.cursor ?? "delta_ref_100" },
    coverage: input.coverage ?? "continuous",
    subscription: {
      externalId: input.subscriptionId === undefined ? "graph_subscription_1" : input.subscriptionId,
      expiresAt: input.expiresAt === undefined ? "2026-08-16T12:00:00.000Z" : input.expiresAt,
      health: input.health ?? "healthy",
      recoveryReason: input.recoveryReason ?? null,
    },
    lastNotificationId: input.lastNotificationId ?? null,
    lastSuccessfulReconciliationAt: null,
  });
}

function notification(
  lifecycleEvent: OutlookMailboxNotification["lifecycleEvent"] = "change",
  id = "graph_notification_1",
): OutlookMailboxNotification {
  return {
    provider: "outlook",
    mailboxBindingId: bindingId,
    notificationId: id,
    subscriptionId: "graph_subscription_1",
    clientStateVerified: true,
    lifecycleEvent,
    observedAt: "2026-08-15T06:44:59.000Z",
    receivedAt: now,
  };
}

function client(
  overrides: Partial<OutlookMailboxClient> = {},
): OutlookMailboxClient {
  return {
    async listDelta() {
      return {
        changes: [],
        deltaRef: "delta_ref_101",
      };
    },
    async recoverSubscription() {
      return {
        id: "graph_subscription_1",
        expiration: "2026-08-17T12:00:00.000Z",
      };
    },
    ...overrides,
  };
}

describe("Outlook mailbox parity", () => {
  test("maps first-seen immutable Graph messages to provider-neutral folder admission", async () => {
    const result = await reconcileOutlookMailbox({
      state: state(),
      notification: notification(),
      now,
      knownInScopeProviderMessageIds: new Set(),
      client: client({
        async listDelta(request) {
          expect(request).toEqual({
            folderId,
            cursorRef: "delta_ref_100",
          });
          return {
            changes: [{
              immutableId: "AAMkAGI2THVSBBB=",
              conversationId: "AAQkAGI2THVSCCC=",
              removed: false,
            }],
            deltaRef: "delta_ref_101",
          };
        },
      }),
    });

    expect(result.complete).toBe(true);
    expect(result.state.cursor.value).toBe("delta_ref_101");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      provider: "outlook",
      eventType: "mail.scope.added",
      providerMessageId: "AAMkAGI2THVSBBB=",
      providerThreadId: "AAQkAGI2THVSCCC=",
      providerScopeId: folderId,
      wakeEligible: true,
      loopDisposition: "ordinary",
      containsRawContent: false,
      grantsAuthority: false,
    });
  });

  test("keeps known messages as quiet updates and folder exits as quiet scope removals", async () => {
    const result = await reconcileOutlookMailbox({
      state: state(),
      notification: notification(),
      now,
      knownInScopeProviderMessageIds: new Set(["message_existing", "message_removed"]),
      client: client({
        async listDelta() {
          return {
            changes: [
              {
                immutableId: "message_existing",
                conversationId: "conversation_existing",
                removed: false,
              },
              {
                immutableId: "message_removed",
                conversationId: "conversation_existing",
                removed: true,
              },
            ],
            deltaRef: "delta_ref_102",
          };
        },
      }),
    });

    expect(result.observations.map((entry) => ({
      eventType: entry.eventType,
      wakeEligible: entry.wakeEligible,
      providerScopeId: entry.providerScopeId,
    }))).toEqual([
      {
        eventType: "mail.message.updated",
        wakeEligible: false,
        providerScopeId: folderId,
      },
      {
        eventType: "mail.scope.removed",
        wakeEligible: false,
        providerScopeId: folderId,
      },
    ]);
  });

  test("suppresses a first-seen outbound provider message as self echo", async () => {
    const result = await reconcileOutlookMailbox({
      state: state(),
      notification: notification(),
      now,
      knownInScopeProviderMessageIds: new Set(),
      knownOutboundProviderMessageIds: new Set(["message_sent_by_stensibly"]),
      client: client({
        async listDelta() {
          return {
            changes: [{
              immutableId: "message_sent_by_stensibly",
              conversationId: "conversation_1",
              removed: false,
            }],
            deltaRef: "delta_ref_101",
          };
        },
      }),
    });

    expect(result.observations[0]).toMatchObject({
      eventType: "mail.scope.added",
      loopDisposition: "self_echo",
      wakeEligible: false,
    });
  });

  test("paginates delta catch-up and advances only to the final durable delta reference", async () => {
    const requests: unknown[] = [];
    const result = await reconcileOutlookMailbox({
      state: state(),
      notification: notification(),
      now,
      knownInScopeProviderMessageIds: new Set(),
      client: client({
        async listDelta(request) {
          requests.push(request);
          if (request.pageRef === undefined) {
            return {
              changes: [{ immutableId: "message_1", removed: false }],
              nextPageRef: "page_ref_2",
            };
          }
          return {
            changes: [{ immutableId: "message_2", removed: false }],
            deltaRef: "delta_ref_110",
          };
        },
      }),
    });

    expect(requests).toEqual([
      { folderId, cursorRef: "delta_ref_100" },
      { folderId, cursorRef: "delta_ref_100", pageRef: "page_ref_2" },
    ]);
    expect(result.state.cursor.value).toBe("delta_ref_110");
    expect(result.observations.filter((entry) => entry.wakeEligible)).toHaveLength(2);
  });

  test("keeps the cursor fixed and marks coverage unknown when the delta cursor expires", async () => {
    const result = await reconcileOutlookMailbox({
      state: state(),
      notification: notification(),
      now,
      client: client({
        async listDelta() {
          throw new OutlookDeltaCursorExpiredError();
        },
      }),
    });

    expect(result).toMatchObject({
      complete: false,
      recoveryAction: "full_sync_required",
    });
    expect(result.state.cursor.value).toBe("delta_ref_100");
    expect(result.state.coverage).toBe("unknown");
    expect(result.state.subscription).toMatchObject({
      health: "degraded",
      recoveryReason: "delta_cursor_expired",
    });
    expect(result.observations.some((entry) =>
      entry.eventType === "mail.subscription.degraded"
      && entry.wakeEligible === false
      && entry.loopDisposition === "automatic"
    )).toBe(true);
  });

  test("recovers an expired subscription before delta reconciliation and emits quiet recovery evidence", async () => {
    const recoveries: unknown[] = [];
    const result = await reconcileOutlookMailbox({
      state: state({ expiresAt: "2026-08-15T06:44:00.000Z" }),
      notification: null,
      now,
      client: client({
        async recoverSubscription(request) {
          recoveries.push(request);
          return {
            id: "graph_subscription_2",
            expiration: "2026-08-18T06:45:00.000Z",
          };
        },
      }),
    });

    expect(recoveries).toEqual([{
      folderId,
      subscriptionId: "graph_subscription_1",
      reason: "subscription_expired",
    }]);
    expect(result.state.subscription).toEqual({
      externalId: "graph_subscription_2",
      expiresAt: "2026-08-18T06:45:00.000Z",
      health: "healthy",
      recoveryReason: null,
    });
    expect(result.observations.map((entry) => entry.eventType)).toEqual([
      "mail.subscription.degraded",
      "mail.subscription.recovered",
    ]);
    expect(result.observations.every((entry) => entry.wakeEligible === false)).toBe(true);
  });

  test("uses delta catch-up after missed notifications and preserves one quiet operator view", async () => {
    const result = await reconcileOutlookMailbox({
      state: state(),
      notification: notification("missed", "graph_notification_missed_1"),
      now,
      knownInScopeProviderMessageIds: new Set(),
      client: client({
        async listDelta() {
          return {
            changes: [{ immutableId: "message_after_gap", removed: false }],
            deltaRef: "delta_ref_120",
          };
        },
      }),
    });

    expect(result.complete).toBe(true);
    expect(result.state).toMatchObject({
      coverage: "continuous",
      lastNotificationId: "graph_notification_missed_1",
      subscription: { health: "healthy", recoveryReason: null },
    });
    expect(result.observations.filter((entry) => entry.wakeEligible)).toHaveLength(1);
    expect(result.observations.some((entry) =>
      entry.eventType === "mail.subscription.degraded"
      && entry.wakeEligible === false
    )).toBe(true);
    expect(result.observations.some((entry) =>
      entry.eventType === "mail.subscription.recovered"
      && entry.wakeEligible === false
    )).toBe(true);
  });

  test("replays a duplicate notification without creating duplicate semantic observations", async () => {
    const result = await reconcileOutlookMailbox({
      state: state({ lastNotificationId: "graph_notification_1" }),
      notification: notification(),
      now,
      knownInScopeProviderMessageIds: new Set(),
      client: client(),
    });

    expect(result.duplicateNotification).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.observations).toEqual([]);
  });
});
