import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  type GitHubIssueProviderReadService,
  withGitHubIssueProviderReadService,
} from "../src/github-issue-provider-mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";

function issue() {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 525,
    title: "Bake first-party GitHub actions into Stensibly",
    body: "Bounded provider body",
    state: "open",
    labels: ["enhancement"],
    assignees: ["teamleaderleo"],
    createdAt: "2026-07-29T13:16:18.000Z",
    updatedAt: "2026-07-30T00:30:23.000Z",
    providerNodeId: "I_issue_525",
    sourceRevision: "github-rest:I_issue_525:2026-07-30T00:30:23.000Z",
  });
}

describe("remote GitHub issue provider MCP reads", () => {
  test("derives provider identity from the token and enforces project access", async () => {
    const store = new StensiblyStore(":memory:");
    const calls: unknown[] = [];
    const service: GitHubIssueProviderReadService = {
      async listIssues(input) {
        calls.push(input);
        return { issues: [issue()], nextCursor: null };
      },
      async searchIssues(input) {
        calls.push(input);
        return { issues: [issue()], nextCursor: null };
      },
      async getIssue(input) {
        calls.push(input);
        return issue();
      },
    };
    const ledger = withGitHubIssueProviderReadService(
      new SqliteWorkLedger(store),
      service,
    );

    try {
      const reader = createApiToken(store, {
        name: "Stensibly GitHub reader",
        scopes: ["read"],
        projects: ["stensibly"],
      });
      const foreignReader = createApiToken(store, {
        name: "Foreign reader",
        scopes: ["read"],
        projects: ["fieldwork"],
      });
      const writer = createApiToken(store, {
        name: "Write-only token",
        scopes: ["write"],
        projects: ["stensibly"],
      });
      const app = createServerApp(store, { ledger });

      await initialize(app, reader.token, 1);
      const result = await callTool<any>(app, reader.token, 2, "github_get_issue", {
        project: "stensibly",
        repository: "teamleaderleo/stensibly",
        issueNumber: 525,
      });
      expect(result).toMatchObject({
        reference: { externalId: "github:teamleaderleo/stensibly#525" },
        containsIssueBody: false,
      });
      expect(calls).toEqual([{
        project: "stensibly",
        repository: "teamleaderleo/stensibly",
        actorId: `api-token:${reader.id}`,
        clientId: `mcp:api-token:${reader.id}`,
        issueNumber: 525,
      }]);

      const foreign = await mcpRequest(app, foreignReader.token, toolCall(
        3,
        "github_list_issues",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
        },
      ));
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({
        error: { message: "Token cannot access project stensibly" },
        id: 3,
      });

      const missingReadScope = await mcpRequest(app, writer.token, toolCall(
        4,
        "github_search_issues",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          query: "provider",
        },
      ));
      expect(missingReadScope.status).toBe(403);
      expect(await missingReadScope.json()).toMatchObject({
        error: { message: "Token requires read scope" },
        id: 4,
      });
    } finally {
      store.close();
    }
  });

  test("rejects provider qualifiers before search dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let searchCalls = 0;
    const ledger = withGitHubIssueProviderReadService(
      new SqliteWorkLedger(store),
      {
        async listIssues() {
          return { issues: [], nextCursor: null };
        },
        async searchIssues() {
          searchCalls += 1;
          return { issues: [], nextCursor: null };
        },
        async getIssue() {
          return issue();
        },
      },
    );

    try {
      const reader = createApiToken(store, {
        name: "Qualifier fence reader",
        scopes: ["read"],
        projects: ["stensibly"],
      });
      const app = createServerApp(store, { ledger });
      await initialize(app, reader.token, 10);
      const response = await mcpRequest(app, reader.token, toolCall(
        11,
        "github_search_issues",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          query: "repo:teamleaderleo/fieldwork provider",
        },
      ));
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        result?: { isError?: boolean; content?: Array<{ text?: unknown }> };
      };
      expect(payload.result?.isError).toBe(true);
      expect(payload.result?.content?.[0]?.text).toContain(
        "cannot contain provider qualifiers",
      );
      expect(searchCalls).toBe(0);
    } finally {
      store.close();
    }
  });

  test("keeps stable tools registered when the provider service is unavailable", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const reader = createApiToken(store, {
        name: "Unconfigured GitHub reader",
        scopes: ["read"],
        projects: ["stensibly"],
      });
      const app = createServerApp(store);
      await initialize(app, reader.token, 20);
      const response = await mcpRequest(app, reader.token, toolCall(
        21,
        "github_get_issue",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 525,
        },
      ));
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        result?: { isError?: boolean; content?: Array<{ text?: unknown }> };
      };
      expect(payload.result?.isError).toBe(true);
      expect(payload.result?.content?.[0]?.text).toContain(
        "no mounted provider service",
      );
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
      clientInfo: { name: "github-provider-test", version: "0.0.1" },
    },
  });
  expect(response.status).toBe(200);
}

async function callTool<T>(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await mcpRequest(app, token, toolCall(id, name, args));
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }> };
  };
  const first = payload.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("GitHub provider response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
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
