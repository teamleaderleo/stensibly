import { expect, test } from "bun:test";
import type { GmailMailboxActionClient } from "../src/gmail-mailbox-actions.ts";
import type { GmailMailboxApiClient } from "../src/gmail-mailbox-api.ts";
import { GmailUnattendedRuntime } from "../src/gmail-unattended-runtime.ts";
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

test("first bootstrap snapshots pre-existing watched mail before claiming continuous coverage", async () => {
  let snapshot: MailboxIntakeSnapshot | null = null;
  let snapshotReads = 0;
  let historyReads = 0;
  let committedObservations: readonly MailboxObservation[] = [];

  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: mailbox,
    mailboxBindingId: bindingId,
    labelId,
    pubsubSubscription: subscription,
    gmail: {
      verifyMailboxAddress: async (address: string) => expect(address).toBe(mailbox),
      renewWatch: async () => ({
        historyId: "100",
        expiration: String(Date.parse("2026-08-22T07:10:00.000Z")),
      }),
      listLabelMessages: async () => {
        snapshotReads += 1;
        return [{ id: "preexisting-message", threadId: "preexisting-thread" }];
      },
      listHistory: async (request: { startHistoryId: string; labelId: string }) => {
        historyReads += 1;
        expect(request).toEqual({ startHistoryId: "100", labelId });
        return { historyId: "100", history: [] };
      },
    } as unknown as GmailMailboxApiClient,
    actions: {
      archiveMessagesWithLabels: async (labels: readonly string[]) => {
        expect(labels).toEqual([labelId, "INBOX"]);
        return 1;
      },
    } as unknown as GmailMailboxActionClient,
    intake: {
      get: async () => snapshot,
      initialize: async (state: MailboxSubscriptionState) => {
        snapshot = { state, revision: 1 };
        return snapshot;
      },
      commit: async (input: {
        nextState: MailboxSubscriptionState;
        observations: readonly MailboxObservation[];
      }) => {
        committedObservations = input.observations;
        snapshot = { state: input.nextState, revision: (snapshot?.revision ?? 0) + 1 };
        return snapshot;
      },
    } as unknown as HostedMailboxIntakeService,
    knownOutboundProviderMessageIds: async () => new Set<string>(),
    now: () => "2026-08-15T07:10:30.000Z",
  });

  const result = await runtime.bootstrapOrCatchUp();

  expect(snapshotReads).toBe(1);
  expect(historyReads).toBe(1);
  expect(result.cursor).toBe("100");
  expect(result.materialObservations).toBe(1);
  expect(result.archivedMessages).toBe(1);
  if (committedObservations.length > 0) {
    expect(committedObservations.find((entry) => entry.providerMessageId === "preexisting-message"))
      .toMatchObject({ wakeEligible: true, loopDisposition: "ordinary" });
  }
});
