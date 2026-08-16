import { describe, expect, test } from "bun:test";
import { canonicalJsonString } from "../src/idempotency-request-fingerprint.ts";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import { createMailThreadRecord } from "../src/mail-thread-contract.ts";
import type { MailProviderProjection } from "../src/mail-provider.ts";
import { ConvexProjectCorrespondenceSource } from "../src/convex-project-correspondence-source.ts";

const thread = createMailThreadRecord({
  threadId: "mail_thread_gmail",
  handle: "STN-HANDOFF:GMA2",
  workspace: "default",
  project: "stensibly",
  threadClass: "handoff",
  canonicalSubject: "Continue correspondence dogfood",
  sourceIdentity: "github:teamleaderleo/stensibly#1582",
  resolutionCondition: "Render one authenticated project read.",
  createdAt: "2026-08-16T04:00:00.000Z",
});
const projection: MailProviderProjection = {
  version: 1,
  threadId: thread.threadId,
  provider: "gmail",
  accountBinding: "gmail_operator_primary",
  mailboxAddress: "operator@gmail.invalid",
  providerThreadId: "gmail_thread_1",
  rootProviderMessageId: "gmail_message_root",
  latestProviderMessageId: "gmail_message_latest",
  rootRfcMessageId: null,
  latestRfcMessageId: null,
  latestSentFingerprint: `sha256:${"a".repeat(64)}`,
  lastVerifiedSubject: "Continue correspondence dogfood",
  lastVerifiedReferences: [],
  verifiedAt: "2026-08-16T04:31:00.000Z",
};
const mailboxState = createMailboxSubscriptionState({
  mailboxBindingId: "gmail_operator_primary",
  provider: "gmail",
  scope: { kind: "label", externalId: "Label_5" },
  cursor: { kind: "gmail_history_id", value: "105" },
  coverage: "continuous",
  subscription: {
    externalId: "gmail_subscription",
    expiresAt: "2026-08-17T05:00:00.000Z",
    health: "healthy",
    recoveryReason: null,
  },
  lastNotificationId: null,
  lastSuccessfulReconciliationAt: "2026-08-16T04:32:00.000Z",
});

describe("Convex project correspondence source", () => {
  test("re-admits bounded hosted rows before exposing them to the compiler", async () => {
    const calls: Array<{ args: Record<string, unknown> }> = [];
    const source = new ConvexProjectCorrespondenceSource({
      serviceSecret: "service-secret",
      workspace: "default",
      client: {
        async query(_reference, args) {
          calls.push({ args });
          return {
            rows: [{
              threadJson: JSON.stringify(thread),
              projectionJson: JSON.stringify(projection),
              mailboxStateJson: canonicalJsonString(mailboxState),
              effects: [{
                outboundEffectId: "effect_gmail",
                state: "sent",
                reservedAt: Date.parse("2026-08-16T04:30:00.000Z"),
                settledAt: Date.parse("2026-08-16T04:31:00.000Z"),
              }],
              observations: [{
                observationId: "observation_gmail",
                eventType: "mail.message.created",
                providerMessageId: "gmail_message_latest",
                providerThreadId: "gmail_thread_1",
                observedAt: "2026-08-16T04:32:00.000Z",
              }],
              truncated: false,
            }],
            threadsWithoutProviderProjection: 2,
            providerViewsWithoutMailboxState: 1,
            truncated: true,
          };
        },
      },
    });

    const result = await source.listProject({
      project: "stensibly",
      limit: 12,
      asOf: "2026-08-16T05:20:00.000Z",
    });

    expect(calls).toEqual([{ args: {
      serviceSecret: "service-secret",
      workspace: "default",
      project: "stensibly",
      limit: 12,
    } }]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.thread.handle).toBe("STN-HANDOFF:GMA2");
    expect(result.candidates[0]?.effects[0]).toEqual({
      outboundEffectId: "effect_gmail",
      state: "sent",
      reservedAt: "2026-08-16T04:30:00.000Z",
      settledAt: "2026-08-16T04:31:00.000Z",
    });
    expect(result.candidates[0]?.mailboxState.provider).toBe("gmail");
    expect(result.threadsWithoutProviderProjection).toBe(2);
    expect(result.providerViewsWithoutMailboxState).toBe(1);
    expect(result.truncated).toBe(true);
  });

  test("rejects a hosted row outside the selected project", async () => {
    const source = new ConvexProjectCorrespondenceSource({
      serviceSecret: "service-secret",
      workspace: "default",
      client: {
        async query() {
          return {
            rows: [{
              threadJson: JSON.stringify({ ...thread, project: "scrapbook" }),
              projectionJson: JSON.stringify(projection),
              mailboxStateJson: canonicalJsonString(mailboxState),
              effects: [],
              observations: [],
              truncated: false,
            }],
            threadsWithoutProviderProjection: 0,
            providerViewsWithoutMailboxState: 0,
            truncated: false,
          };
        },
      },
    });

    await expect(source.listProject({
      project: "stensibly",
      limit: 12,
      asOf: "2026-08-16T05:20:00.000Z",
    })).rejects.toThrow("escaped scope");
  });
});
