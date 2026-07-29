import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acceptSqliteGitHubIssueContext,
  ensureGitHubIssueContextSchema,
  getCurrentSqliteGitHubIssueContext,
  listSqliteGitHubIssueContextHistory,
  type AcceptSqliteGitHubIssueContextInput,
} from "../src/github-issue-context-sqlite.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { acceptSqliteProjectAttachment } from "../src/project-attachments-sqlite.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";
import { StensiblyStore } from "../src/store.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ensureGitHubIssueContextSchema(store);
});

afterEach(() => store.close());

function attachment() {
  return acceptSqliteProjectAttachment(store, {
    project: "scrapbook",
    snapshot: compileProjectContract(renderProjectContract({
      version: 1,
      project: "scrapbook",
      repositories: ["teamleaderleo/stensibly"],
      runnerProfiles: ["codex-default"],
      concurrency: { project: 1, global: 1 },
      autonomousActions: ["inspect", "propose", "create_draft_pr"],
      approvalRequired: ["merge", "deploy"],
      checks: ["bun run typecheck", "bun test"],
      tags: ["coordination"],
      relatedProjects: [],
    }, {
      goal: "Coordinate scrapbook.",
      boundaries: "Keep GitHub and Stensibly state distinct.",
      evidenceAndHandoff: "Attach exact revisions and leave a next action.",
      escalation: "Escalate authority widening and ambiguous provider effects.",
    })),
    sourceRevision: "attachment-revision-1",
    acceptedBy: "actor:operator",
    acceptAuthorityWidening: true,
  }).attachment;
}

function contextInput(
  acceptedAttachment: ReturnType<typeof attachment>,
  overrides: Partial<AcceptSqliteGitHubIssueContextInput> = {},
): AcceptSqliteGitHubIssueContextInput {
  return {
    workspace: "default",
    project: "scrapbook",
    snapshot: buildGitHubIssueContext({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: 403,
      title: "Render item activity as an attributable response thread",
      body: "Bounded provider body.",
      state: "open",
      labels: ["triage:ready"],
      assignees: ["teamleaderleo"],
      createdAt: "2026-07-28T10:51:49.000Z",
      updatedAt: "2026-07-29T11:30:00.000Z",
      providerNodeId: "I_kwDOexample",
      sourceRevision: "github-updated-20260729T113000Z",
    }),
    projectAttachmentId: acceptedAttachment.id,
    projectAttachmentSnapshotSha256: acceptedAttachment.snapshot.snapshotSha256,
    instructionSources: [
      { path: "AGENTS.md", revision: "commit-1", contentSha256: HASH_A },
      { path: "docs/current-wave.md", revision: "commit-1", contentSha256: HASH_B },
    ],
    syncStatus: "synchronized",
    syncCursor: "cursor:403:1",
    observationRef: "github:api:issue:403:observation:1",
    observedAt: "2026-07-29T12:00:00.000Z",
    acceptedBy: "actor:plover",
    ...overrides,
  };
}

describe("GitHub issue synchronization observation ordering", () => {
  test("retains older observations without regressing current synchronization state", () => {
    const acceptedAttachment = attachment();
    const initial = acceptSqliteGitHubIssueContext(
      store,
      contextInput(acceptedAttachment),
    );

    const olderDegraded = acceptSqliteGitHubIssueContext(
      store,
      contextInput(acceptedAttachment, {
        syncStatus: "degraded",
        syncCursor: null,
        degradedReasonCode: "connector-unavailable",
        observationRef: "github:cached:issue:403:older",
        observedAt: "2026-07-29T11:59:00.000Z",
      }),
    );
    expect(olderDegraded.record).toMatchObject({
      outcome: "stale",
      isCurrent: false,
      syncStatus: "degraded",
    });
    expect(getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: initial.record.externalId,
    })?.id).toBe(initial.record.id);

    const newerDegraded = acceptSqliteGitHubIssueContext(
      store,
      contextInput(acceptedAttachment, {
        syncStatus: "degraded",
        syncCursor: null,
        degradedReasonCode: "connector-unavailable",
        observationRef: "github:cached:issue:403:newer",
        observedAt: "2026-07-29T12:05:00.000Z",
      }),
    );
    expect(newerDegraded.record).toMatchObject({
      outcome: "synchronization_updated",
      isCurrent: true,
      syncStatus: "degraded",
    });

    const recovered = acceptSqliteGitHubIssueContext(
      store,
      contextInput(acceptedAttachment, {
        syncCursor: "cursor:403:recovered",
        observationRef: "github:api:issue:403:recovered",
        observedAt: "2026-07-29T12:10:00.000Z",
      }),
    );
    expect(recovered.record).toMatchObject({
      outcome: "synchronization_updated",
      isCurrent: true,
      syncStatus: "synchronized",
      degradedReasonCode: null,
    });
    expect(getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: initial.record.externalId,
    })?.id).toBe(recovered.record.id);
    expect(listSqliteGitHubIssueContextHistory(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: initial.record.externalId,
    }).map((record) => record.outcome)).toEqual([
      "initial",
      "stale",
      "synchronization_updated",
      "synchronization_updated",
    ]);
  });

  test("enforces one current row per scoped GitHub issue in SQLite", () => {
    const acceptedAttachment = attachment();
    const initial = acceptSqliteGitHubIssueContext(store, contextInput(acceptedAttachment));
    acceptSqliteGitHubIssueContext(store, contextInput(acceptedAttachment, {
      observationRef: "github:api:issue:403:observation:2",
      observedAt: "2026-07-29T12:01:00.000Z",
    }));

    expect(() => store.db.query(`
      UPDATE github_issue_contexts
      SET is_current = 1
      WHERE id = ?1
    `).run(initial.record.id)).toThrow();
  });
});
