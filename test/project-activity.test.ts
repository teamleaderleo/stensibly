import { describe, expect, test } from "bun:test";
import { compileCorrespondenceThreadProjection } from "../src/correspondence-projection.ts";
import { createMailboxSubscriptionState } from "../src/mailbox-intake-contract.ts";
import { createMailThreadRecord } from "../src/mail-thread-contract.ts";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservation,
} from "../src/orchestrator-activity-observation.ts";
import { compileProjectActivityV1 } from "../src/project-activity.ts";

const asOf = "2026-08-16T06:00:00.000Z";

function correspondence() {
  const thread = createMailThreadRecord({
    threadId: "mail_thread_project_activity",
    handle: "STN-HANDOFF:PACT",
    workspace: "default",
    project: "stensibly",
    threadClass: "handoff",
    canonicalSubject: "Continue project activity",
    sourceIdentity: "github:teamleaderleo/stensibly#1586",
    resolutionCondition: "Compile the first project activity projection.",
    createdAt: "2026-08-16T04:00:00.000Z",
  });
  return compileCorrespondenceThreadProjection({
    thread: Object.freeze({ ...thread, updatedAt: "2026-08-16T05:00:00.000Z" }),
    providerProjection: {
      version: 1,
      threadId: thread.threadId,
      provider: "gmail",
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@gmail.invalid",
      providerThreadId: "gmail_thread_activity",
      rootProviderMessageId: "gmail_message_root",
      latestProviderMessageId: "gmail_message_latest",
      rootRfcMessageId: null,
      latestRfcMessageId: null,
      latestSentFingerprint: `sha256:${"a".repeat(64)}`,
      lastVerifiedSubject: "Continue project activity",
      lastVerifiedReferences: [],
      verifiedAt: "2026-08-16T05:00:00.000Z",
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
      lastSuccessfulReconciliationAt: "2026-08-16T05:00:00.000Z",
    }),
    humanAttention: "none",
    attribution: { actor: "actor_mail", callsign: "Keel", runId: "run_mail" },
    materialPreview: {
      current: "Correspondence read is live.",
      nextOrResolutionCondition: "Show it beside automatic work evidence.",
    },
    stages: [{
      stageId: "stage:mail_observed",
      kind: "mailbox_observed",
      happenedAt: "2026-08-16T04:59:00.000Z",
      evidenceRef: "mail_observation:observation_activity",
      causalPredecessorStageId: null,
    }],
    joins: [],
    truncated: false,
    asOf,
  });
}

function observation(
  overrides: Partial<Parameters<typeof compileOrchestratorActivityObservation>[0]> = {},
): OrchestratorActivityObservation {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_worker",
    sourceClass: "ledger_event",
    sourceId: "event_work_started",
    sourceFingerprint: `sha256:${"b".repeat(64)}`,
    observedAt: "2026-08-16T05:05:00.000Z",
    activityClass: "work_started",
    activityState: "in_progress",
    workItemId: "item_1586",
    attemptId: "attempt_1",
    runId: "run_1",
    relatedEvidenceIds: ["event_parent"],
    ...overrides,
  });
}

describe("project activity projection", () => {
  test("composes correspondence and automatic activity in material time order", () => {
    const projection = compileProjectActivityV1({
      project: "stensibly",
      asOf,
      correspondence: [correspondence()],
      orchestrator: [observation()],
      correspondenceTruncated: false,
      orchestratorTruncated: false,
    });

    expect(projection.version).toBe("project-activity/v1");
    expect(projection.entries.map((entry) => entry.sourceClass)).toEqual([
      "orchestrator_activity",
      "correspondence",
    ]);
    expect(projection.entries[0]).toMatchObject({
      activityClass: "work_started",
      activityState: "in_progress",
      currentness: "unknown",
      actorId: "actor_worker",
      workItemId: "item_1586",
      runId: "run_1",
      summary: null,
    });
    expect(projection.entries[1]).toMatchObject({
      activityClass: "correspondence_changed",
      activityState: "active",
      currentness: "current",
      actorId: "actor_mail",
      callsign: "Keel",
      provider: "gmail",
      summary: "Correspondence read is live.",
    });
    expect(projection.entries.every((entry) => entry.authorizesMutation === false)).toBe(true);
    expect(projection.grantsAuthority).toBe(false);
  });

  test("retains only explicit source causality and does not invent a cross-source relation", () => {
    const parent = observation({
      sourceId: "event_parent_source",
      sourceFingerprint: `sha256:${"c".repeat(64)}`,
      observedAt: "2026-08-16T05:01:00.000Z",
    });
    const child = observation({
      sourceId: "event_child_source",
      sourceFingerprint: `sha256:${"d".repeat(64)}`,
      observedAt: "2026-08-16T05:02:00.000Z",
      causalPredecessorId: parent.observationId,
    });
    const projection = compileProjectActivityV1({
      project: "stensibly",
      asOf,
      correspondence: [correspondence()],
      orchestrator: [parent, child],
      correspondenceTruncated: false,
      orchestratorTruncated: false,
    });

    const childEntry = projection.entries.find((entry) => entry.sourceId === child.observationId);
    const mailEntry = projection.entries.find((entry) => entry.sourceClass === "correspondence");
    expect(childEntry?.causalPredecessorSourceId).toBe(parent.observationId);
    expect(mailEntry?.causalPredecessorSourceId).toBeNull();
  });

  test("keeps source incompleteness and output omission explicit", () => {
    const projection = compileProjectActivityV1({
      project: "stensibly",
      asOf,
      correspondence: [correspondence()],
      orchestrator: [observation()],
      correspondenceTruncated: true,
      orchestratorTruncated: true,
      limit: 1,
    });
    expect(projection.entries).toHaveLength(1);
    expect(projection.completeness).toEqual({
      correspondenceTruncated: true,
      orchestratorTruncated: true,
      omittedEntryCount: 1,
    });
  });

  test("does not call fresh automatic evidence current without a freshness contract", () => {
    const fresh = observation({
      activityState: "succeeded",
      activityClass: "completed",
      observedAt: "2026-08-16T05:59:59.000Z",
    });
    const stale = observation({
      sourceId: "event_stale",
      sourceFingerprint: `sha256:${"e".repeat(64)}`,
      activityState: "stale",
      observedAt: "2026-08-16T05:50:00.000Z",
    });
    const projection = compileProjectActivityV1({
      project: "stensibly",
      asOf,
      correspondence: [],
      orchestrator: [fresh, stale],
      correspondenceTruncated: false,
      orchestratorTruncated: false,
    });
    expect(projection.entries.find((entry) => entry.sourceId === fresh.observationId)?.currentness)
      .toBe("unknown");
    expect(projection.entries.find((entry) => entry.sourceId === stale.observationId)?.currentness)
      .toBe("stale");
  });

  test("rejects project escape and changed source fingerprints", () => {
    expect(() => compileProjectActivityV1({
      project: "stensibly",
      asOf,
      correspondence: [],
      orchestrator: [observation({ project: "scrapbook" })],
      correspondenceTruncated: false,
      orchestratorTruncated: false,
    })).toThrow("escaped project scope");

    const mail = correspondence();
    expect(() => compileProjectActivityV1({
      project: "stensibly",
      asOf,
      correspondence: [{ ...mail, projectionFingerprint: `sha256:${"f".repeat(64)}` }],
      orchestrator: [],
      correspondenceTruncated: false,
      orchestratorTruncated: false,
    })).toThrow("fingerprint changed");

    const activity = observation();
    expect(() => compileProjectActivityV1({
      project: "stensibly",
      asOf,
      correspondence: [],
      orchestrator: [{ ...activity, observationFingerprint: `sha256:${"f".repeat(64)}` }],
      correspondenceTruncated: false,
      orchestratorTruncated: false,
    })).toThrow("bytes changed");
  });
});
