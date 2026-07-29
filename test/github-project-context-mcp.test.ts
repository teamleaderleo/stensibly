import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acceptSqliteGitHubIssueContext } from "../src/github-issue-context-sqlite.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { renderProjectContract, compileProjectContract } from "../src/project-contract.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const protocolVersion = "2025-06-18";
const principals: Record<string, TokenPrincipal> = {
  reader: {
    tokenId: "tok_github_context_reader",
    name: "github-context-reader",
    scopes: ["read"],
    projects: ["scrapbook"],
  },
  outsider: {
    tokenId: "tok_github_context_outsider",
    name: "github-context-outsider",
    scopes: ["read"],
    projects: ["other"],
  },
  writer: {
    tokenId: "tok_github_context_writer",
    name: "github-context-writer",
    scopes: ["write"],
    projects: ["scrapbook"],
  },
};

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return principals[rawToken] ?? null;
  }
}

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(async () => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  const accepted = await ledger.acceptProjectAttachment({
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
  });

  acceptSqliteGitHubIssueContext(store, {
    workspace: "default",
    project: "scrapbook",
    snapshot: buildGitHubIssueContext({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: 403,
      title: "Render item activity as an attributable response thread",
      body: "Bounded issue body that must not appear in the MCP projection.",
      state: "open",
      labels: ["triage:ready"],
      assignees: ["teamleaderleo"],
      relationships: [{
        kind: "blocked_by",
        target: { owner: "teamleaderleo", repository: "stensibly", number: 149 },
      }],
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-29T11:30:00.000Z",
      sourceRevision: "issue-403-r1",
    }),
    projectAttachmentId: accepted.attachment.id,
    projectAttachmentSnapshotSha256: accepted.attachment.snapshot.snapshotSha256,
    instructionSources: [
      {
        path: "AGENTS.md",
        revision: "main-agents",
        contentSha256: `sha256:${"a".repeat(64)}`,
      },
      {
        path: "STENSIBLY.md",
        revision: "main-stensibly",
        contentSha256: `sha256:${"b".repeat(64)}`,
      },
    ],
    syncStatus: "degraded",
    syncCursor: null,
    degradedReasonCode: "github-connector-unavailable",
    observationRef: "github:issue:403:degraded:1",
    observedAt: "2026-07-29T11:40:00.000Z",
    acceptedBy: "actor:quill",
  });
});

afterEach(() => store.close());

describe("GitHub project context MCP", () => {
  test("serves bounded accepted context through an authorised project-scoped read", async () => {
    const app = createServerApp(store, {
      authenticator: new FixedAuthenticator(),
    });
    const response = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("reader"),
      body: JSON.stringify(toolCall(1, {
        project: "scrapbook",
        externalId: "github:teamleaderleo/stensibly#403",
      })),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("github:teamleaderleo/stensibly#403");
    expect(text).toContain("github-connector-unavailable");
    expect(text).toContain("instructions_");
    expect(text).toContain("do not grant execution or provider-mutation authority");
    expect(text).not.toContain("Bounded issue body");
    expect(text).not.toContain("contentSha256");
    expect(text).not.toContain("syncCursor");
  });

  test("requires read scope and the exact authorised project before execution", async () => {
    const app = createServerApp(store, {
      authenticator: new FixedAuthenticator(),
    });

    const wrongProject = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("reader"),
      body: JSON.stringify(toolCall(2, { project: "other" })),
    });
    expect(wrongProject.status).toBe(403);
    expect(await wrongProject.json()).toMatchObject({
      error: { message: "Token cannot access project other" },
    });

    const wrongPrincipal = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("outsider"),
      body: JSON.stringify(toolCall(3, { project: "scrapbook" })),
    });
    expect(wrongPrincipal.status).toBe(403);
    expect(await wrongPrincipal.json()).toMatchObject({
      error: { message: "Token cannot access project scrapbook" },
    });

    const writeOnly = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("writer"),
      body: JSON.stringify(toolCall(4, { project: "scrapbook" })),
    });
    expect(writeOnly.status).toBe(403);
    expect(await writeOnly.json()).toMatchObject({
      error: { message: "Token requires read scope" },
    });
  });
});

function mcpHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
  };
}

function toolCall(id: number, arguments_: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "get_github_project_context",
      arguments: arguments_,
    },
  };
}
