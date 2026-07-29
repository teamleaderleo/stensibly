import { describe, expect, test } from "bun:test";
import {
  acceptSqliteGitHubIssueContext,
} from "../src/github-issue-context-sqlite.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { getSqliteGitHubProjectContext } from "../src/github-project-context.ts";
import {
  acceptSqliteProjectAttachment,
  ensureProjectAttachmentSchema,
} from "../src/project-attachments-sqlite.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";
import { StensiblyStore } from "../src/store.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const instructionSources = [
  { path: "AGENTS.md", revision: "main-agents", contentSha256: HASH_A },
  { path: "STENSIBLY.md", revision: "main-stensibly", contentSha256: HASH_B },
];

function issue(number: number, title: string, sourceRevision: string, updatedAt: string) {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number,
    title,
    body: `Bounded issue ${number} body`,
    state: "open",
    labels: ["triage:ready"],
    assignees: ["teamleaderleo"],
    relationships: number === 403
      ? [{
        kind: "blocked_by",
        target: { owner: "teamleaderleo", repository: "stensibly", number: 149 },
      }]
      : [],
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt,
    sourceRevision,
  });
}

function seedGitHubContext(store: StensiblyStore): void {
  ensureProjectAttachmentSchema(store);
  const attachment = acceptSqliteProjectAttachment(store, {
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
      goal: "Coordinate Stensibly dogfood.",
      boundaries: "Keep GitHub and Stensibly state distinct.",
      evidenceAndHandoff: "Attach exact revisions and leave a next action.",
      escalation: "Escalate authority widening and ambiguous effects.",
    })),
    sourceRevision: "attachment-main-1",
    acceptedBy: "actor:operator",
    acceptAuthorityWidening: true,
  }).attachment;

  const accept = (
    snapshot: ReturnType<typeof issue>,
    observationRef: string,
    observedAt: string,
    syncStatus: "synchronized" | "degraded" = "synchronized",
    degradedReasonCode: string | null = null,
  ) => acceptSqliteGitHubIssueContext(store, {
    workspace: "default",
    project: "scrapbook",
    snapshot,
    projectAttachmentId: attachment.id,
    projectAttachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    instructionSources,
    syncStatus,
    syncCursor: syncStatus === "synchronized" ? observationRef : null,
    degradedReasonCode,
    observationRef,
    observedAt,
    acceptedBy: "actor:mercury",
  });

  accept(
    issue(
      403,
      "Render item activity as an attributable response thread",
      "issue-403-r1",
      "2026-07-29T11:30:00.000Z",
    ),
    "github:issue:403:observation:1",
    "2026-07-29T11:31:00.000Z",
  );
  accept(
    issue(
      403,
      "Render item activity as an attributable response thread",
      "issue-403-r1",
      "2026-07-29T11:30:00.000Z",
    ),
    "github:issue:403:degraded:2",
    "2026-07-29T11:40:00.000Z",
    "degraded",
    "github-connector-unavailable",
  );
  accept(
    issue(
      490,
      "P0: Restore reliable ChatGPT MCP and GitHub issue mutations",
      "issue-490-r1",
      "2026-07-29T13:19:10.000Z",
    ),
    "github:issue:490:observation:1",
    "2026-07-29T13:20:00.000Z",
  );
}

describe("GitHub project context recovery projection", () => {
  test("lists current accepted issues with direct links and recovery guidance", () => {
    const store = new StensiblyStore(":memory:");
    try {
      seedGitHubContext(store);
      const project = getSqliteGitHubProjectContext(store, {
        project: "scrapbook",
      });

      expect(project).toMatchObject({
        version: 1,
        workspace: "default",
        project: "scrapbook",
        mode: "project",
        requestedExternalId: null,
      });
      expect(project.issues.map((entry) => entry.externalId)).toEqual([
        "github:teamleaderleo/stensibly#403",
        "github:teamleaderleo/stensibly#490",
      ]);
      expect(project.issues[0]).toMatchObject({
        canonicalUrl: "https://github.com/teamleaderleo/stensibly/issues/403",
        synchronization: {
          status: "degraded",
          degradedReasonCode: "github-connector-unavailable",
        },
        instructions: {
          sourcePaths: ["AGENTS.md", "STENSIBLY.md"],
        },
      });
      expect(project.recovery.guidance.map((entry) => entry.code)).toEqual([
        "use_normal_chat",
        "select_github_and_stensibly",
        "start_new_conversation_on_host_binding_failure",
        "refresh_stensibly_actions_on_manifest_drift",
        "reconnect_oauth_on_worker_auth_failure",
      ]);
      expect(project.recovery.directGitHubUrls).toEqual([
        "https://github.com/teamleaderleo/stensibly/issues/403",
        "https://github.com/teamleaderleo/stensibly/issues/490",
      ]);
    } finally {
      store.close();
    }
  });

  test("returns bounded history for one canonical issue without sensitive snapshot fields", () => {
    const store = new StensiblyStore(":memory:");
    try {
      seedGitHubContext(store);
      const exact = getSqliteGitHubProjectContext(store, {
        project: "scrapbook",
        externalId: "github:teamleaderleo/stensibly#403",
        historyLimit: 10,
      });

      expect(exact).toMatchObject({
        mode: "issue",
        requestedExternalId: "github:teamleaderleo/stensibly#403",
      });
      expect(exact.issues).toHaveLength(1);
      expect(exact.history.map((entry) => entry.synchronizationStatus)).toEqual([
        "synchronized",
        "degraded",
      ]);
      expect(exact.recovery.directGitHubUrls).toEqual([
        "https://github.com/teamleaderleo/stensibly/issues/403",
      ]);

      const serialized = JSON.stringify(exact);
      expect(serialized).not.toContain("contentSha256");
      expect(serialized).not.toContain("snapshotSha256");
      expect(serialized).not.toContain("bodyRevision");
      expect(serialized).not.toContain("syncCursor");
      expect(serialized).not.toContain("Bounded issue 403 body");
    } finally {
      store.close();
    }
  });

  test("bounds list and history inputs and returns an empty exact projection for unknown issues", () => {
    const store = new StensiblyStore(":memory:");
    try {
      seedGitHubContext(store);
      expect(() => getSqliteGitHubProjectContext(store, {
        project: "scrapbook",
        limit: 101,
      })).toThrow("between 1 and 100");
      expect(() => getSqliteGitHubProjectContext(store, {
        project: "Scrapbook",
      })).toThrow("project is invalid");

      const unknown = getSqliteGitHubProjectContext(store, {
        project: "scrapbook",
        externalId: "github:teamleaderleo/stensibly#999",
      });
      expect(unknown.issues).toEqual([]);
      expect(unknown.history).toEqual([]);
      expect(unknown.recovery.directGitHubUrls).toEqual([]);
    } finally {
      store.close();
    }
  });
});
