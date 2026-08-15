import { describe, expect, test } from "bun:test";
import {
  handleOutlookNotificationRequest,
  runOutlookScheduledReconciliation,
  type OutlookGraphBindings,
  type OutlookRuntimeStore,
  type StoredOutlookAuth,
  type StoredOutlookMailboxBinding,
  type StoredOutlookObservation,
} from "../src/outlook-graph-runtime.ts";
import type {
  MailboxObservation,
  MailboxSubscriptionState,
} from "../src/mailbox-intake-contract.ts";

const now = new Date("2026-08-15T06:45:00.000Z");
const bindings: OutlookGraphBindings = {
  CONVEX_URL: "https://example.convex.cloud",
  STENSIBLY_SERVICE_SECRET: "service-secret-for-tests",
  STENSIBLY_WORKSPACE: "default",
  STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID: "public-client-id",
  STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN: "seed-refresh-token",
  STENSIBLY_OUTLOOK_CLIENT_STATE: "protected-client-state",
  STENSIBLY_OUTLOOK_FOLDER_ID: "folder_stensibly_handoffs",
  STENSIBLY_OUTLOOK_MAILBOX: "cheerleaderleo@outlook.com",
  STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID: "outlook_operator_primary",
  STENSIBLY_OUTLOOK_NOTIFICATION_URL:
    "https://api.stensibly.com/internal/outlook/notifications",
};

class MemoryStore implements OutlookRuntimeStore {
  state: MailboxSubscriptionState | null = null;
  revision = 0;
  observations: StoredOutlookObservation[] = [];
  auth: StoredOutlookAuth | null = null;
  commitCount = 0;
  knownOutbound = new Set<string>();

  async getBinding(): Promise<StoredOutlookMailboxBinding | null> {
    if (!this.state) return null;
    return {
      mailboxBindingId: this.state.mailboxBindingId,
      provider: this.state.provider,
      cursorValue: this.state.cursor.value,
      coverage: this.state.coverage,
      lastNotificationId: this.state.lastNotificationId,
      lastSuccessfulReconciliationAt: this.state.lastSuccessfulReconciliationAt,
      subscription: this.state.subscription,
      scope: this.state.scope,
      revision: this.revision,
    };
  }

  async initialize(state: MailboxSubscriptionState): Promise<void> {
    if (this.state) return;
    this.state = state;
    this.revision = 1;
  }

  async commit(input: {
    mailboxBindingId: string;
    reconciliationId: string;
    expectedRevision: number;
    expectedCursor: string;
    state: MailboxSubscriptionState;
    observations: readonly MailboxObservation[];
  }): Promise<void> {
    expect(input.mailboxBindingId).toBe(bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID);
    expect(input.expectedRevision).toBe(this.revision);
    const currentState = this.state;
    expect(currentState).not.toBeNull();
    expect(input.expectedCursor).toBe(currentState!.cursor.value);
    this.state = input.state;
    this.revision += 1;
    this.commitCount += 1;
    this.observations.push(...input.observations.map((entry) => ({
      eventType: entry.eventType,
      providerMessageId: entry.providerMessageId,
    })));
  }

  async listRecentObservations(): Promise<readonly StoredOutlookObservation[]> {
    return [...this.observations].reverse().slice(0, 100);
  }

  async isKnownOutboundProviderMessage(
    _mailboxBindingId: string,
    providerMessageId: string,
  ): Promise<boolean> {
    return this.knownOutbound.has(providerMessageId);
  }

  async getAuth(): Promise<StoredOutlookAuth | null> {
    return this.auth;
  }

  async setAuth(input: {
    mailboxBindingId: string;
    expectedGeneration: number | null;
    sealedRefreshToken: string;
  }): Promise<void> {
    expect(input.mailboxBindingId).toBe(bindings.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID);
    expect(input.expectedGeneration).toBe(this.auth?.generation ?? null);
    this.auth = {
      sealedRefreshToken: input.sealedRefreshToken,
      generation: (this.auth?.generation ?? 0) + 1,
    };
  }
}

function graphHarness(store: MemoryStore) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let tokenRequests = 0;
  let deltaRequests = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    calls.push({ url, init });

    if (url.includes("/consumers/oauth2/v2.0/token")) {
      tokenRequests += 1;
      const form = init?.body as URLSearchParams;
      expect(form.get("client_id")).toBe(bindings.STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.has("client_secret")).toBe(false);
      expect(form.get("refresh_token")).toBe(
        tokenRequests === 1 ? "seed-refresh-token" : "rotated-refresh-token",
      );
      return Response.json(tokenRequests === 1
        ? { access_token: `access-${tokenRequests}`, refresh_token: "rotated-refresh-token" }
        : { access_token: `access-${tokenRequests}` });
    }
    if (url.includes("/v1.0/me?$select=mail,userPrincipalName")) {
      return Response.json({ mail: bindings.STENSIBLY_OUTLOOK_MAILBOX });
    }
    if (url.endsWith("/v1.0/subscriptions")) {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("prefer")).toBe('IdType="ImmutableId"');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        changeType: "created,updated,deleted",
        notificationUrl: bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL,
        lifecycleNotificationUrl: bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL,
        resource: `me/mailFolders/${bindings.STENSIBLY_OUTLOOK_FOLDER_ID}/messages`,
        expirationDateTime: "2026-08-21T06:45:00.000Z",
        clientState: bindings.STENSIBLY_OUTLOOK_CLIENT_STATE,
      });
      return Response.json({
        id: "graph_subscription_1",
        expirationDateTime: "2026-08-21T06:45:00.000Z",
      });
    }
    if (url.includes("/messages/delta")) {
      deltaRequests += 1;
      expect(new Headers(init?.headers).get("prefer")).toBe('IdType="ImmutableId"');
      if (deltaRequests === 1) {
        return Response.json({
          value: [{ id: "immutable_message_1", conversationId: "conversation_1" }],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/mailFolders/folder_stensibly_handoffs/messages/delta?$deltatoken=one",
        });
      }
      return Response.json({
        value: [],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/folder_stensibly_handoffs/messages/delta?$deltatoken=two",
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl, tokenRequests: () => tokenRequests, deltaRequests: () => deltaRequests };
}

describe("Outlook Graph runtime", () => {
  test("echoes Microsoft's decoded validation token as text/plain without provider work", async () => {
    const response = await handleOutlookNotificationRequest(
      new Request(
        `${bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL}?validationToken=hello%20graph`,
        { method: "POST" },
      ),
      bindings,
      {
        store: {
          async getBinding() { throw new Error("must stay unused"); },
        } as unknown as OutlookRuntimeStore,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("hello graph");
  });

  test("rejects a mismatched clientState before reading durable subscription state", async () => {
    let reads = 0;
    const response = await handleOutlookNotificationRequest(
      new Request(bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{
            subscriptionId: "graph_subscription_1",
            clientState: "wrong-client-state",
          }],
        }),
      }),
      bindings,
      {
        store: {
          async getBinding() {
            reads += 1;
            return null;
          },
        } as unknown as OutlookRuntimeStore,
      },
    );

    expect(response.status).toBe(403);
    expect(reads).toBe(0);
  });

  test("refreshes as a consumer public client, seals a rotated refresh token, creates the folder subscription, and commits immutable delta", async () => {
    const store = new MemoryStore();
    const graph = graphHarness(store);
    const result = await runOutlookScheduledReconciliation(bindings, {
      store,
      fetch: graph.fetchImpl,
      now: () => now,
    });

    expect(result.complete).toBe(true);
    expect(store.state?.subscription).toEqual({
      externalId: "graph_subscription_1",
      expiresAt: "2026-08-21T06:45:00.000Z",
      health: "healthy",
      recoveryReason: null,
    });
    expect(store.state?.cursor.value).not.toContain("deltatoken");
    expect(store.observations.some((entry) =>
      entry.eventType === "mail.scope.added"
      && entry.providerMessageId === "immutable_message_1"
    )).toBe(true);
    expect(store.auth?.sealedRefreshToken.startsWith("v1.")).toBe(true);
    expect(store.auth?.sealedRefreshToken.includes("rotated-refresh-token")).toBe(false);
    expect(graph.tokenRequests()).toBe(1);
    expect(graph.deltaRequests()).toBe(1);
  });

  test("keeps exact duplicate webhook replay quiet after the first reconciliation", async () => {
    const store = new MemoryStore();
    const graph = graphHarness(store);
    await runOutlookScheduledReconciliation(bindings, {
      store,
      fetch: graph.fetchImpl,
      now: () => now,
    });

    const payload = JSON.stringify({
      value: [{
        subscriptionId: "graph_subscription_1",
        clientState: bindings.STENSIBLY_OUTLOOK_CLIENT_STATE,
        changeType: "updated",
        resource: "me/mailFolders/folder_stensibly_handoffs/messages/immutable_message_1",
      }],
    });
    const first = await handleOutlookNotificationRequest(
      new Request(bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
      bindings,
      { store, fetch: graph.fetchImpl, now: () => now },
    );
    expect(first.status).toBe(202);
    const committedAfterFirst = store.commitCount;
    const callsAfterFirst = graph.calls.length;

    const replay = await handleOutlookNotificationRequest(
      new Request(bindings.STENSIBLY_OUTLOOK_NOTIFICATION_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
      bindings,
      { store, fetch: graph.fetchImpl, now: () => now },
    );

    expect(replay.status).toBe(202);
    expect(store.commitCount).toBe(committedAfterFirst);
    expect(graph.calls).toHaveLength(callsAfterFirst);
  });
});