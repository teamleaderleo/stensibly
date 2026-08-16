import { describe, expect, test } from "bun:test";
import {
  compileCorrespondenceThreadProjection,
  type CompileCorrespondenceProjectionInput,
  type CorrespondenceJoin,
  type CorrespondenceStageEvidence,
} from "../src/correspondence-projection.ts";
import {
  createMailboxSubscriptionState,
  type MailboxProvider,
  type MailboxSubscriptionState,
} from "../src/mailbox-intake-contract.ts";
import {
  freezeMailProviderProjection,
  type MailProviderProjection,
} from "../src/mail-provider.ts";
import {
  createMailThreadRecord,
  updateMailThreadMaterial,
  type MailThreadRecord,
} from "../src/mail-thread-contract.ts";

const asOf = "2026-08-16T05:00:00.000Z";
const materialFingerprint = `sha256:${"a".repeat(64)}`;
const sentFingerprint = `sha256:${"b".repeat(64)}`;

function mailThread(): MailThreadRecord {
  return updateMailThreadMaterial(
    createMailThreadRecord({
      threadId: "mail-thread-1582",
      handle: "STN-HANDOFF:Q7MP",
      workspace: "primary",
      project: "stensibly",
      threadClass: "handoff",
      canonicalSubject: "Continue provider-neutral correspondence dogfood",
      sourceIdentity: "github:teamleaderleo/stensibly#1582",
      resolutionCondition: "The operator can reconstruct the attempt from durable evidence.",
      createdAt: "2026-08-16T03:00:00.000Z",
    }),
    {
      materialFingerprint,
      resolutionCondition: "The operator can reconstruct the attempt from durable evidence.",
      state: "open",
      updatedAt: "2026-08-16T04:30:00.000Z",
    },
  );
}

function providerProjection(
  provider: MailboxProvider,
  accountBinding: string,
): MailProviderProjection {
  return freezeMailProviderProjection({
    version: 1,
    threadId: "mail-thread-1582",
    provider,
    accountBinding,
    mailboxAddress: provider === "gmail" ? "agent@gmail.example" : "agent@outlook.example",
    providerThreadId: `${provider}-thread-1`,
    rootProviderMessageId: `${provider}-message-1`,
    latestProviderMessageId: `${provider}-message-2`,
    rootRfcMessageId: null,
    latestRfcMessageId: null,
    latestSentFingerprint: sentFingerprint,
    lastVerifiedSubject: "Continue provider-neutral correspondence dogfood",
    lastVerifiedReferences: [],
    verifiedAt: "2026-08-16T04:35:00.000Z",
  });
}

function mailboxState(
  provider: MailboxProvider,
  accountBinding: string,
  overrides: Partial<MailboxSubscriptionState> = {},
): MailboxSubscriptionState {
  const base = createMailboxSubscriptionState({
    mailboxBindingId: accountBinding,
    provider,
    scope: provider === "gmail"
      ? { kind: "label", externalId: "Label_5" }
      : { kind: "folder", externalId: "folder-5" },
    cursor: provider === "gmail"
      ? { kind: "gmail_history_id", value: "500" }
      : { kind: "outlook_delta_ref", value: "delta-ref-500" },
    coverage: "continuous",
    subscription: {
      externalId: `${provider}-subscription-1`,
      expiresAt: "2026-08-17T05:00:00.000Z",
      health: "healthy",
      recoveryReason: null,
    },
    lastNotificationId: `${provider}-notification-1`,
    lastSuccessfulReconciliationAt: "2026-08-16T04:45:00.000Z",
  });
  return createMailboxSubscriptionState({
    ...base,
    ...overrides,
    subscription: overrides.subscription ?? base.subscription,
  });
}

function stages(provider: MailboxProvider): readonly CorrespondenceStageEvidence[] {
  return [
    {
      stageId: "stage-3",
      kind: "provider_message_identified",
      happenedAt: "2026-08-16T04:05:00.000Z",
      evidenceRef: `${provider}:provider-message-2`,
      causalPredecessorStageId: "stage-2",
    },
    {
      stageId: "stage-1",
      kind: "outbound_reserved",
      happenedAt: "2026-08-16T04:00:00.000Z",
      evidenceRef: "mail:outbound-effect-1",
      causalPredecessorStageId: null,
    },
    {
      stageId: "stage-2",
      kind: "provider_send_accepted",
      happenedAt: "2026-08-16T04:02:00.000Z",
      evidenceRef: `${provider}:send-receipt-1`,
      causalPredecessorStageId: "stage-1",
    },
    {
      stageId: "stage-4",
      kind: "mailbox_observed",
      happenedAt: "2026-08-16T04:20:00.000Z",
      evidenceRef: `mail:${provider}:observation-1`,
      causalPredecessorStageId: null,
    },
    {
      stageId: "stage-5",
      kind: "semantic_admission_linked",
      happenedAt: "2026-08-16T04:25:00.000Z",
      evidenceRef: "mail:semantic-admission-1",
      causalPredecessorStageId: "stage-4",
    },
  ];
}

function joins(provider: MailboxProvider): readonly CorrespondenceJoin[] {
  return [
    {
      kind: "github_issue",
      ref: "github:teamleaderleo/stensibly#1582",
      url: "https://github.com/teamleaderleo/stensibly/issues/1582",
    },
    {
      kind: "stensibly_item",
      ref: "item:correspondence-1582",
      url: null,
    },
    {
      kind: "provider_thread",
      ref: `${provider}:thread-1`,
      url: provider === "gmail"
        ? "https://mail.google.com/mail/u/0/#all/thread-1"
        : "https://outlook.office.com/mail/thread-1",
    },
  ];
}

function input(provider: MailboxProvider): CompileCorrespondenceProjectionInput {
  const accountBinding = provider === "gmail" ? "gmail_operator_primary" : "outlook_operator_primary";
  return {
    thread: mailThread(),
    providerProjection: providerProjection(provider, accountBinding),
    mailboxState: mailboxState(provider, accountBinding),
    humanAttention: "none",
    attribution: {
      actor: "agent:keel",
      callsign: "Keel",
      runId: "run:correspondence-dogfood-1",
    },
    materialPreview: {
      current: "A bounded handoff was sent, observed by the provider intake, and linked to durable semantic evidence.",
      nextOrResolutionCondition: "Compare the provider thread with current Stensibly and GitHub evidence.",
    },
    stages: stages(provider),
    joins: joins(provider),
    truncated: false,
    asOf,
  };
}

describe("provider-neutral correspondence projection", () => {
  test("projects Gmail and Outlook behind the same correspondence semantics", () => {
    const gmail = compileCorrespondenceThreadProjection(input("gmail"));
    const outlook = compileCorrespondenceThreadProjection(input("outlook"));

    expect(gmail.provider).toBe("gmail");
    expect(outlook.provider).toBe("outlook");
    expect(gmail.title).toBe(outlook.title);
    expect(gmail.semanticClass).toBe("handoff");
    expect(outlook.semanticClass).toBe("handoff");
    expect(gmail.lifecycle).toBe("active");
    expect(outlook.lifecycle).toBe("active");
    expect(gmail.freshness.currentness).toBe("current");
    expect(outlook.freshness.currentness).toBe("current");
    expect(gmail.stages.map((stage) => stage.kind)).toEqual(
      outlook.stages.map((stage) => stage.kind),
    );
    expect(gmail.stages.map((stage) => stage.causalPredecessorStageId)).toEqual(
      outlook.stages.map((stage) => stage.causalPredecessorStageId),
    );
    expect(gmail.materialPreview).toEqual(outlook.materialPreview);
    expect(gmail.authorizesOperation).toBe(false);
    expect(gmail.authorizesMutation).toBe(false);
    expect(gmail.grantsAuthority).toBe(false);
    expect(gmail.containsRawMailBody).toBe(false);
    expect(gmail.attachmentsAdmitted).toBe(false);
  });

  test("sorts display chronology without inventing causal links", () => {
    const compiled = compileCorrespondenceThreadProjection({
      ...input("gmail"),
      stages: [
        {
          stageId: "later",
          kind: "mailbox_observed",
          happenedAt: "2026-08-16T04:20:00.000Z",
          evidenceRef: "mail:gmail:observation-later",
          causalPredecessorStageId: null,
        },
        {
          stageId: "earlier",
          kind: "provider_message_identified",
          happenedAt: "2026-08-16T04:05:00.000Z",
          evidenceRef: "gmail:message-earlier",
          causalPredecessorStageId: null,
        },
      ],
    });

    expect(compiled.stages.map((stage) => stage.stageId)).toEqual(["earlier", "later"]);
    expect(compiled.stages.map((stage) => stage.causalPredecessorStageId)).toEqual([null, null]);
  });

  test("requires every claimed causal predecessor to exist explicitly and rejects cycles", () => {
    expect(() => compileCorrespondenceThreadProjection({
      ...input("gmail"),
      stages: [{
        stageId: "stage-a",
        kind: "semantic_admission_linked",
        happenedAt: "2026-08-16T04:25:00.000Z",
        evidenceRef: "mail:semantic-a",
        causalPredecessorStageId: "missing-stage",
      }],
    })).toThrow("causal predecessor must name an explicit stage");

    expect(() => compileCorrespondenceThreadProjection({
      ...input("gmail"),
      stages: [
        {
          stageId: "stage-a",
          kind: "mailbox_observed",
          happenedAt: "2026-08-16T04:20:00.000Z",
          evidenceRef: "mail:observation-a",
          causalPredecessorStageId: "stage-b",
        },
        {
          stageId: "stage-b",
          kind: "semantic_admission_linked",
          happenedAt: "2026-08-16T04:25:00.000Z",
          evidenceRef: "mail:semantic-b",
          causalPredecessorStageId: "stage-a",
        },
      ],
    })).toThrow("causal stage graph contains a cycle");
  });

  test("makes current, partial, stale, and unknown freshness visible", () => {
    const base = input("gmail");
    expect(compileCorrespondenceThreadProjection(base).freshness.currentness).toBe("current");

    expect(compileCorrespondenceThreadProjection({
      ...base,
      mailboxState: mailboxState("gmail", "gmail_operator_primary", {
        coverage: "unknown",
      }),
    }).freshness.currentness).toBe("partial");

    expect(compileCorrespondenceThreadProjection({
      ...base,
      mailboxState: mailboxState("gmail", "gmail_operator_primary", {
        lastSuccessfulReconciliationAt: "2026-08-16T01:00:00.000Z",
      }),
    }).freshness.currentness).toBe("stale");

    expect(compileCorrespondenceThreadProjection({
      ...base,
      mailboxState: mailboxState("gmail", "gmail_operator_primary", {
        lastSuccessfulReconciliationAt: null,
      }),
    }).freshness.currentness).toBe("unknown");

    expect(compileCorrespondenceThreadProjection({
      ...base,
      truncated: true,
    }).freshness.currentness).toBe("partial");
  });

  test("binds provider, mailbox, and mail-thread identities before projecting", () => {
    const base = input("gmail");
    expect(() => compileCorrespondenceThreadProjection({
      ...base,
      providerProjection: providerProjection("outlook", "gmail_operator_primary"),
    })).toThrow("provider identities do not match");

    expect(() => compileCorrespondenceThreadProjection({
      ...base,
      providerProjection: freezeMailProviderProjection({
        ...providerProjection("gmail", "gmail_operator_primary"),
        threadId: "another-thread",
      }),
    })).toThrow("belongs to another mail thread");
  });

  test("canonicalizes input ordering into one stable read-model fingerprint", () => {
    const base = input("gmail");
    const first = compileCorrespondenceThreadProjection(base);
    const second = compileCorrespondenceThreadProjection({
      ...base,
      stages: [...base.stages].reverse(),
      joins: [...base.joins].reverse(),
    });

    expect(second.stages).toEqual(first.stages);
    expect(second.joins).toEqual(first.joins);
    expect(second.projectionFingerprint).toBe(first.projectionFingerprint);
  });

  test("rejects terminal attention contradictions and unsafe cross-surface links", () => {
    const resolvedThread = updateMailThreadMaterial(mailThread(), {
      materialFingerprint: `sha256:${"c".repeat(64)}`,
      resolutionCondition: "The handoff is complete.",
      state: "resolved",
      updatedAt: "2026-08-16T04:40:00.000Z",
    });

    expect(() => compileCorrespondenceThreadProjection({
      ...input("gmail"),
      thread: resolvedThread,
      humanAttention: "required",
    })).toThrow("Terminal correspondence cannot require current human attention");

    expect(() => compileCorrespondenceThreadProjection({
      ...input("gmail"),
      joins: [{
        kind: "github_issue",
        ref: "github:teamleaderleo/stensibly#1582",
        url: "http://github.com/teamleaderleo/stensibly/issues/1582",
      }],
    })).toThrow("Correspondence join URL is invalid");
  });
});
