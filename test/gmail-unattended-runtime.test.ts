import { expect, test } from "bun:test";
import type { GmailMailboxActionClient } from "../src/gmail-mailbox-actions.ts";
import type { GmailMailboxApiClient } from "../src/gmail-mailbox-api.ts";
import { GmailUnattendedRuntime } from "../src/gmail-unattended-runtime.ts";
import type {
  DurableMailboxObservationProjection,
  HostedMailboxIntakeService,
  MailboxIntakeSnapshot,
} from "../src/mailbox-intake-convex-service.ts";
import type { MailboxObservation, MailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";

const mailbox = "leoli.4u@gmail.com";
const bindingId = "gmail_operator_primary";
const labelId = "Label_5";
const subscription = "projects/example/subscriptions/stensibly-gmail-handoffs";

test("bootstraps users.watch, durably admits material push, and sweeps Label_5 out of Inbox", async () => {
  let snapshot: MailboxIntakeSnapshot | null = null;
  let listHistoryCalls = 0;
  let committedObservations: readonly MailboxObservation[] = [];
  const hygieneLabels: string[][] = [];
  const hygieneResults = [0, 1];
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
    commit: async (input: { nextState: MailboxSubscriptionState; observations: readonly MailboxObservation[] }) => {
      committedObservations = input.observations;
      snapshot = { state: input.nextState, revision: (snapshot?.revision ?? 0) + 1 };
      return snapshot;
    },
    listRecentMaterialObservations: async () => committedObservations
      .filter((entry) => entry.wakeEligible && entry.loopDisposition === "ordinary")
      .map(projectObservation),
  } as unknown as HostedMailboxIntakeService;
  const actions = {
    archiveMessagesWithLabels: async (labels: readonly string[]) => {
      hygieneLabels.push([...labels]);
      return hygieneResults.shift() ?? 0;
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
  });

  const bootstrapped = await runtime.bootstrapOrCatchUp();
  expect(bootstrapped).toMatchObject({
    revision: 1,
    cursor: "100",
    admittedObservations: 0,
    archivedMessages: 0,
  });

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
  expect(hygieneLabels).toEqual([
    [labelId, "INBOX"],
    [labelId, "INBOX"],
  ]);

  const durableMaterial = await runtime.listRecentMaterialObservations();
  expect(durableMaterial).toHaveLength(1);
  expect(durableMaterial[0]).toMatchObject({
    providerMessageId: "gmail-message-1",
    wakeEligible: true,
    loopDisposition: "ordinary",
    containsRawContent: false,
    grantsAuthority: false,
  });
});

test("a duplicate PubSub retry still repairs quiet Inbox state after cursor advancement", async () => {
  let snapshot: MailboxIntakeSnapshot | null = {
    state: stateAt("101", "pubsub-101"),
    revision: 2,
  };
  let historyCalls = 0;
  let hygieneCalls = 0;
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail: {
      renewWatch: async () => {
        throw new Error("watch renewal should stay quiet");
      },
      listHistory: async () => {
        historyCalls += 1;
        throw new Error("covered duplicate must not read history");
      },
    } as unknown as GmailMailboxApiClient,
    actions: {
      archiveMessagesWithLabels: async (labels: readonly string[]) => {
        expect(labels).toEqual([labelId, "INBOX"]);
        hygieneCalls += 1;
        return 1;
      },
    } as unknown as GmailMailboxActionClient,
    intake: {
      get: async () => snapshot,
      commit: async (input: { nextState: MailboxSubscriptionState }) => {
        snapshot = { state: input.nextState, revision: 3 };
        return snapshot;
      },
    } as unknown as HostedMailboxIntakeService,
    now: () => "2026-08-15T06:46:00.000Z",
  });

  const result = await runtime.receivePubSubEnvelope(pubsubEnvelope("101"));
  expect(result).toMatchObject({
    duplicate: true,
    revision: 2,
    cursor: "101",
    admittedObservations: 0,
    archivedMessages: 1,
  });
  expect(historyCalls).toBe(0);
  expect(hygieneCalls).toBe(1);
});

test("deletion-only history remains non-material while hygiene stays label-scoped", async () => {
  const state = stateAt("100");
  let snapshot: MailboxIntakeSnapshot | null = { state, revision: 1 };
  const hygieneLabels: string[][] = [];
  const gmail = {
    renewWatch: async () => ({
      historyId: "100",
      expiration: String(Date.parse("2026-08-22T06:45:00.000Z")),
    }),
    listHistory: async () => ({
      historyId: "101",
      history: [{
        id: "101",
        messagesDeleted: [{
          message: { id: "deleted-message", threadId: "thread-a", labelIds: [labelId] },
        }],
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
    actions: {
      archiveMessagesWithLabels: async (labels: readonly string[]) => {
        hygieneLabels.push([...labels]);
        return 0;
      },
    } as unknown as GmailMailboxActionClient,
    intake,
    now: () => "2026-08-15T06:46:00.000Z",
  });
  const result = await runtime.receivePubSubEnvelope(pubsubEnvelope("101"));
  expect(result).toMatchObject({ materialObservations: 0, archivedMessages: 0 });
  expect(hygieneLabels).toEqual([[labelId, "INBOX"]]);
});

function projectObservation(observation: MailboxObservation): DurableMailboxObservationProjection {
  return {
    observationId: observation.observationId,
    semanticFingerprint: observation.semanticFingerprint,
    provider: observation.provider,
    eventType: observation.eventType,
    providerCursor: observation.providerCursor,
    providerMessageId: observation.providerMessageId,
    providerThreadId: observation.providerThreadId,
    providerScopeId: observation.providerScopeId,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    wakeEligible: observation.wakeEligible,
    loopDisposition: observation.loopDisposition,
    containsRawContent: false,
    grantsAuthority: false,
  };
}

function stateAt(
  cursor: string,
  lastNotificationId: string | null = null,
): MailboxSubscriptionState {
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
    lastNotificationId,
    lastSuccessfulReconciliationAt: "2026-08-15T06:45:00.000Z",
  };
}

function pubsubEnvelope(historyId: string): unknown {
  const data = Buffer.from(
    JSON.stringify({ emailAddress: mailbox, historyId }),
    "utf8",
  ).toString("base64url");
  return {
    subscription,
    message: {
      data,
      messageId: `pubsub-${historyId}`,
      publishTime: "2026-08-15T06:45:30.000Z",
    },
  };
}
