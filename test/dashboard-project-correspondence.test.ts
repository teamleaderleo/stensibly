import { describe, expect, test } from "bun:test";
import {
  normalizeCorrespondenceProjects,
  readProjectCorrespondence,
} from "../site/project-correspondence.js";

function payload() {
  return {
    correspondence: {
      version: "project-correspondence/v1",
      project: "stensibly",
      asOf: "2026-08-16T05:20:00.000Z",
      rows: [{
        version: "correspondence-projection/v1",
        projectionFingerprint: `sha256:${"a".repeat(64)}`,
        threadId: "mail_thread_gmail",
        handle: "STN-HANDOFF:GMA2",
        workspace: "default",
        project: "stensibly",
        title: "Continue correspondence dogfood",
        semanticClass: "handoff",
        sourceThreadState: "open",
        lifecycle: "active",
        humanAttention: "none",
        provider: "gmail",
        accountBinding: "gmail_operator_primary",
        providerThreadId: "gmail_thread_1",
        latestProviderMessageId: "gmail_message_latest",
        newestMaterialAt: "2026-08-16T05:00:00.000Z",
        freshness: {
          coverage: "continuous",
          subscriptionHealth: "healthy",
          lastSuccessfulReconciliationAt: "2026-08-16T05:10:00.000Z",
          truncated: false,
          currentness: "current",
        },
        attribution: { actor: null, callsign: null, runId: null },
        materialPreview: {
          current: "Active: Continue correspondence dogfood.",
          nextOrResolutionCondition: "Render one authenticated project read.",
        },
        stages: [{
          stageId: "stage:effect_reserved",
          kind: "outbound_reserved",
          happenedAt: "2026-08-16T04:30:00.000Z",
          evidenceRef: "mail_effect:effect_gmail",
          causalPredecessorStageId: null,
        }, {
          stageId: "stage:effect_sent",
          kind: "provider_send_accepted",
          happenedAt: "2026-08-16T04:31:00.000Z",
          evidenceRef: "mail_effect:effect_gmail",
          causalPredecessorStageId: "stage:effect_reserved",
        }, {
          stageId: "stage:provider_message",
          kind: "provider_message_identified",
          happenedAt: "2026-08-16T04:31:00.000Z",
          evidenceRef: "provider_message:gmail_message_latest",
          causalPredecessorStageId: null,
        }],
        joins: [],
        containsRawMailBody: false,
        containsQuotedMailBody: false,
        attachmentsAdmitted: false,
        authorizesOperation: false,
        authorizesMutation: false,
        grantsAuthority: false,
        grantsResponsibility: false,
        grantsApproval: false,
      }],
      completeness: {
        truncated: false,
        threadsWithoutProviderProjection: 0,
        providerViewsWithoutMailboxState: 0,
        rejectedCandidates: 0,
      },
      authorizesOperation: false,
      authorizesMutation: false,
      grantsAuthority: false,
      grantsResponsibility: false,
      grantsApproval: false,
    },
  };
}

describe("dashboard project correspondence contract", () => {
  test("projects bounded provider-neutral correspondence", () => {
    const correspondence = readProjectCorrespondence(payload(), "stensibly");
    expect(correspondence.project).toBe("stensibly");
    expect(correspondence.rows).toHaveLength(1);
    expect(correspondence.rows[0]).toMatchObject({
      provider: "gmail",
      handle: "STN-HANDOFF:GMA2",
      lifecycle: "active",
      freshness: { currentness: "current" },
    });
    expect(correspondence.rows[0]?.stages[1]).toMatchObject({
      kind: "provider_send_accepted",
      causalPredecessorStageId: "stage:effect_reserved",
    });
    expect(correspondence.rows[0]?.stages[2]?.causalPredecessorStageId).toBeNull();
  });

  test("rejects authority drift, project escape, missing causality, and future evidence", () => {
    expect(() => readProjectCorrespondence({
      correspondence: { ...payload().correspondence, grantsAuthority: true },
    })).toThrow(/authority grant/);
    expect(() => readProjectCorrespondence({
      correspondence: {
        ...payload().correspondence,
        rows: [{ ...payload().correspondence.rows[0], project: "scrapbook" }],
      },
    }, "stensibly")).toThrow(/escaped the project boundary/);
    expect(() => readProjectCorrespondence({
      correspondence: {
        ...payload().correspondence,
        rows: [{
          ...payload().correspondence.rows[0],
          stages: [{
            ...payload().correspondence.rows[0]!.stages[0]!,
            causalPredecessorStageId: "stage:missing",
          }],
        }],
      },
    })).toThrow(/missing causal predecessor/);
    expect(() => readProjectCorrespondence({
      correspondence: {
        ...payload().correspondence,
        rows: [{ ...payload().correspondence.rows[0], newestMaterialAt: "2026-08-16T06:00:00.000Z" }],
      },
    })).toThrow(/after the response observation time/);
  });

  test("rejects credential-shaped retained fields and oversized lists", () => {
    expect(() => readProjectCorrespondence({
      correspondence: {
        ...payload().correspondence,
        rows: [{ ...payload().correspondence.rows[0], title: "Bearer abcdefghijklmnopqrstuvwxyz" }],
      },
    })).toThrow(/thread title/);
    expect(() => readProjectCorrespondence({
      correspondence: {
        ...payload().correspondence,
        rows: Array.from({ length: 51 }, () => payload().correspondence.rows[0]),
      },
    })).toThrow(/thread list/);
  });

  test("normalizes only safe project slugs", () => {
    expect(normalizeCorrespondenceProjects([
      " beta ",
      "alpha",
      "alpha",
      "Bad Project",
      "stn.tok_secret",
      null,
    ])).toEqual(["alpha", "beta"]);
  });
});
