import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import {
  acceptSqliteGitHubIssueContext,
} from "../src/github-issue-context-sqlite.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { acceptSqliteProjectAttachment } from "../src/project-attachments-sqlite.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";
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
    issue(403, "Render item activity as an attributable response thread", "issue-403-r1", "2026-07-29T11:30:00.000Z"),
    "github:issue:403:observation:1",
    "2026-07-29T11:31:00.000Z",
  );
  accept(
    issue(403, "Render item activity as an attributable response thread", "issue-403-r1", "2026-07-29T11:30:00.000Z"),
    "github:issue:403:degraded:2",
    "2026-07-29T11:40:00.000Z",
    "degraded",
    "github-connector-unavailable",
  );
  accept(
    issue(490, "P0: Restore reliable ChatGPT MCP and GitHub issue mutations", "issue-490-r1", "2026-07-29T13:19:10.000Z"),
    "github:issue:490:observation:1",
    "2026-07-29T13:20:00.000Z",
  );
}

describe("remote GitHub project context recovery", () => {
  test("lists accepted issues, returns bounded history, and enforces project read access", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);

    try {
      seedGitHubContext(store);
      const reader = createApiToken(store, {
        name: "Scrapbook GitHub context reader",
        scopes: ["read"],
        projects: ["scrapbook"],
      });
      const foreignReader = createApiToken(store, {
        name: "Foreign reader",
        scopes: ["read"],
        projects: ["other"],
      });
      const writer = createApiToken(store, {
        name: "Write-only reader",
        scopes: ["write"],
        projects: ["scrapbook"],
      });
      const app = createServerApp(store);

      await initialize(app, reader.token, 1);
      const project = await callTool<any>(app, reader.token, 2, {
        project: "scrapbook",
      });
      expect(project).toMatchObject({
        version: 1,
        workspace: "default",
        project: "scrapbook",
        mode: "project",
        requestedExternalId: null,
      });
      expect(project.issues.map((entry: any) => entry.externalId)).toEqual([
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
      expect(project.recovery.guidance.map((entry: any) => entry.code)).toEqual([
        "use_normal_chat",
        "select_github_and_stensibly",
        "start_new_conversation_on_host_binding_failure",
        "refresh_stensibly_actions_on_manifest_drift",
        "reconnect_oauth_on_worker_auth_failure",
      ]);

      const exact = await callTool<any>(app, reader.token, 3, {
        project: "scrapbook",
        externalId: "github:teamleaderleo/stensibly#403",
        historyLimit: 10,
      });
      expect(exact).toMatchObject({
        mode: "issue",
        requestedExternalId: "github:teamleaderleo/stensibly#403",
      });
      expect(exact.issues).toHaveLength(1);
      expect(exact.history.map((entry: any) => entry.synchronizationStatus)).toEqual([
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

      const foreign = await mcpRequest(app, foreignReader.token, toolCall(4, {
        project: "scrapbook",
      }));
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({
        error: { message: "Token cannot access project scrapbook" },
        id: 4,
      });

      const missingReadScope = await mcpRequest(app, writer.token, toolCall(5, {
        project: "scrapbook",
      }));
      expect(missingReadScope.status).toBe(403);
      expect(await missingReadScope.json()).toMatchObject({
        error: { message: "Token requires read scope" },
        id: 5,
      });
    } finally {
      store.close();
    }
  });
});

async function initialize(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
): Promise<void> {
  const response = await mcpRequest(app, token, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "github-context-test", version: "0.0.1" },
    },
  });
  expect(response.status).toBe(200);
}

async function callTool<T>(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await mcpRequest(app, token, toolCall(id, args));
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }> };
  };
  const first = payload.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("GitHub project context response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}

function toolCall(id: number, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "get_github_project_context", arguments: args },
  };
}

async function mcpRequest(
  app: ReturnType<typeof createServerApp>,
  token: string,
  body: unknown,
): Promise<Response> {
  return await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(body),
  });
}
