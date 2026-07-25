import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiV1 } from "../src/api-v1.ts";
import { renderProjectContract, compileProjectContract } from "../src/project-contract.ts";
import { ProjectAttachmentWideningError } from "../src/project-attachment-ledger.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const protocolVersion = "2025-06-18";

const principals: Record<string, TokenPrincipal> = {
  reader: {
    tokenId: "tok_reader_internal",
    name: "project-reader",
    scopes: ["read"],
    projects: ["scrapbook"],
  },
  writer: {
    tokenId: "tok_writer_internal",
    name: "project-writer",
    scopes: ["write"],
    projects: ["scrapbook"],
  },
  admin: {
    tokenId: "tok_admin_internal",
    name: "project-operator",
    scopes: ["admin"],
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

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("project attachment ledger", () => {
  test("requires acknowledgement for first import and later widening", async () => {
    const first = snapshot();
    await expect(ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: first,
      sourceRevision: "1111111",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: false,
    })).rejects.toBeInstanceOf(ProjectAttachmentWideningError);

    const accepted = await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: first,
      sourceRevision: "1111111",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });
    expect(accepted).toMatchObject({
      replayed: false,
      diff: null,
      attachment: {
        project: "scrapbook",
        sourceRevision: "1111111",
        authorityWidening: true,
      },
    });

    const replay = await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: first,
      sourceRevision: "1111111",
      acceptedBy: "token:another-operator",
      acceptAuthorityWidening: false,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.attachment.id).toBe(accepted.attachment.id);
    expect(replay.attachment.acceptedBy).toBe("token:operator");

    const neutral = snapshot({ goal: "Keep the accepted context current." });
    const neutralAcceptance = await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: neutral,
      sourceRevision: "2222222",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: false,
    });
    expect(neutralAcceptance.replayed).toBe(false);
    expect(neutralAcceptance.diff?.widensAuthority).toBe(false);
    expect(neutralAcceptance.diff?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "context.goal", authorityEffect: "neutral" }),
    ]));

    const widened = snapshot({
      repositories: ["teamleaderleo/stensibly", "teamleaderleo/another-repo"],
    });
    await expect(ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: widened,
      sourceRevision: "3333333",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: false,
    })).rejects.toBeInstanceOf(ProjectAttachmentWideningError);
  });

  test("rejects route-project mismatch and tampered stored metadata", async () => {
    await expect(ledger.acceptProjectAttachment({
      project: "other",
      snapshot: snapshot(),
      sourceRevision: "1111111",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    })).rejects.toThrow("not route project other");

    const accepted = await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: snapshot(),
      sourceRevision: "1111111",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });
    store.db.query("UPDATE project_attachments SET content_sha256 = ?1 WHERE id = ?2")
      .run(`sha256:${"0".repeat(64)}`, accepted.attachment.id);
    expect(() => ledger.getProjectAttachment("scrapbook"))
      .toThrow("metadata does not match");
  });
});

describe("project attachment REST and MCP", () => {
  test("uses admin import, project-scoped reads, replay, and redacted importer metadata", async () => {
    const app = createApiV1(new FixedAuthenticator(), ledger, { required: true });
    const body = {
      snapshot: snapshot(),
      sourceRevision: "1111111",
      acceptAuthorityWidening: false,
    };

    const missing = await app.request("/projects/scrapbook/attachment", {
      headers: bearer("reader"),
    });
    expect(missing.status).toBe(404);

    const denied = await app.request("/projects/scrapbook/attachment", {
      method: "PUT",
      headers: jsonHeaders("writer"),
      body: JSON.stringify(body),
    });
    expect(denied.status).toBe(403);

    const unacknowledged = await app.request("/projects/scrapbook/attachment", {
      method: "PUT",
      headers: jsonHeaders("admin"),
      body: JSON.stringify(body),
    });
    expect(unacknowledged.status).toBe(409);
    expect(await unacknowledged.json()).toMatchObject({
      code: "authority_widening_requires_acknowledgement",
    });

    const imported = await app.request("/projects/scrapbook/attachment", {
      method: "PUT",
      headers: jsonHeaders("admin"),
      body: JSON.stringify({ ...body, acceptAuthorityWidening: true }),
    });
    expect(imported.status).toBe(201);
    const importedBody = await imported.json() as any;
    expect(importedBody).toMatchObject({
      replayed: false,
      attachment: {
        project: "scrapbook",
        acceptedBy: "token:project-operator",
        sourceRevision: "1111111",
      },
    });
    const serialized = JSON.stringify(importedBody);
    expect(serialized).not.toContain("tok_admin_internal");
    expect(serialized).not.toContain("tokenId");

    const replay = await app.request("/projects/scrapbook/attachment", {
      method: "PUT",
      headers: jsonHeaders("admin"),
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });

    const visible = await app.request("/projects/scrapbook/attachment", {
      headers: bearer("reader"),
    });
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      attachment: {
        snapshot: { contract: { project: "scrapbook" } },
      },
    });

    const hidden = await app.request("/projects/other/attachment", {
      headers: bearer("reader"),
    });
    expect(hidden.status).toBe(403);
  });

  test("serves the accepted attachment through project-scoped MCP", async () => {
    await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: snapshot(),
      sourceRevision: "1111111",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });
    const app = createServerApp(store, {
      authenticator: new FixedAuthenticator(),
    });

    const visible = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("reader"),
      body: JSON.stringify(toolCall(1, "scrapbook")),
    });
    expect(visible.status).toBe(200);
    const visibleText = await visible.text();
    expect(visibleText).toContain("stensibly.project-attachment");
    expect(visibleText).toContain("remain server-owned state");

    const hidden = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("reader"),
      body: JSON.stringify(toolCall(2, "other")),
    });
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toMatchObject({
      error: { message: "Token cannot access project other" },
    });
  });
});

function snapshot(overrides: {
  goal?: string;
  repositories?: string[];
} = {}) {
  return compileProjectContract(renderProjectContract({
    version: 1,
    project: "scrapbook",
    repositories: overrides.repositories ?? ["teamleaderleo/stensibly"],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect", "propose", "create_draft_pr"],
    approvalRequired: ["merge", "deploy"],
    checks: ["bun run typecheck", "bun test"],
    tags: ["coordination"],
    relatedProjects: [],
  }, {
    goal: overrides.goal ?? "Coordinate the scrapbook project.",
    boundaries: "Keep consequential effects approval-gated.",
    evidenceAndHandoff: "Attach checks and leave an explicit next action.",
    escalation: "Escalate missing authority and ambiguous decisions.",
  }));
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    ...bearer(token),
    "content-type": "application/json",
  };
}

function mcpHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
  };
}

function toolCall(id: number, project: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "get_project_attachment",
      arguments: { project },
    },
  };
}
