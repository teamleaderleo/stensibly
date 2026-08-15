import { expect, test } from "bun:test";
import { GmailMailboxActionClient } from "../src/gmail-mailbox-actions.ts";
import { GmailMailboxApiClient } from "../src/gmail-mailbox-api.ts";
import {
  parseGmailPubSubNotification,
  reconcileGmailMailbox,
  type GmailHistoryClient,
} from "../src/gmail-mailbox-intake.ts";
import { GmailUnattendedRuntime } from "../src/gmail-unattended-runtime.ts";
import { GoogleOAuthRefreshTokenProvider } from "../src/google-oauth-refresh-token.ts";
import type {
  HostedMailboxIntakeService,
  MailboxIntakeSnapshot,
} from "../src/mailbox-intake-convex-service.ts";
import type {
  MailboxObservation,
  MailboxSubscriptionState,
} from "../src/mailbox-intake-contract.ts";

const mailbox = "leoli.4u@gmail.com";
const bindingId = "gmail_operator_primary";
const labelId = "Label_5";
const subscription = "projects/example/subscriptions/stensibly-gmail-handoffs";
const topic = "projects/example/topics/stensibly-gmail-handoffs";

function tokenProvider(fetchImpl: typeof fetch): GoogleOAuthRefreshTokenProvider {
  return new GoogleOAuthRefreshTokenProvider({
    clientId: "client-id",
    clientSecret: "protected-client-secret",
    refreshToken: "protected-refresh-token",
    fetch: fetchImpl,
    now: () => Date.parse("2026-08-15T07:10:00.000Z"),
  });
}

test("Gmail 401 invalidates only the rejected cached token and retries once", async () => {
  let oauthCalls = 0;
  let gmailCalls = 0;
  const tokenOne = "access-token-one-1234567890";
  const tokenTwo = "access-token-two-1234567890";
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      oauthCalls += 1;
      return new Response(JSON.stringify({
        access_token: oauthCalls === 1 ? tokenOne : tokenTwo,
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200 });
    }
    if (url.includes("/gmail/v1/users/me/history")) {
      gmailCalls += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${tokenOne}`) {
        return new Response("provider rejection must stay private", { status: 401 });
      }
      expect(authorization).toBe(`Bearer ${tokenTwo}`);
      return new Response(JSON.stringify({ historyId: "101", history: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("unexpected provider URL");
  }) as typeof fetch;

  const gmail = new GmailMailboxApiClient({
    tokenProvider: tokenProvider(fakeFetch),
    topicName: topic,
    fetch: fakeFetch,
  });
  const recovered = await gmail.listHistory({ startHistoryId: "100", labelId });
  expect(recovered.historyId).toBe("101");
  expect(oauthCalls).toBe(2);
  expect(gmailCalls).toBe(2);
});

test("Gmail hygiene retries once after the same cached-token rejection", async () => {
  let oauthCalls = 0;
  let listCalls = 0;
  const tokenOne = "access-token-one-1234567890";
  const tokenTwo = "access-token-two-1234567890";
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      oauthCalls += 1;
      return new Response(JSON.stringify({
        access_token: oauthCalls === 1 ? tokenOne : tokenTwo,
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200 });
    }
    if (url.includes("/gmail/v1/users/me/messages")) {
      listCalls += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${tokenOne}`) return new Response("private", { status: 403 });
      expect(authorization).toBe(`Bearer ${tokenTwo}`);
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected provider URL");
  }) as typeof fetch;
  const actions = new GmailMailboxActionClient({
    tokenProvider: tokenProvider(fakeFetch),
    fetch: fakeFetch,
  });
  expect(await actions.archiveMessagesWithLabels([labelId, "INBOX"])).toBe(0);
  expect(oauthCalls).toBe(2);
  expect(listCalls).toBe(2);
});

test("a mailbox intake CAS loser rereads the winning cursor and converges quietly", async () => {
  const initial = stateAt("100", null);
  const winner = stateAt("101", "pubsub-101");
  let bindingReads = 0;
  let commitCalls = 0;
  let historyCalls = 0;
  let hygieneCalls = 0;

  const intake = {
    get: async (): Promise<MailboxIntakeSnapshot> => {
      bindingReads += 1;
      return bindingReads === 1
        ? { state: initial, revision: 1 }
        : { state: winner, revision: 2 };
    },
    commit: async () => {
      commitCalls += 1;
      throw new Error("MAILBOX_INTAKE_REVISION_CONFLICT");
    },
  } as unknown as HostedMailboxIntakeService;

  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail: {
      verifyMailboxAddress: async (address: string) => expect(address).toBe(mailbox),
      renewWatch: async () => {
        throw new Error("watch renewal is not due");
      },
      listHistory: async () => {
        historyCalls += 1;
        return { historyId: "101", history: [] };
      },
    } as unknown as GmailMailboxApiClient,
    actions: {
      archiveMessagesWithLabels: async (labels: readonly string[]) => {
        expect(labels).toEqual([labelId, "INBOX"]);
        hygieneCalls += 1;
        return 0;
      },
    } as unknown as GmailMailboxActionClient,
    intake,
    now: () => "2026-08-15T07:10:30.000Z",
  });

  const result = await runtime.receivePubSubEnvelope(pubsubEnvelope("101"));
  expect(result).toMatchObject({
    cursor: "101",
    revision: 2,
    admittedObservations: 0,
    materialObservations: 0,
  });
  expect(bindingReads).toBe(2);
  expect(commitCalls).toBe(1);
  expect(historyCalls).toBe(1);
  expect(hygieneCalls).toBe(1);
});

test("an already-covered push catches history up when watch renewal advances the baseline", async () => {
  const now = "2026-08-15T12:00:00.000Z";
  const state = {
    ...stateAt("105", null),
    subscription: {
      ...stateAt("105", null).subscription,
      expiresAt: "2026-08-15T11:59:59.000Z",
    },
  } as MailboxSubscriptionState;
  const notification = parseGmailPubSubNotification({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: mailbox, historyId: "104" }), "utf8")
        .toString("base64url"),
      messageId: "pubsub-delayed-covered",
      publishTime: "2026-08-15T11:59:58.000Z",
    },
    subscription,
  }, {
    expectedMailboxAddress: mailbox,
    expectedSubscription: subscription,
    mailboxBindingId: bindingId,
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
      expect(request).toEqual({ startHistoryId: "105", labelId });
      return { historyId: "120", history: [] };
    },
  };
  const result = await reconcileGmailMailbox({ state, notification, client, now });
  expect(historyReads).toBe(1);
  expect(result.complete).toBe(true);
  expect(result.state.cursor.value).toBe("120");
  expect(result.observations.map((entry) => entry.eventType)).toEqual([
    "mail.subscription.degraded",
    "mail.subscription.recovered",
  ]);
});

test("bootstrap proves the OAuth mailbox identity before users.watch", async () => {
  let watchCalls = 0;
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/gmail/v1/users/me/profile")) {
      return new Response(JSON.stringify({ emailAddress: "other@example.com" }), { status: 200 });
    }
    if (url.includes("/gmail/v1/users/me/watch")) {
      watchCalls += 1;
      return new Response(JSON.stringify({ historyId: "100", expiration: "1787382600000" }), {
        status: 200,
      });
    }
    throw new Error("unexpected provider URL");
  }) as typeof fetch;
  const gmail = new GmailMailboxApiClient({
    tokenProvider: { getAccessToken: async () => "access-token-value-1234567890" },
    topicName: topic,
    fetch: fakeFetch,
  });
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail,
    actions: { archiveMessagesWithLabels: async () => 0 } as unknown as GmailMailboxActionClient,
    intake: {
      get: async () => null,
      initialize: async () => {
        throw new Error("wrong mailbox must never initialize");
      },
    } as unknown as HostedMailboxIntakeService,
  });
  await expect(runtime.bootstrapOrCatchUp()).rejects.toMatchObject({ operation: "profile" });
  expect(watchCalls).toBe(0);
});

test("a degraded expired cursor rebaselines from watch plus complete label snapshot plus history", async () => {
  let snapshot: MailboxIntakeSnapshot | null = {
    state: degradedStateAt("100"),
    revision: 2,
  };
  let committedObservations: readonly MailboxObservation[] = [];
  const gmail = {
    verifyMailboxAddress: async (address: string) => expect(address).toBe(mailbox),
    renewWatch: async () => ({
      historyId: "120",
      expiration: String(Date.parse("2026-08-22T07:10:00.000Z")),
    }),
    listLabelMessages: async () => [
      { id: "snapshot-message", threadId: "snapshot-thread" },
      { id: "self-echo-message", threadId: "self-echo-thread" },
    ],
    listHistory: async () => ({
      historyId: "121",
      history: [{
        id: "121",
        labelsAdded: [{
          message: { id: "history-message", threadId: "history-thread" },
          labelIds: [labelId],
        }],
      }],
    }),
  } as unknown as GmailMailboxApiClient;
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail,
    actions: { archiveMessagesWithLabels: async () => 0 } as unknown as GmailMailboxActionClient,
    intake: {
      get: async () => snapshot,
      commit: async (input: {
        nextState: MailboxSubscriptionState;
        observations: readonly MailboxObservation[];
      }) => {
        committedObservations = input.observations;
        snapshot = { state: input.nextState, revision: 3 };
        return snapshot;
      },
    } as unknown as HostedMailboxIntakeService,
    knownOutboundProviderMessageIds: async () => new Set(["self-echo-message"]),
    now: () => "2026-08-15T07:10:30.000Z",
  });
  const result = await runtime.bootstrapOrCatchUp();
  expect(result).toMatchObject({
    cursor: "121",
    revision: 3,
    materialObservations: 2,
    recoveryAction: null,
  });
  expect(snapshot?.state.coverage).toBe("continuous");
  expect(snapshot?.state.subscription.health).toBe("healthy");
  expect(committedObservations.filter((entry) => entry.providerMessageId === "snapshot-message"))
    .toHaveLength(1);
  expect(committedObservations.find((entry) => entry.providerMessageId === "self-echo-message"))
    .toMatchObject({ wakeEligible: false, loopDisposition: "self_echo" });
  expect(committedObservations.find((entry) => entry.providerMessageId === "history-message"))
    .toMatchObject({ wakeEligible: true, loopDisposition: "ordinary" });
});

test("partial full-sync failure leaves the old degraded cursor untouched", async () => {
  const original = { state: degradedStateAt("100"), revision: 2 };
  let commitCalls = 0;
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail: {
      verifyMailboxAddress: async () => {},
      renewWatch: async () => ({
        historyId: "120",
        expiration: String(Date.parse("2026-08-22T07:10:00.000Z")),
      }),
      listLabelMessages: async () => {
        throw new Error("partial snapshot");
      },
    } as unknown as GmailMailboxApiClient,
    actions: { archiveMessagesWithLabels: async () => 0 } as unknown as GmailMailboxActionClient,
    intake: {
      get: async () => original,
      commit: async () => {
        commitCalls += 1;
        throw new Error("must not commit");
      },
    } as unknown as HostedMailboxIntakeService,
    now: () => "2026-08-15T07:10:30.000Z",
  });
  await expect(runtime.bootstrapOrCatchUp()).rejects.toThrow("partial snapshot");
  expect(commitCalls).toBe(0);
  expect(original.state.cursor.value).toBe("100");
  expect(original.state.coverage).toBe("unknown");
});

function stateAt(cursor: string, lastNotificationId: string | null): MailboxSubscriptionState {
  return {
    version: 1,
    mailboxBindingId: bindingId,
    provider: "gmail",
    scope: { kind: "label", externalId: labelId },
    cursor: { kind: "gmail_history_id", value: cursor },
    coverage: "continuous",
    subscription: {
      externalId: subscription,
      expiresAt: "2026-08-22T07:10:00.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId,
    lastSuccessfulReconciliationAt: "2026-08-15T07:10:00.000Z",
  };
}

function degradedStateAt(cursor: string): MailboxSubscriptionState {
  return {
    ...stateAt(cursor, null),
    coverage: "unknown",
    subscription: {
      ...stateAt(cursor, null).subscription,
      health: "degraded",
      recoveryReason: "history_cursor_expired",
    },
  };
}

function pubsubEnvelope(historyId: string): unknown {
  return {
    subscription,
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: mailbox, historyId }), "utf8")
        .toString("base64url"),
      messageId: `pubsub-${historyId}`,
      publishTime: "2026-08-15T07:10:15.000Z",
    },
  };
}
