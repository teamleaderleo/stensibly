import { afterEach, describe, expect, test } from "bun:test";
import {
  acceptSqliteGitHubIssueContext,
  ensureGitHubIssueContextSchema,
} from "../src/github-issue-context-sqlite.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { acceptSqliteProjectAttachment } from "../src/project-attachments-sqlite.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";
import { StensiblyStore } from "../src/store.ts";

const HASH = `sha256:${"a".repeat(64)}`;
const stores: StensiblyStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("GitHub issue repository attachment identity", () => {
  test.each([
    "teamleaderleo/stensibly",
    "TeamLeaderLeo/Stensibly",
    "https://github.com/teamleaderleo/stensibly",
    "https://github.com/teamleaderleo/stensibly.git",
    "ssh://git@github.com/teamleaderleo/stensibly.git",
  ])("accepts canonical GitHub repository declaration %s", (repository) => {
    const store = createStore();
    const project = `alias-${stores.length}`;
    const attachment = acceptAttachment(store, project, repository);

    const accepted = acceptSqliteGitHubIssueContext(store, {
      workspace: "default",
      project,
      snapshot: buildGitHubIssueContext({
        owner: "TeamLeaderLeo",
        repository: "Stensibly",
        number: 492,
        title: "Integrate GitHub context",
        body: null,
        state: "open",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
        sourceRevision: `github-${stores.length}`,
      }),
      projectAttachmentId: attachment.id,
      projectAttachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      instructionSources: [{
        path: "STENSIBLY.md",
        revision: "attachment-revision-1",
        contentSha256: HASH,
      }],
      syncStatus: "synchronized",
      syncCursor: `cursor:${stores.length}`,
      observationRef: `github:issue:492:alias:${stores.length}`,
      observedAt: "2026-07-29T12:01:00.000Z",
      acceptedBy: "actor:lumen",
    });

    expect(accepted.record.externalId).toBe("github:teamleaderleo/stensibly#492");
    expect(accepted.record.isCurrent).toBe(true);
  });

  test("rejects a genuinely foreign GitHub repository", () => {
    const store = createStore();
    const attachment = acceptAttachment(
      store,
      "foreign",
      "https://github.com/teamleaderleo/another.git",
    );

    expect(() => acceptSqliteGitHubIssueContext(store, {
      workspace: "default",
      project: "foreign",
      snapshot: buildGitHubIssueContext({
        owner: "teamleaderleo",
        repository: "stensibly",
        number: 492,
        title: "Integrate GitHub context",
        body: null,
        state: "open",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
        sourceRevision: "github-foreign-1",
      }),
      projectAttachmentId: attachment.id,
      projectAttachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      instructionSources: [{
        path: "STENSIBLY.md",
        revision: "attachment-revision-1",
        contentSha256: HASH,
      }],
      syncStatus: "synchronized",
      syncCursor: "cursor:foreign",
      observationRef: "github:issue:492:foreign",
      observedAt: "2026-07-29T12:01:00.000Z",
      acceptedBy: "actor:lumen",
    })).toThrow("is not declared");
  });
});

function createStore(): StensiblyStore {
  const store = new StensiblyStore(":memory:");
  stores.push(store);
  ensureGitHubIssueContextSchema(store);
  return store;
}

function acceptAttachment(
  store: StensiblyStore,
  project: string,
  repository: string,
) {
  return acceptSqliteProjectAttachment(store, {
    project,
    snapshot: compileProjectContract(renderProjectContract({
      version: 1,
      project,
      repositories: [repository],
      runnerProfiles: ["codex-default"],
      concurrency: { project: 1, global: 1 },
      autonomousActions: ["inspect"],
      approvalRequired: ["merge"],
      checks: ["bun test"],
      tags: ["github-context"],
      relatedProjects: [],
    }, {
      goal: "Consume bounded GitHub issue context.",
      boundaries: "GitHub remains authoritative for issue state.",
      evidenceAndHandoff: "Record exact provider and instruction revisions.",
      escalation: "Escalate ambiguous provider effects.",
    })),
    sourceRevision: "attachment-revision-1",
    acceptedBy: "actor:lumen",
    acceptAuthorityWidening: true,
  }).attachment;
}
