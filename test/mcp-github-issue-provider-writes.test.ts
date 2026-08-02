import { describe, expect, test } from "bun:test";
import {
  withGitHubIssueProviderWriteService,
  type GitHubIssueProviderWriteService,
} from "../src/github-issue-provider-mcp.ts";
import type {
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { buildTestApp } from "./helpers/http-app.ts";

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function parseRpc(text: string) {
  return JSON.parse(text) as {
    result?: {
      tools?: Array<{
        name: string;
        annotations?: Record<string, unknown>;
      }>;
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
}

describe("GitHub issue provider MCP writes", () => {
  test("publishes the three stable governed write actions", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      fakeWriteService([]),
    );
    const app = buildTestApp({
      ledger,
      authenticateMcpRequest: async () => ({
        workspace: "default",
        tokenId: "token-write",
        scope: "write",
        projects: ["stensibly"],
      }),
    });

    try {
      const response = await app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpc(1, "tools/list")),
      });
      expect(response.status).toBe(200);
      const payload = parseRpc(await response.text());
      const tools = new Map(
        (payload.result?.tools ?? []).map((tool) => [tool.name, tool]),
      );
      expect(tools.get("github_create_issue")?.annotations).toMatchObject({
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(tools.get("github_update_issue")?.annotations).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
      });
      expect(tools.get("github_add_issue_comment")?.annotations).toMatchObject({
        destructiveHint: false,
        idempotentHint: true,
      });
    } finally {
      store.close();
    }
  });

  test("derives principal identity and preserves exact grant, approval, revision, and idempotency inputs", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: unknown[] = [];
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      fakeWriteService(calls),
    );
    const app = buildTestApp({
      ledger,
      authenticateMcpRequest: async () => ({
        workspace: "default",
        tokenId: "token-write-7",
        scope: "write",
        projects: ["stensibly"],
      }),
    });

    try {
      const create = await callTool(app, 1, "github_create_issue", {
        project: "stensibly",
        repository: "teamleaderleo/stensibly",
        title: "Create through Stensibly",
        body: "Bounded body",
        labels: ["area:github"],
        assignees: ["teamleaderleo"],
        capabilityGrantId: "grant_issue_write_1",
        approvalId: "approval_issue_write_1",
        idempotencyKey: "mcp-create-1",
      });
      expect(create.result?.isError).toBe(false);

      const update = await callTool(app, 2, "github_update_issue", {
        project: "stensibly",
        repository: "teamleaderleo/stensibly",
        issueNumber: 921,
        expectedSourceRevision: "github-rest:I_921:rev-1",
        title: "Updated through Stensibly",
        state: "closed",
        stateReason: "completed",
        capabilityGrantId: "grant_issue_write_1",
        approvalId: "approval_issue_write_1",
        idempotencyKey: "mcp-update-1",
      });
      expect(update.result?.isError).toBe(false);

      const comment = await callTool(app, 3, "github_add_issue_comment", {
        project: "stensibly",
        repository: "teamleaderleo/stensibly",
        issueNumber: 921,
        body: "Comment through Stensibly",
        capabilityGrantId: "grant_issue_write_1",
        approvalId: "approval_issue_write_1",
        idempotencyKey: "mcp-comment-1",
      });
      expect(comment.result?.isError).toBe(false);

      expect(calls).toEqual([
        {
          operation: "create",
          input: {
            project: "stensibly",
            repository: "teamleaderleo/stensibly",
            actorId: "api-token:token-write-7",
            clientId: "mcp:api-token:token-write-7",
            capabilityGrantId: "grant_issue_write_1",
            approvalId: "approval_issue_write_1",
            title: "Create through Stensibly",
            body: "Bounded body",
            labels: ["area:github"],
            assignees: ["teamleaderleo"],
            idempotencyKey: "mcp-create-1",
          },
        },
        {
          operation: "update",
          input: {
            project: "stensibly",
            repository: "teamleaderleo/stensibly",
            actorId: "api-token:token-write-7",
            clientId: "mcp:api-token:token-write-7",
            capabilityGrantId: "grant_issue_write_1",
            approvalId: "approval_issue_write_1",
            issueNumber: 921,
            expectedSourceRevision: "github-rest:I_921:rev-1",
            title: "Updated through Stensibly",
            state: "closed",
            stateReason: "completed",
            idempotencyKey: "mcp-update-1",
          },
        },
        {
          operation: "comment",
          input: {
            project: "stensibly",
            repository: "teamleaderleo/stensibly",
            actorId: "api-token:token-write-7",
            clientId: "mcp:api-token:token-write-7",
            capabilityGrantId: "grant_issue_write_1",
            approvalId: "approval_issue_write_1",
            issueNumber: 921,
            body: "Comment through Stensibly",
            idempotencyKey: "mcp-comment-1",
          },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("rejects read-only and foreign-project principals before write dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: unknown[] = [];
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      fakeWriteService(calls),
    );
    try {
      for (const principal of [
        {
          workspace: "default",
          tokenId: "token-read",
          scope: "read" as const,
          projects: ["stensibly"],
        },
        {
          workspace: "default",
          tokenId: "token-foreign",
          scope: "write" as const,
          projects: ["other-project"],
        },
      ]) {
        const app = buildTestApp({
          ledger,
          authenticateMcpRequest: async () => principal,
        });
        const payload = await callTool(app, 1, "github_add_issue_comment", {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 921,
          body: "Must not dispatch",
          capabilityGrantId: "grant_issue_write_1",
          approvalId: "approval_issue_write_1",
          idempotencyKey: `denied-${principal.tokenId}`,
        });
        expect(payload.error?.code).toBe(-32001);
      }
      expect(calls).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("returns a typed tool failure when the hosted write service is not mounted", async () => {
    const store = new StensiblyStore(":memory:");
    const app = buildTestApp({
      ledger: new SqliteWorkLedger(store),
      authenticateMcpRequest: async () => ({
        workspace: "default",
        tokenId: "token-write",
        scope: "write",
        projects: ["stensibly"],
      }),
    });
    try {
      const payload = await callTool(app, 1, "github_create_issue", {
        project: "stensibly",
        repository: "teamleaderleo/stensibly",
        title: "Unavailable write",
        idempotencyKey: "unavailable-write-1",
      });
      expect(payload.result?.isError).toBe(true);
      expect(payload.result?.content?.[0]?.text).toContain(
        "no mounted governed write service",
      );
    } finally {
      store.close();
    }
  });

  test("validates malformed write inputs before service dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: unknown[] = [];
    const ledger = withGitHubIssueProviderWriteService(
      new SqliteWorkLedger(store),
      fakeWriteService(calls),
    );
    const app = buildTestApp({
      ledger,
      authenticateMcpRequest: async () => ({
        workspace: "default",
        tokenId: "token-write",
        scope: "write",
        projects: ["stensibly"],
      }),
    });
    try {
      for (const [name, args] of [
        ["github_create_issue", {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          title: "",
          idempotencyKey: "invalid-create",
        }],
        ["github_update_issue", {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 0,
          expectedSourceRevision: "revision",
          idempotencyKey: "invalid-update",
        }],
        ["github_add_issue_comment", {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 921,
          body: "",
          idempotencyKey: "invalid-comment",
        }],
      ] as const) {
        const payload = await callTool(app, 1, name, args);
        expect(payload.error?.code).toBe(-32602);
      }
      expect(calls).toEqual([]);
    } finally {
      store.close();
    }
  });
});

async function callTool(
  app: ReturnType<typeof buildTestApp>,
  id: number,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpc(id, "tools/call", { name, arguments: args })),
  });
  expect(response.status).toBe(200);
  return parseRpc(await response.text());
}

function fakeWriteService(calls: unknown[]): GitHubIssueProviderWriteService {
  return {
    async createIssue(input) {
      calls.push({ operation: "create", input });
      return receipt("github_create_issue", input.idempotencyKey);
    },
    async updateIssue(input) {
      calls.push({ operation: "update", input });
      return receipt("github_update_issue", input.idempotencyKey);
    },
    async addIssueComment(input) {
      calls.push({ operation: "comment", input });
      return receipt("github_add_issue_comment", input.idempotencyKey);
    },
  };
}

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
    actorId: "api-token:token-write-7",
    clientId: "mcp:api-token:token-write-7",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: "grant_issue_write_1",
    approvalId: "approval_issue_write_1",
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
