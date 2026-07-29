import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  buildAcceptedInstructionSetIdentity,
  GitHubProjectContextConflictError,
  GitHubProjectContextStaleError,
  projectGitHubContextFreshness,
  type AcceptedInstructionSetIdentity,
} from "../src/github-project-context.ts";
import {
  SqliteGitHubProjectContextStore,
} from "../src/github-project-context-sqlite.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const project = "stensibly";
const workspace = "default";
const issueUpdatedAt = "2026-07-29T12:00:00.000Z";
const observedAt = "2026-07-29T12:01:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const hashC = `sha256:${"c".repeat(64)}`;

let store: StensiblyStore;
let ledger: SqliteWorkLedger;
let contexts: SqliteGitHubProjectContextStore;
let attachment: ProjectAttachmentRecord;
let instructionSet: AcceptedInstructionSetIdentity;

beforeEach(async () => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  contexts = new SqliteGitHubProjectContextStore(
    store,
    () => new Date("2026-07-29T12:02:00.000Z"),
  );

  const snapshot = compileProjectContract(
    renderProjectContract({
      version: 1,
      project,
      repositories: ["teamleaderleo/stensibly"],
      runnerProfiles: ["codex-default"],
      concurrency: { project: 2, global: 4 },
      autonomousActions: ["inspect", "edit_files", "run_checks"],
      approvalRequired: ["merge", "deploy"],
      checks: ["repository-ci"],
      tags: ["dogfood"],
      relatedProjects: [],
    }, {
      goal: "Keep GitHub issue context recoverable.",
      boundaries: "GitHub owns issue state; Stensibly owns execution state.",
      evidenceAndHandoff: "Preserve exact issue and instruction revisions.",
      escalation: "Escalate ambiguous provider mutations.",
    }),
  );
  attachment = (await ledger.acceptProjectAttachment({
    project,
    snapshot,
    sourceRevision: "f19c2c7aa09fc4d4fdb7e7ae2d4d727d0eedd091",
    acceptedBy: "lumen",
    acceptAuthorityWidening: true,
  })).attachment;

  instructionSet = buildAcceptedInstructionSetIdentity({
    project,
    projectAttachmentId: attachment.id,
    projectAttachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    sources: [
      { path: "STENSIBLY.md", revision: "4120eb3b", contentSha256: hashA },
      { path: "AGENTS.md", revision: "535d0f12", contentSha256: hashB },
      { path: "docs/current-wave.md", revision: "b9cd9da7", contentSha256: hashC },
    ],
  });
});

afterEach(() => store.close());

describe("SQLite GitHub project context", () => {
  test("accepts, replays, refreshes, and isolates selected issue context", async () => {
    const context = issueContext();

    const accepted = await contexts.acceptIssueContext({
      workspace,
      project,
      context,
      instructionSet,
      observedAt,
      acceptedBy: "lumen",
    });
    expect(accepted).toMatchObject({
      replayed: false,
      comparison: "initial",
      record: {
        workspace,
        project,
        observedAt,
        projectAttachmentId: attachment.id,
      },
    });
    expect(accepted.record.context.containsIssueBody).toBe(false);

    const replayed = await contexts.acceptIssueContext({
      workspace,
      project,
      context,
      instructionSet,
      observedAt,
      acceptedBy: "another-worker",
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.record.id).toBe(accepted.record.id);

    const refreshed = await contexts.acceptIssueContext({
      workspace,
      project,
      context,
      instructionSet,
      observedAt: "2026-07-29T12:03:00.000Z",
      acceptedBy: "lumen",
    });
    expect(refreshed).toMatchObject({
      replayed: false,
      comparison: "identical",
      record: { observedAt: "2026-07-29T12:03:00.000Z" },
    });
    expect(refreshed.record.id).not.toBe(accepted.record.id);

    expect(await contexts.getIssueContext({
      workspace,
      project,
      externalId: context.reference.externalId,
    })).toMatchObject({ id: refreshed.record.id });

    expect(await contexts.getIssueContext({
      workspace: "other",
      project,
      externalId: context.reference.externalId,
    })).toBeNull();

    expect((await contexts.listIssueContexts({ workspace, project }))
      .map((record) => record.context.reference.externalId))
      .toEqual([context.reference.externalId]);
  });

  test("rejects altered revision reuse and stale provider observations", async () => {
    const current = issueContext();
    await accept(current);

    const alteredSameRevision = issueContext({
      title: "Changed under reused provider revision",
    });
    expect(contexts.acceptIssueContext({
      workspace,
      project,
      context: alteredSameRevision,
      instructionSet,
      observedAt,
      acceptedBy: "lumen",
    })).rejects.toBeInstanceOf(GitHubProjectContextConflictError);

    const stale = issueContext({
      title: "Older provider state",
      updatedAt: "2026-07-29T11:59:00.000Z",
      sourceRevision: "issue-492-revision-0",
    });
    expect(contexts.acceptIssueContext({
      workspace,
      project,
      context: stale,
      instructionSet,
      observedAt,
      acceptedBy: "lumen",
    })).rejects.toBeInstanceOf(GitHubProjectContextStaleError);

    const updated = issueContext({
      title: "Newer provider state",
      updatedAt: "2026-07-29T12:04:00.000Z",
      sourceRevision: "issue-492-revision-2",
    });
    const accepted = await contexts.acceptIssueContext({
      workspace,
      project,
      context: updated,
      instructionSet,
      observedAt: "2026-07-29T12:05:00.000Z",
      acceptedBy: "lumen",
    });
    expect(accepted).toMatchObject({
      replayed: false,
      comparison: "updated",
      record: { context: { title: "Newer provider state" } },
    });
  });

  test("requires current attachment and instruction-set bindings", async () => {
    const context = issueContext();
    const wrongInstructionSet = buildAcceptedInstructionSetIdentity({
      project,
      projectAttachmentId: "attach_wrong",
      projectAttachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      sources: [
        { path: "STENSIBLY.md", revision: "wrong-binding", contentSha256: hashA },
      ],
    });
    expect(contexts.acceptIssueContext({
      workspace,
      project,
      context,
      instructionSet: wrongInstructionSet,
      observedAt,
      acceptedBy: "lumen",
    })).rejects.toThrow("does not match the current project attachment");

    const foreign = buildGitHubIssueContext({
      owner: "another-owner",
      repository: "another-repository",
      number: 1,
      title: "Foreign issue",
      body: null,
      state: "open",
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: issueUpdatedAt,
      sourceRevision: "foreign-revision-1",
    });
    expect(contexts.acceptIssueContext({
      workspace,
      project,
      context: foreign,
      instructionSet,
      observedAt,
      acceptedBy: "lumen",
    })).rejects.toThrow("outside the accepted project attachment");
  });

  test("reports freshness and detects stored metadata tampering", async () => {
    const accepted = await accept(issueContext());

    expect(projectGitHubContextFreshness({
      record: accepted.record,
      now: "2026-07-29T12:01:30.000Z",
      maximumAgeSeconds: 60,
      sourceAvailable: true,
    })).toMatchObject({ state: "fresh", ageSeconds: 30 });

    expect(projectGitHubContextFreshness({
      record: accepted.record,
      now: "2026-07-29T12:03:00.000Z",
      maximumAgeSeconds: 60,
      sourceAvailable: true,
    })).toMatchObject({ state: "stale", ageSeconds: 120 });

    expect(projectGitHubContextFreshness({
      record: accepted.record,
      now: "2026-07-29T12:01:30.000Z",
      maximumAgeSeconds: 60,
      sourceAvailable: false,
    })).toMatchObject({ state: "degraded", sourceAvailable: false });

    store.db.query(`
      UPDATE github_project_issue_contexts
      SET context_snapshot_sha256 = ?1
      WHERE id = ?2
    `).run(`sha256:${"0".repeat(64)}`, accepted.record.id);

    expect(contexts.getIssueContext({
      workspace,
      project,
      externalId: accepted.record.context.reference.externalId,
    })).rejects.toThrow("metadata does not match");
  });
});

async function accept(context: GitHubIssueContext) {
  return contexts.acceptIssueContext({
    workspace,
    project,
    context,
    instructionSet,
    observedAt,
    acceptedBy: "lumen",
  });
}

function issueContext(overrides: {
  title?: string;
  updatedAt?: string;
  sourceRevision?: string;
} = {}): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 492,
    title: overrides.title ?? "Integrate GitHub context",
    body: "GitHub remains canonical.",
    state: "open",
    labels: ["triage:ready"],
    assignees: ["teamleaderleo"],
    relationships: [{
      kind: "parent",
      target: { owner: "teamleaderleo", repository: "stensibly", number: 491 },
    }],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? issueUpdatedAt,
    providerNodeId: "I_kwDO_example",
    sourceRevision: overrides.sourceRevision ?? "issue-492-revision-1",
  });
}
