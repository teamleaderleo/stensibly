import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acceptSqliteGitHubIssueContext,
  buildAcceptedRepositoryInstructionSet,
  ensureGitHubIssueContextSchema,
  getCurrentSqliteGitHubIssueContext,
  GitHubIssueContextConflictError,
  listSqliteGitHubIssueContextHistory,
  type AcceptSqliteGitHubIssueContextInput,
  type RepositoryInstructionSourceInput,
} from "../src/github-issue-context-sqlite.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContextInput,
} from "../src/github-issue-context.ts";
import { acceptSqliteProjectAttachment } from "../src/project-attachments-sqlite.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";
import { StensiblyStore } from "../src/store.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

const issueInput: GitHubIssueContextInput = {
  owner: "TeamLeaderLeo",
  repository: "Stensibly",
  number: 403,
  title: "Render item activity as an attributable response thread",
  body: "Bounded provider body.",
  state: "open",
  labels: ["triage:ready", "area:dashboard"],
  assignees: ["TeamLeaderLeo"],
  relationships: [{
    kind: "blocked_by",
    target: { owner: "teamleaderleo", repository: "stensibly", number: 149 },
  }],
  createdAt: "2026-07-28T10:51:49.000Z",
  updatedAt: "2026-07-29T11:30:00.000Z",
  providerNodeId: "I_kwDOexample",
  sourceRevision: "github-updated-20260729T113000Z",
};

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

function issue(overrides: Partial<GitHubIssueContextInput> = {}) {
  return buildGitHubIssueContext({ ...issueInput, ...overrides });
}

function sources(overrides: Partial<Record<string, string>> = {}): RepositoryInstructionSourceInput[] {
  return [
    {
      path: "README.md",
      revision: overrides.readmeRevision ?? "commit-readme-1",
      contentSha256: overrides.readmeHash ?? HASH_A,
    },
    {
      path: "AGENTS.md",
      revision: overrides.agentsRevision ?? "commit-agents-1",
      contentSha256: overrides.agentsHash ?? HASH_B,
    },
    {
      path: "docs/current-wave.md",
      revision: overrides.waveRevision ?? "commit-wave-1",
      contentSha256: overrides.waveHash ?? HASH_C,
    },
  ];
}

function attachment(project = "scrapbook", repositories = ["teamleaderleo/stensibly"]) {
  ensureGitHubIssueContextSchema(store);
  return acceptSqliteProjectAttachment(store, {
    project,
    snapshot: compileProjectContract(renderProjectContract({
      version: 1,
      project,
      repositories,
      runnerProfiles: ["codex-default"],
      concurrency: { project: 1, global: 1 },
      autonomousActions: ["inspect", "propose", "create_draft_pr"],
      approvalRequired: ["merge", "deploy"],
      checks: ["bun run typecheck", "bun test"],
      tags: ["coordination"],
      relatedProjects: [],
    }, {
      goal: `Coordinate ${project}.`,
      boundaries: "Keep GitHub and Stensibly state distinct.",
      evidenceAndHandoff: "Attach exact revisions and leave a next action.",
      escalation: "Escalate authority widening and ambiguous provider effects.",
    })),
    sourceRevision: "attachment-revision-1",
    acceptedBy: "actor:operator",
    acceptAuthorityWidening: true,
  }).attachment;
}

function acceptanceInput(
  acceptedAttachment: ReturnType<typeof attachment>,
  overrides: Partial<AcceptSqliteGitHubIssueContextInput> = {},
): AcceptSqliteGitHubIssueContextInput {
  return {
    workspace: "default",
    project: acceptedAttachment.project,
    snapshot: issue(),
    projectAttachmentId: acceptedAttachment.id,
    projectAttachmentSnapshotSha256: acceptedAttachment.snapshot.snapshotSha256,
    instructionSources: sources(),
    syncStatus: "synchronized",
    syncCursor: "cursor:403:1",
    observationRef: "github:api:issue:403:observation:1",
    observedAt: "2026-07-29T11:31:00.000Z",
    acceptedBy: "actor:mercury",
    ...overrides,
  };
}

describe("accepted repository instruction identity", () => {
  test("canonicalizes explicit sources with code-unit ordering", () => {
    const first = buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_example",
      projectAttachmentSnapshotSha256: HASH_A,
      sources: sources(),
    });
    const second = buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_example",
      projectAttachmentSnapshotSha256: HASH_A,
      sources: [...sources()].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.sources.map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "README.md",
      "docs/current-wave.md",
    ]);
    expect(first.id).toMatch(/^instructions_[a-f0-9]{64}$/);
    expect(first.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("rejects duplicate, traversing, or missing instruction sources", () => {
    expect(() => buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_example",
      projectAttachmentSnapshotSha256: HASH_A,
      sources: [],
    })).toThrow("must contain");
    expect(() => buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_example",
      projectAttachmentSnapshotSha256: HASH_A,
      sources: [sources()[0]!, sources()[0]!],
    })).toThrow("must be unique");
    expect(() => buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_example",
      projectAttachmentSnapshotSha256: HASH_A,
      sources: [{ path: "../AGENTS.md", revision: "commit-1", contentSha256: HASH_A }],
    })).toThrow("traversal-free");
  });
});

describe("SQLite GitHub issue context", () => {
  test("accepts one current record and deduplicates exact observation replay", () => {
    const acceptedAttachment = attachment();
    const first = acceptSqliteGitHubIssueContext(
      store,
      acceptanceInput(acceptedAttachment),
    );
    expect(first).toMatchObject({
      replayed: false,
      record: {
        workspace: "default",
        project: "scrapbook",
        externalId: "github:teamleaderleo/stensibly#403",
        syncStatus: "synchronized",
        isCurrent: true,
        outcome: "initial",
      },
    });
    expect(first.record.instructionSet.sources.map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "README.md",
      "docs/current-wave.md",
    ]);

    const replay = acceptSqliteGitHubIssueContext(
      store,
      acceptanceInput(acceptedAttachment),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(listSqliteGitHubIssueContextHistory(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: first.record.externalId,
    })).toHaveLength(1);
  });

  test("records synchronization degradation without inventing a provider revision", () => {
    const acceptedAttachment = attachment();
    const first = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment));
    const degraded = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      syncStatus: "degraded",
      degradedReasonCode: "connector-unavailable",
      syncCursor: null,
      observationRef: "github:cached:issue:403:observation:2",
      observedAt: "2026-07-29T11:40:00.000Z",
    }));

    expect(degraded).toMatchObject({
      replayed: false,
      record: {
        outcome: "synchronization_updated",
        syncStatus: "degraded",
        degradedReasonCode: "connector-unavailable",
        isCurrent: true,
      },
    });
    expect(degraded.record.snapshot.sourceRevision).toBe(first.record.snapshot.sourceRevision);
    expect(getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: first.record.externalId,
    })?.id).toBe(degraded.record.id);
    expect(listSqliteGitHubIssueContextHistory(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: first.record.externalId,
    }).map((entry) => entry.outcome)).toEqual(["initial", "synchronization_updated"]);
  });

  test("rejects altered reuse of one observation reference", () => {
    const acceptedAttachment = attachment();
    acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment));
    expect(() => acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      syncCursor: "cursor:changed-under-one-observation",
    }))).toThrow("observation reference");
  });

  test("replaces current state for newer provider content and retains stale evidence", () => {
    const acceptedAttachment = attachment();
    const first = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment));
    const updated = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      snapshot: issue({
        title: "Render attributable response threads",
        sourceRevision: "github-updated-20260729T120000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
      }),
      syncCursor: "cursor:403:2",
      observationRef: "github:api:issue:403:observation:2",
      observedAt: "2026-07-29T12:01:00.000Z",
    }));
    const stale = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      snapshot: issue({
        title: "Older provider observation",
        sourceRevision: "github-updated-20260728T200000Z",
        updatedAt: "2026-07-28T20:00:00.000Z",
      }),
      syncCursor: "cursor:403:old",
      observationRef: "github:api:issue:403:observation:old",
      observedAt: "2026-07-29T12:02:00.000Z",
    }));

    expect(first.record.outcome).toBe("initial");
    expect(updated.record).toMatchObject({ outcome: "updated", isCurrent: true });
    expect(stale.record).toMatchObject({ outcome: "stale", isCurrent: false });
    expect(getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: first.record.externalId,
    })?.id).toBe(updated.record.id);
    expect(listSqliteGitHubIssueContextHistory(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: first.record.externalId,
    }).map((entry) => entry.outcome)).toEqual(["initial", "updated", "stale"]);
  });

  test("fails closed when one provider revision is reused with altered content", () => {
    const acceptedAttachment = attachment();
    acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment));

    expect(() => acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      snapshot: issue({ title: "Altered under the same source revision" }),
      observationRef: "github:api:issue:403:observation:altered",
    }))).toThrow(GitHubIssueContextConflictError);
    expect(listSqliteGitHubIssueContextHistory(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: "github:teamleaderleo/stensibly#403",
    })).toHaveLength(1);
  });

  test("records instruction drift as an explicit current rebinding", () => {
    const acceptedAttachment = attachment();
    const first = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment));
    const rebound = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      instructionSources: sources({
        waveRevision: "commit-wave-2",
        waveHash: HASH_A,
      }),
      observationRef: "github:api:issue:403:instruction-rebind",
      observedAt: "2026-07-29T11:35:00.000Z",
    }));

    expect(rebound).toMatchObject({
      replayed: false,
      record: { outcome: "instruction_rebound", isCurrent: true },
    });
    expect(rebound.record.instructionSet.id).not.toBe(first.record.instructionSet.id);
    expect(getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: first.record.externalId,
    })?.id).toBe(rebound.record.id);
  });

  test("keeps workspace, project, repository, and issue identities isolated", () => {
    const scrapbook = attachment("scrapbook", [
      "teamleaderleo/stensibly",
      "teamleaderleo/another",
    ]);
    const other = attachment("other");
    const defaultRecord = acceptSqliteGitHubIssueContext(store, acceptanceInput(scrapbook));
    const otherWorkspace = acceptSqliteGitHubIssueContext(store, acceptanceInput(scrapbook, {
      workspace: "sandbox",
      observationRef: "github:api:issue:403:sandbox",
    }));
    const otherProject = acceptSqliteGitHubIssueContext(store, acceptanceInput(other, {
      project: "other",
      observationRef: "github:api:issue:403:other-project",
    }));
    const otherRepository = acceptSqliteGitHubIssueContext(store, acceptanceInput(scrapbook, {
      snapshot: issue({ repository: "another", number: 403 }),
      observationRef: "github:api:another:403",
    }));

    expect(defaultRecord.record.id).not.toBe(otherWorkspace.record.id);
    expect(defaultRecord.record.id).not.toBe(otherProject.record.id);
    expect(defaultRecord.record.externalId).not.toBe(otherRepository.record.externalId);
    expect(getCurrentSqliteGitHubIssueContext(store, {
      workspace: "sandbox",
      project: "scrapbook",
      externalId: defaultRecord.record.externalId,
    })?.id).toBe(otherWorkspace.record.id);
  });

  test("requires the current attachment and its declared repository", () => {
    const acceptedAttachment = attachment();
    expect(() => acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      projectAttachmentId: "attach_wrong",
    }))).toThrow("current accepted project attachment");

    const foreignOnly = attachment("foreign", ["teamleaderleo/other"]);
    expect(() => acceptSqliteGitHubIssueContext(store, acceptanceInput(foreignOnly, {
      project: "foreign",
    }))).toThrow("is not declared");
  });

  test("records degraded synchronization only with an explicit bounded reason", () => {
    const acceptedAttachment = attachment();
    const degraded = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      syncStatus: "degraded",
      degradedReasonCode: "connector-unavailable",
      syncCursor: null,
      observationRef: "github:cached:issue:403",
    }));
    expect(degraded.record).toMatchObject({
      syncStatus: "degraded",
      degradedReasonCode: "connector-unavailable",
    });

    expect(() => acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      snapshot: issue({ number: 404 }),
      syncStatus: "degraded",
      degradedReasonCode: null,
      observationRef: "github:cached:issue:404",
    }))).toThrow("requires a reason code");
    expect(() => acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment, {
      snapshot: issue({ number: 405 }),
      syncStatus: "synchronized",
      degradedReasonCode: "not-allowed",
      observationRef: "github:api:issue:405",
    }))).toThrow("cannot carry");
  });

  test("detects tampered stored snapshots and instruction bindings", () => {
    const acceptedAttachment = attachment();
    const accepted = acceptSqliteGitHubIssueContext(store, acceptanceInput(acceptedAttachment));
    store.db.query(`
      UPDATE github_issue_contexts
      SET content_sha256 = ?1
      WHERE id = ?2
    `).run(HASH_A, accepted.record.id);
    expect(() => getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: accepted.record.externalId,
    })).toThrow("metadata does not match");

    ensureGitHubIssueContextSchema(store);
    store.db.query(`
      UPDATE github_issue_contexts
      SET content_sha256 = ?1,
          instruction_set_sha256 = ?2
      WHERE id = ?3
    `).run(accepted.record.snapshot.contentSha256, HASH_B, accepted.record.id);
    expect(() => getCurrentSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "scrapbook",
      externalId: accepted.record.externalId,
    })).toThrow("instruction binding is invalid");
  });
});
