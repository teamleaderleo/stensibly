import { expect, test } from "bun:test";
import { GmailMailboxApiClient } from "../src/gmail-mailbox-api.ts";
import { GmailUnattendedRuntime } from "../src/gmail-unattended-runtime.ts";
import { GoogleOAuthRefreshTokenProvider } from "../src/google-oauth-refresh-token.ts";
import type { GmailMailboxActionClient } from "../src/gmail-mailbox-actions.ts";
import type {
  HostedMailboxIntakeService,
  MailboxIntakeSnapshot,
} from "../src/mailbox-intake-convex-service.ts";
import type { MailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";

const mailbox = "leoli.4u@gmail.com";
const bindingId = "gmail_operator_primary";
const labelId = "Label_5";
const subscription = "projects/example/subscriptions/stensibly-gmail-handoffs";

test("Gmail 401 invalidates the cached access token before the next unattended retry", async () => {
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
    throw new Error(`unexpected provider URL: ${url}`);
  }) as typeof fetch;

  const tokens = new GoogleOAuthRefreshTokenProvider({
    clientId: "client-id",
    clientSecret: "protected-client-secret",
    refreshToken: "protected-refresh-token",
    fetch: fakeFetch,
    now: () => Date.parse("2026-08-15T07:10:00.000Z"),
  });
  const gmail = new GmailMailboxApiClient({
    tokenProvider: tokens,
    topicName: "projects/example/topics/stensibly-gmail-handoffs",
    fetch: fakeFetch,
  });

  await expect(gmail.listHistory({ startHistoryId: "100", labelId }))
    .rejects.toMatchObject({ status: 401 });

  const recovered = await gmail.listHistory({ startHistoryId: "100", labelId });
  expect(recovered.historyId).toBe("101");
  expect(oauthCalls).toBe(2);
  expect(gmailCalls).toBe(2);
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
