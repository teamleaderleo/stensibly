import { expect, test } from "bun:test";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import { createMailThreadRecord } from "../src/mail-thread-contract.ts";
import {
  assembleProjectCorrespondenceV1,
  type ProjectCorrespondenceSourceV1,
} from "../src/project-correspondence.ts";

test("keeps provider-message chronology separate from effect causality", async () => {
  const thread = createMailThreadRecord({
    threadId: "mail_thread_causal_control",
    handle: "STN-HANDOFF:CAU2",
    workspace: "default",
    project: "stensibly",
    threadClass: "handoff",
    canonicalSubject: "Causality control",
    sourceIdentity: "github:teamleaderleo/stensibly#1588",
    resolutionCondition: "Bind effect to provider message only from exact evidence.",
    createdAt: "2026-08-16T04:00:00.000Z",
  });
  const source: ProjectCorrespondenceSourceV1 = {
    async listProject() {
      return {
        candidates: [{
          thread,
          providerProjection: {
            version: 1,
            threadId: thread.threadId,
            provider: "gmail",
            accountBinding: "gmail_operator_primary",
            mailboxAddress: "operator@gmail.invalid",
            providerThreadId: "gmail_thread_causal",
            rootProviderMessageId: "gmail_message_root",
            latestProviderMessageId: "gmail_message_latest",
            rootRfcMessageId: null,
            latestRfcMessageId: null,
            latestSentFingerprint: `sha256:${"a".repeat(64)}`,
            lastVerifiedSubject: "Causality control",
            lastVerifiedReferences: [],
            verifiedAt: "2026-08-16T04:31:00.000Z",
          },
          mailboxState: createMailboxSubscriptionState({
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
          }),
          effects: [{
            outboundEffectId: "effect_causal_control",
            state: "sent",
            reservedAt: "2026-08-16T04:30:00.000Z",
            settledAt: "2026-08-16T04:31:01.000Z",
          }],
          observations: [],
          truncated: false,
        }],
        threadsWithoutProviderProjection: 0,
        providerViewsWithoutMailboxState: 0,
        truncated: false,
      };
    },
  };

  const result = await assembleProjectCorrespondenceV1(source, {
    project: "stensibly",
    limit: 12,
    asOf: "2026-08-16T05:20:00.000Z",
  });
  const providerMessage = result.rows[0]?.stages.find(
    (stage) => stage.kind === "provider_message_identified",
  );
  const accepted = result.rows[0]?.stages.find(
    (stage) => stage.kind === "provider_send_accepted",
  );

  expect(accepted?.causalPredecessorStageId).toBeTruthy();
  expect(providerMessage?.causalPredecessorStageId).toBeNull();
});
