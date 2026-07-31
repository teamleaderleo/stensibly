import { describe, expect, test } from "bun:test";
import {
  admitAcceptedRepositoryInstructionSet,
  admitGitHubIssueContextAcceptanceSubject,
  admitGitHubIssueContextSnapshot,
  buildAcceptedRepositoryInstructionSet,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
  classifyGitHubIssueContextAcceptance,
} from "../src/github-project-context-admission.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const snapshot = () => buildGitHubIssueContext({
  owner: "TeamLeaderLeo",
  repository: "Stensibly",
  number: 747,
  title: "Rebuild hosted accepted GitHub context",
  body: "private issue body",
  state: "open",
  stateReason: null,
  labels: ["area:coordination", "triage:ready"],
  assignees: ["teamleaderleo"],
  milestone: { number: 12, title: "GitHub recovery" },
  relationships: [{
    kind: "parent",
    target: {
      owner: "teamleaderleo",
      repository: "stensibly",
      number: 492,
    },
  }],
  createdAt: "2026-07-31T14:58:08.000Z",
  updatedAt: "2026-07-31T16:03:53.000Z",
  providerNodeId: "I_kwDOThZq1s7c",
  sourceRevision: "github:issue:747:rev-1",
});

function instructionSet(revision = "main@f4312c8") {
  return buildAcceptedRepositoryInstructionSet({
    projectAttachmentId: "attach_current",
    projectAttachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    sources: [{
      path: "AGENTS.md",
      revision,
      contentSha256: `sha256:${"b".repeat(64)}`,
    }, {
      path: "STENSIBLY.md",
      revision,
      contentSha256: `sha256:${"c".repeat(64)}`,
    }],
  });
}

describe("accepted GitHub project context admission", () => {
  test("re-admits canonical content-minimised snapshots and instruction sets", () => {
    const issue = admitGitHubIssueContextSnapshot(snapshot());
    const instructions = admitAcceptedRepositoryInstructionSet(instructionSet());

    expect(issue.reference.externalId).toBe(
      "github:teamleaderleo/stensibly#747",
    );
    expect(issue.bodyRevision).toMatchObject({
      present: true,
      byteLength: 18,
    });
    expect((issue as unknown as Record<string, unknown>)).not.toHaveProperty("body");
    expect(instructions.sources.map((source) => source.path)).toEqual([
      "AGENTS.md",
      "STENSIBLY.md",
    ]);
    expect(Object.isFrozen(issue.relationships[0]?.target)).toBe(true);
    expect(Object.isFrozen(instructions.sources)).toBe(true);
    expect(canonicalGitHubIssueContextJson(issue)).toBe(
      canonicalGitHubIssueContextJson(snapshot()),
    );
    expect(canonicalRepositoryInstructionSetJson(instructions)).toBe(
      canonicalRepositoryInstructionSetJson(instructionSet()),
    );
  });

  test("rejects noncanonical accepted instruction order", () => {
    const unsorted = structuredClone(instructionSet());
    unsorted.sources.reverse();
    expect(() => admitAcceptedRepositoryInstructionSet(unsorted))
      .toThrow("sources must use canonical order");
  });

  test("rejects accessor, unknown nested, sparse, and noncanonical array input without getter execution", () => {
    let getterCalls = 0;
    const hostile = structuredClone(snapshot()) as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "milestone", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("secret getter prose");
      },
    });
    expect(() => admitGitHubIssueContextSnapshot(hostile)).toThrow();
    expect(getterCalls).toBe(0);

    const extraMilestone = structuredClone(snapshot()) as any;
    extraMilestone.milestone.secret = "private milestone prose";
    refingerprint(extraMilestone);
    expect(() => admitGitHubIssueContextSnapshot(extraMilestone))
      .toThrow("milestone has noncanonical fields");

    const sparse = structuredClone(snapshot()) as any;
    sparse.labels = [];
    sparse.labels.length = 1;
    expect(() => admitGitHubIssueContextSnapshot(sparse)).toThrow();

    const unsorted = structuredClone(snapshot()) as any;
    unsorted.labels = [...unsorted.labels].reverse();
    refingerprint(unsorted);
    expect(() => admitGitHubIssueContextSnapshot(unsorted))
      .toThrow("labels must use canonical order");
  });

  test("rejects self-consistent forged identities, private fields, and credential-shaped revisions", () => {
    const forged = structuredClone(snapshot()) as any;
    forged.reference.canonicalUrl =
      "https://github.com/other/repository/issues/747";
    refingerprint(forged);
    expect(() => admitGitHubIssueContextSnapshot(forged))
      .toThrow("identity is not canonical");

    const rawBody = structuredClone(snapshot()) as any;
    rawBody.body = "private issue body";
    refingerprint(rawBody);
    expect(() => admitGitHubIssueContextSnapshot(rawBody))
      .toThrow("snapshot has noncanonical fields");

    const secretRevision = structuredClone(snapshot()) as any;
    secretRevision.sourceRevision = "audit/secret://github/token";
    refingerprint(secretRevision);
    expect(() => admitGitHubIssueContextSnapshot(secretRevision))
      .toThrow("source revision cannot be credential-shaped");
  });

  test("checks observation staleness before instruction rebound", () => {
    const issue = snapshot();
    const current = {
      sourceRevision: issue.sourceRevision,
      contentSha256: issue.contentSha256,
      providerUpdatedAt: issue.updatedAt,
      instructionSetId: instructionSet("old").id,
      observedAt: "2026-07-31T16:10:00.000Z",
    };

    expect(classifyGitHubIssueContextAcceptance(current, {
      snapshot: issue,
      instructionSetId: instructionSet("new").id,
      observedAt: "2026-07-31T16:09:59.000Z",
    })).toEqual({ outcome: "stale", isCurrent: false });

    expect(classifyGitHubIssueContextAcceptance(current, {
      snapshot: issue,
      instructionSetId: instructionSet("new").id,
      observedAt: "2026-07-31T16:10:01.000Z",
    })).toEqual({ outcome: "instruction_rebound", isCurrent: true });
  });

  test("rejects altered content under one source revision and classifies provider chronology", () => {
    const first = snapshot();
    const altered = buildGitHubIssueContext({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: 747,
      title: "Altered title",
      body: "private issue body",
      state: "open",
      labels: ["area:coordination", "triage:ready"],
      assignees: ["teamleaderleo"],
      milestone: { number: 12, title: "GitHub recovery" },
      relationships: [{
        kind: "parent",
        target: { owner: "teamleaderleo", repository: "stensibly", number: 492 },
      }],
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
      providerNodeId: first.providerNodeId,
      sourceRevision: first.sourceRevision,
    });
    const current = {
      sourceRevision: first.sourceRevision,
      contentSha256: first.contentSha256,
      providerUpdatedAt: first.updatedAt,
      instructionSetId: instructionSet().id,
      observedAt: "2026-07-31T16:10:00.000Z",
    };
    expect(() => classifyGitHubIssueContextAcceptance(current, {
      snapshot: altered,
      instructionSetId: instructionSet().id,
      observedAt: "2026-07-31T16:11:00.000Z",
    })).toThrow("reused with altered content");

    const staleRevision = buildGitHubIssueContext({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: 747,
      title: first.title,
      body: "private issue body",
      state: "open",
      labels: ["area:coordination", "triage:ready"],
      assignees: ["teamleaderleo"],
      milestone: { number: 12, title: "GitHub recovery" },
      relationships: [{
        kind: "parent",
        target: { owner: "teamleaderleo", repository: "stensibly", number: 492 },
      }],
      createdAt: first.createdAt,
      updatedAt: "2026-07-31T16:03:52.000Z",
      providerNodeId: first.providerNodeId,
      sourceRevision: "github:issue:747:rev-2",
    });
    expect(classifyGitHubIssueContextAcceptance(current, {
      snapshot: staleRevision,
      instructionSetId: instructionSet().id,
      observedAt: "2026-07-31T16:11:00.000Z",
    })).toEqual({ outcome: "stale", isCurrent: false });
  });

  test("admits one complete acceptance subject and rejects inconsistent synchronization", () => {
    const accepted = admitGitHubIssueContextAcceptanceSubject({
      snapshot: snapshot(),
      instructionSet: instructionSet(),
      syncStatus: "degraded",
      syncCursor: "github:cursor:747",
      degradedReasonCode: "missed_delivery",
      observationRef: "github:delivery:747",
      observedAt: "2026-07-31T16:10:00.000Z",
      acceptedBy: "quill",
    });
    expect(accepted).toMatchObject({
      syncStatus: "degraded",
      degradedReasonCode: "missed_delivery",
      observationRef: "github:delivery:747",
    });

    expect(() => admitGitHubIssueContextAcceptanceSubject({
      ...accepted,
      syncStatus: "synchronized",
      degradedReasonCode: "missed_delivery",
    })).toThrow("cannot carry a degraded reason");
    expect(() => admitGitHubIssueContextAcceptanceSubject({
      ...accepted,
      observationRef: "audit/secret://github/token",
    })).toThrow("cannot be credential-shaped");
  });
});

function refingerprint(value: Record<string, any>): void {
  const {
    snapshotSha256: _snapshotSha256,
    contentSha256: _contentSha256,
    sourceRevision,
    ...content
  } = value;
  value.contentSha256 = fingerprintCanonicalRequest(content);
  value.snapshotSha256 = fingerprintCanonicalRequest({
    ...content,
    sourceRevision,
    contentSha256: value.contentSha256,
  });
}
