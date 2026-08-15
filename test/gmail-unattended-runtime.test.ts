import { expect, test } from "bun:test";
import type { GmailMailboxActionClient } from "../src/gmail-mailbox-actions.ts";
import type { GmailMailboxApiClient } from "../src/gmail-mailbox-api.ts";
import { GmailUnattendedRuntime } from "../src/gmail-unattended-runtime.ts";
import type { HostedMailboxIntakeService, MailboxIntakeSnapshot } from "../src/mailbox-intake-convex-service.ts";
import type { MailboxObservation, MailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";

const mailbox = "leoli.4u@gmail.com";
const bindingId = "gmail_operator_primary";
const labelId = "Label_5";
const subscription = "projects/example/subscriptions/stensibly-gmail-handoffs";

test("bootstraps users.watch, admits one push, then archives the reconciled handoff", async () => {
  let snapshot: MailboxIntakeSnapshot | null = null;
  let listHistoryCalls = 0;
  const archived: string[] = [];
  const material: MailboxObservation[] = [];
  const gmail = {
    renewWatch: async () => ({
      historyId: "100",
      expiration: String(Date.parse("2026-08-22T06:45:00.000Z")),
    }),
    listHistory: async () => {
      listHistoryCalls += 1;
      return {
        historyId: "101",
        history: [{
          id: "101",
          messagesAdded: [{
            message: { id: "gmail-message-1", threadId: "gmail-thread-1", labelIds: [labelId] },
          }],
        }],
      };
    },
  } as unknown as GmailMailboxApiClient;
  const intake = {
    get: async () => snapshot,
    initialize: async (state: MailboxSubscriptionState) => {
      snapshot = { state, revision: 1 };
      return snapshot;
    },
    commit: async (input: { nextState: MailboxSubscriptionState }) => {
      snapshot = { state: input.nextState, revision: (snapshot?.revision ?? 0) + 1 };
      return snapshot;
    },
  } as unknown as HostedMailboxIntakeService;
  const actions = {
    archiveMessage: async (messageId: string) => {
      archived.push(messageId);
    },
  } as unknown as GmailMailboxActionClient;
  let now = "2026-08-15T06:45:00.000Z";
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail,
    actions,
    intake,
    now: () => now,
    materialSink: {
      admitMaterialObservations: async (input) => {
        material.push(...input.observations);
        return { operatorAttentionMessageIds: new Set<string>() };
      },
    },
  });

  const bootstrapped = await runtime.bootstrapOrCatchUp();
  expect(bootstrapped).toMatchObject({ revision: 1, cursor: "100", admittedObservations: 0 });

  now = "2026-08-15T06:46:00.000Z";
  const pushed = await runtime.receivePubSubEnvelope(pubsubEnvelope("101"));
  expect(pushed).toMatchObject({
    revision: 2,
    cursor: "101",
    admittedObservations: 1,
    materialObservations: 1,
    archivedMessages: 1,
  });
  expect(listHistoryCalls).toBe(1);
  expect(material.map((entry) => entry.providerMessageId)).toEqual(["gmail-message-1"]);
  expect(archived).toEqual(["gmail-message-1"]);
});

test("keeps an exact message in Inbox only when material policy marks operator attention", async () => {
  const state = stateAt("100");
  let snapshot: MailboxIntakeSnapshot | null = { state, revision: 1 };
  const archived: string[] = [];
  const gmail = {
    renewWatch: async () => ({ historyId: "100", expiration: String(Date.parse("2026-08-22T06:45:00.000Z")) }),
    listHistory: async () => ({
      historyId: "101",
      history: [{
        id: "101",
        messagesAdded: [{ message: { id: "attention-message", threadId: "thread-a", labelIds: [labelId] } }],
      }],
    }),
  } as unknown as GmailMailboxApiClient;
  const intake = {
    get: async () => snapshot,
    commit: async (input: { nextState: MailboxSubscriptionState }) => {
      snapshot = { state: input.nextState, revision: 2 };
      return snapshot;
    },
  } as unknown as HostedMailboxIntakeService;
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail,
    actions: { archiveMessage: async (id: string) => archived.push(id) } as unknown as GmailMailboxActionClient,
    intake,
    now: () => "2026-08-15T06:46:00.000Z",
    materialSink: {
      admitMaterialObservations: async () => ({
        operatorAttentionMessageIds: new Set(["attention-message"]),
      }),
    },
  });
  const result = await runtime.receivePubSubEnvelope(pubsubEnvelope("101"));
  expect(result.archivedMessages).toBe(0);
  expect(archived).toEqual([]);
});

function stateAt(cursor: string): MailboxSubscriptionState {
  return {
    version: 1,
    mailboxBindingId: bindingId,
    provider: "gmail",
    scope: { kind: "label", externalId: labelId },
    cursor: { kind: "gmail_history_id", value: cursor },
    coverage: "continuous",
    subscription: {
      externalId: subscription,
      expiresAt: "2026-08-22T06:45:00.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: null,
    lastSuccessfulReconciliationAt: "2026-08-15T06:45:00.000Z",
  };
}

function pubsubEnvelope(historyId: string): unknown {
  const data = Buffer.from(JSON.stringify({ emailAddress: mailbox, historyId }), "utf8").toString("base64url");
  return {
    subscription,
    message: {
      data,
      messageId: `pubsub-${historyId}`,
      publishTime: "2026-08-15T06:45:30.000Z",
    },
  };
}
