import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import {
  type GitHubIssueProviderWriteService,
  withGitHubIssueProviderWriteService,
} from "../src/github-issue-provider-mcp.ts";
import type {
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import {
  callToolEnvelope,
  callToolJson,
  initializeMessage,
  mcpRequest,
  toolCall,
} from "./support/mcp-http.ts";

const client = { clientName: "github-provider-write-test" };

describe("remote GitHub issue provider MCP writes", () => {
  test("derives actor identity and dispatches create, update, and comment writes", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: unknown[] = [];
    const service: GitHubIssueProviderWriteService = {
      async createIssue(input) {
        calls.push(input);
        return receipt("github_create_issue", input.idempotencyKey);
      },
      async updateIssue(input) {
        calls.push(input);
        return receipt("github_update_issue", input.idempotencyKey);
      },
      async addIssueComment(input) {
        calls.push(input);
        return receipt("github_add_issue_comment", input.idempotencyKey);
      },
    };
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      service,
    );

    try {
      const writer = createApiToken(store, {
        name: "Stensibly GitHub writer",
        scopes: ["read", "write"],
        projects: ["stensibly"],
      });
      const app = createServerApp(store, { ledger });
      await initialize(app, writer.token, 1);

      const created = await callToolJson<GitHubProviderReceipt>(
        app,
        writer.token,
        2,
        "github_create_issue",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          title: "Provider write MCP test",
          body: "Bounded body",
          labels: ["area:github"],
          assignees: ["teamleaderleo"],
          idempotencyKey: "gh-write-create-1",
          capabilityGrantId: "grant_issue_write_1",
        },
      );
      expect(created).toMatchObject({
        operation: "github_create_issue",
        idempotencyKey: "gh-write-create-1",
        state: "succeeded",
      });

      const updated = await callToolJson<GitHubProviderReceipt>(
        app,
        writer.token,
        3,
        "github_update_issue",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 921,
          expectedSourceRevision: "github-rest:I_issue_921:rev-1",
          title: "Mounted provider write MCP test",
          state: "open",
          idempotencyKey: "gh-write-update-1",
          approvalId: "approval_issue_write_1",
        },
      );
      expect(updated.operation).toBe("github_update_issue");

      const commented = await callToolJson<GitHubProviderReceipt>(
        app,
        writer.token,
        4,
        "github_add_issue_comment",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 921,
          body: "Exact bounded comment",
          idempotencyKey: "gh-write-comment-1",
        },
      );
      expect(commented.operation).toBe("github_add_issue_comment");

      const tokenIdentity = `api-token:${writer.id}`;
      expect(calls).toEqual([
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          actorId: tokenIdentity,
          clientId: `mcp:${tokenIdentity}`,
          capabilityGrantId: "grant_issue_write_1",
          title: "Provider write MCP test",
          body: "Bounded body",
          labels: ["area:github"],
          assignees: ["teamleaderleo"],
          idempotencyKey: "gh-write-create-1",
        },
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          actorId: tokenIdentity,
          clientId: `mcp:${tokenIdentity}`,
          approvalId: "approval_issue_write_1",
          issueNumber: 921,
          expectedSourceRevision: "github-rest:I_issue_921:rev-1",
          title: "Mounted provider write MCP test",
          state: "open",
          idempotencyKey: "gh-write-update-1",
        },
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          actorId: tokenIdentity,
          clientId: `mcp:${tokenIdentity}`,
          issueNumber: 921,
          body: "Exact bounded comment",
          idempotencyKey: "gh-write-comment-1",
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("requires write scope before dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let calls = 0;
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      {
        async createIssue(input) {
          calls += 1;
          return receipt("github_create_issue", input.idempotencyKey);
        },
        async updateIssue(input) {
          calls += 1;
          return receipt("github_update_issue", input.idempotencyKey);
        },
        async addIssueComment(input) {
          calls += 1;
          return receipt("github_add_issue_comment", input.idempotencyKey);
        },
      },
    );

    try {
      const reader = createApiToken(store, {
        name: "Read-only GitHub token",
        scopes: ["read"],
        projects: ["stensibly"],
      });
      const app = createServerApp(store, { ledger });
      await initialize(app, reader.token, 10);
      const response = await mcpRequest(app, reader.token, toolCall(
        11,
        "github_create_issue",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          title: "Denied write",
          idempotencyKey: "gh-write-denied-1",
        },
      ));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { message: "Token requires write scope" },
        id: 11,
      });
      expect(calls).toBe(0);
    } finally {
      store.close();
    }
  });

  test("keeps stable write tools registered before hosted write composition is mounted", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const writer = createApiToken(store, {
        name: "Unconfigured GitHub writer",
        scopes: ["write"],
        projects: ["stensibly"],
      });
      const app = createServerApp(store);
      await initialize(app, writer.token, 20);
      const result = await callToolEnvelope(
        app,
        writer.token,
        21,
        "github_add_issue_comment",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 921,
          body: "Unavailable provider write",
          idempotencyKey: "gh-write-unavailable-1",
        },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("no mounted provider write service");
    } finally {
      store.close();
    }
  });
});

function receipt(
  operation: GitHubIssueProviderOperation,
  idempotencyKey: string,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: `ghop_${idempotencyKey}`,
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation,
    target: "teamleaderleo/stensibly#921",
    actorId: "actor",
    clientId: "client",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey,
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:01.000Z",
    providerRequestId: "github-request-1",
    result: null,
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T00:00:01.000Z",
      sourceRevision: null,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

async function initialize(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
): Promise<void> {
  const response = await mcpRequest(
    app,
    token,
    initializeMessage(id, client),
  );
  expect(response.status).toBe(200);
}
