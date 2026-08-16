import { expect, test } from "bun:test";
import { compileCorrespondenceThreadProjection } from "../src/correspondence-projection.ts";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import { createMailThreadRecord } from "../src/mail-thread-contract.ts";
import { compileOrchestratorActivityObservation } from "../src/orchestrator-activity-observation.ts";
import { compileProjectActivityV1 } from "../src/project-activity.ts";

const asOf = "2026-08-16T06:00:00.000Z";

function mail(handle: string, threadId: string, updatedAt: string) {
  const thread = createMailThreadRecord({
    threadId,
    handle,
    workspace: "default",
    project: "stensibly",
    threadClass: "handoff",
    canonicalSubject: `Continue ${threadId}`,
    sourceIdentity: `github:teamleaderleo/stensibly#${threadId}`,
    resolutionCondition: "Continue the accepted project activity lane.",
    createdAt: "2026-08-16T04:00:00.000Z",
  });
  return compileCorrespondenceThreadProjection({
    thread: Object.freeze({ ...thread, updatedAt }),
    providerProjection: {
      version: 1,
      threadId,
      provider: "gmail",
      accountBinding: `account_${threadId}`,
      mailboxAddress: `${threadId}@gmail.invalid`,
      providerThreadId: `provider_${threadId}`,
      rootProviderMessageId: `root_${threadId}`,
      latestProviderMessageId: `latest_${threadId}`,
      rootRfcMessageId: null,
      latestRfcMessageId: null,
      latestSentFingerprint: `sha256:${"a".repeat(64)}`,
      lastVerifiedSubject: `Continue ${threadId}`,
      lastVerifiedReferences: [],
      verifiedAt: updatedAt,
    },
    mailboxState: createMailboxSubscriptionState({
      mailboxBindingId: `account_${threadId}`,
      provider: "gmail",
      scope: { kind: "label", externalId: "Label_5" },
      cursor: { kind: "gmail_history_id", value: "105" },
      coverage: "continuous",
      subscription: {
        externalId: `subscription_${threadId}`,
        expiresAt: "2026-08-17T05:00:00.000Z",
        health: "healthy",
        recoveryReason: null,
      },
      lastNotificationId: null,
      lastSuccessfulReconciliationAt: updatedAt,
    }),
    humanAttention: "none",
    attribution: { actor: null, callsign: null, runId: null },
    materialPreview: {
      current: `Current ${threadId}.`,
      nextOrResolutionCondition: "Continue the accepted project activity lane.",
    },
    stages: [],
    joins: [],
    truncated: false,
    asOf,
  });
}

function activity(sourceId: string, observedAt: string) {
  const fingerprintCharacter = sourceId === "event_a" ? "b" : "c";
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: `actor_${sourceId}`,
    sourceClass: "ledger_event",
    sourceId,
    sourceFingerprint: `sha256:${fingerprintCharacter.repeat(64)}`,
    observedAt,
    activityClass: "progress_evidence",
    activityState: "in_progress",
  });
}

test("project activity output is invariant to input ordering", () => {
  const mailA = mail("STN-HANDOFF:PA22", "thread_a", "2026-08-16T05:10:00.000Z");
  const mailB = mail("STN-HANDOFF:PB22", "thread_b", "2026-08-16T05:20:00.000Z");
  const activityA = activity("event_a", "2026-08-16T05:15:00.000Z");
  const activityB = activity("event_b", "2026-08-16T05:25:00.000Z");
  const left = compileProjectActivityV1({
    project: "stensibly",
    asOf,
    correspondence: [mailA, mailB],
    orchestrator: [activityA, activityB],
    correspondenceTruncated: false,
    orchestratorTruncated: false,
  });
  const right = compileProjectActivityV1({
    project: "stensibly",
    asOf,
    correspondence: [mailB, mailA],
    orchestrator: [activityB, activityA],
    correspondenceTruncated: false,
    orchestratorTruncated: false,
  });
  expect(right).toEqual(left);
});

test("duplicate source entries reject instead of multiplying history", () => {
  const observation = activity("event_a", "2026-08-16T05:15:00.000Z");
  expect(() => compileProjectActivityV1({
    project: "stensibly",
    asOf,
    correspondence: [],
    orchestrator: [observation, observation],
    correspondenceTruncated: false,
    orchestratorTruncated: false,
  })).toThrow("entry identities must be unique");
});
