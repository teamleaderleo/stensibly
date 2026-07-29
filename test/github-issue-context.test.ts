import { describe, expect, test } from "bun:test";
import {
  buildGitHubIssueContext,
  buildGitHubIssueReference,
  compareGitHubIssueContexts,
  parseGitHubIssueExternalId,
  type GitHubIssueContextInput,
} from "../src/github-issue-context.ts";

const baseInput: GitHubIssueContextInput = {
  owner: "TeamLeaderLeo",
  repository: "Stensibly",
  number: 403,
  title: "Render item activity as an attributable response thread",
  body: "First line.\r\n\r\nSecond line.",
  state: "open",
  stateReason: null,
  labels: ["triage:ready", "area:dashboard", "Ärea:accessibility"],
  assignees: ["TeamLeaderLeo", "Agent-Runner"],
  milestone: { number: 7, title: "Guarded dogfood" },
  relationships: [
    {
      kind: "blocked_by",
      target: { owner: "teamleaderleo", repository: "stensibly", number: 149 },
    },
    {
      kind: "related",
      target: { owner: "teamleaderleo", repository: "stensibly", number: 273 },
    },
  ],
  createdAt: "2026-07-28T10:51:49.000Z",
  updatedAt: "2026-07-29T11:30:00.000Z",
  providerNodeId: "I_kwDOexample",
  sourceRevision: "github-updated-20260729T113000Z",
};

function context(overrides: Partial<GitHubIssueContextInput> = {}) {
  return buildGitHubIssueContext({ ...baseInput, ...overrides });
}

describe("GitHub issue references", () => {
  test("builds and parses one canonical stable external identity", () => {
    const reference = buildGitHubIssueReference({
      owner: "TeamLeaderLeo",
      repository: "Stensibly",
      number: 403,
    });

    expect(reference).toEqual({
      provider: "github",
      host: "github.com",
      owner: "teamleaderleo",
      repository: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
      number: 403,
      externalId: "github:teamleaderleo/stensibly#403",
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/issues/403",
    });
    expect(parseGitHubIssueExternalId(reference.externalId)).toEqual(reference);
  });

  test("rejects ambiguous or non-canonical external identities", () => {
    const invalid = [
      "github:teamleaderleo/stensibly",
      "github:teamleaderleo/stensibly#0",
      "github:teamleaderleo/stensibly#-1",
      "github:https://github.com/teamleaderleo/stensibly#403",
      "gitlab:teamleaderleo/stensibly#403",
    ];
    for (const value of invalid) {
      expect(() => parseGitHubIssueExternalId(value)).toThrow(RangeError);
    }
  });
});

describe("GitHub issue context", () => {
  test("canonicalizes provider lists and explicit relationships with code-unit ordering", () => {
    const first = context();
    const second = context({
      labels: [...baseInput.labels!].reverse(),
      assignees: [...baseInput.assignees!].reverse(),
      relationships: [...baseInput.relationships!].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.labels).toEqual([
      "area:dashboard",
      "triage:ready",
      "Ärea:accessibility",
    ]);
    expect(first.assignees).toEqual(["agent-runner", "teamleaderleo"]);
    expect(first.relationships.map((entry) => `${entry.kind}:${entry.target.externalId}`)).toEqual([
      "blocked_by:github:teamleaderleo/stensibly#149",
      "related:github:teamleaderleo/stensibly#273",
    ]);
    expect(first.snapshotSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("normalizes body newlines, stores only bounded revision evidence, and distinguishes absent from empty", () => {
    const windows = context({ body: "alpha\r\n\r\nbeta" });
    const unix = context({ body: "alpha\n\nbeta" });
    const absent = context({ body: null });
    const empty = context({ body: "" });

    expect(windows.bodyRevision).toEqual(unix.bodyRevision);
    expect(windows.snapshotSha256).toBe(unix.snapshotSha256);
    expect(JSON.stringify(windows)).not.toContain("alpha");
    expect(absent.bodyRevision.present).toBe(false);
    expect(empty.bodyRevision.present).toBe(true);
    expect(absent.bodyRevision.sha256).not.toBe(empty.bodyRevision.sha256);
  });

  test("keeps relationships explicit and rejects self-links or duplicates", () => {
    expect(context({ relationships: [] }).relationships).toEqual([]);

    expect(() => context({
      relationships: [{
        kind: "related",
        target: { owner: "teamleaderleo", repository: "stensibly", number: 403 },
      }],
    })).toThrow("must not target the source issue");

    expect(() => context({
      relationships: [
        {
          kind: "blocked_by",
          target: { owner: "teamleaderleo", repository: "stensibly", number: 149 },
        },
        {
          kind: "blocked_by",
          target: { owner: "TEAMLEADERLEO", repository: "STENSIBLY", number: 149 },
        },
      ],
    })).toThrow("must be unique");
  });

  test("rejects unsafe, oversized, temporally impossible, or malformed provider observations", () => {
    expect(() => context({ title: "unsafe\ncontrol" })).toThrow("unsafe characters");
    expect(() => context({ body: "x".repeat(128 * 1024 + 1) })).toThrow("at most");
    expect(() => context({ updatedAt: "2026-07-27T00:00:00.000Z" })).toThrow(
      "must not precede creation time",
    );
    expect(() => context({ sourceRevision: "etag with spaces" })).toThrow(
      "source revision is invalid",
    );
    expect(() => context({ owner: "bad--owner" })).toThrow("GitHub owner is invalid");
    expect(() => context({ repository: "../foreign" })).toThrow("GitHub repository is invalid");
  });
});

describe("GitHub issue context comparison", () => {
  test("deduplicates identical source revisions and detects changed revisions", () => {
    const first = context();
    const replay = context({
      labels: [...baseInput.labels!].reverse(),
      relationships: [...baseInput.relationships!].reverse(),
    });
    expect(compareGitHubIssueContexts(first, replay)).toEqual({
      outcome: "identical",
      externalId: "github:teamleaderleo/stensibly#403",
      sourceRevision: baseInput.sourceRevision,
    });

    const updated = context({
      title: "Render attributable response threads",
      updatedAt: "2026-07-29T12:00:00.000Z",
      sourceRevision: "github-updated-20260729T120000Z",
    });
    expect(compareGitHubIssueContexts(first, updated)).toEqual({
      outcome: "updated",
      externalId: "github:teamleaderleo/stensibly#403",
      previousSourceRevision: baseInput.sourceRevision,
      sourceRevision: "github-updated-20260729T120000Z",
      changedFields: ["title", "updatedAt"],
    });
  });

  test("classifies altered same-revision reuse as a conflict", () => {
    const first = context();
    const altered = context({ title: "Changed under the same provider revision" });

    expect(compareGitHubIssueContexts(first, altered)).toEqual({
      outcome: "altered_revision_conflict",
      externalId: "github:teamleaderleo/stensibly#403",
      sourceRevision: baseInput.sourceRevision,
      changedFields: ["title"],
    });
  });

  test("classifies older provider observations as stale without treating timestamps as authority", () => {
    const current = context();
    const older = context({
      title: "Older observation",
      updatedAt: "2026-07-28T20:00:00.000Z",
      sourceRevision: "github-updated-20260728T200000Z",
    });

    expect(compareGitHubIssueContexts(current, older)).toMatchObject({
      outcome: "stale",
      externalId: "github:teamleaderleo/stensibly#403",
      previousSourceRevision: baseInput.sourceRevision,
      sourceRevision: "github-updated-20260728T200000Z",
      changedFields: ["title", "updatedAt"],
    });
  });

  test("rejects tampered snapshots before comparison", () => {
    const first = context();
    const tampered = structuredClone(first);
    tampered.title = "Tampered after hashing";

    expect(() => compareGitHubIssueContexts(first, tampered)).toThrow(
      "Current GitHub issue context fingerprint is invalid",
    );
  });

  test("keeps different repository issue numbers distinct", () => {
    const first = context();
    const foreign = context({ repository: "another", number: 403 });

    expect(compareGitHubIssueContexts(first, foreign)).toEqual({
      outcome: "different_issue",
      externalId: "github:teamleaderleo/another#403",
      previousExternalId: "github:teamleaderleo/stensibly#403",
    });
  });
});
