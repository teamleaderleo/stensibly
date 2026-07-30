import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import {
  type GitHubIssueProviderReadService,
  withGitHubIssueProviderReadService,
} from "../src/github-issue-provider-mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";

interface ToolPayload {
  result?: {
    isError?: boolean;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
}

describe("GitHub provider MCP project slug boundary", () => {
  test("rejects the complete accidental ASCII range before provider dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    const dispatchedProjects: string[] = [];
    const service: GitHubIssueProviderReadService = {
      async listIssues(input) {
        dispatchedProjects.push(input.project);
        return { issues: [], nextCursor: null };
      },
      async searchIssues() {
        return { issues: [], nextCursor: null };
      },
      async getIssue() {
        throw new Error("not used");
      },
    };
    const ledger = withGitHubIssueProviderReadService(
      new SqliteWorkLedger(store),
      service,
    );

    try {
      const reader = createApiToken(store, {
        name: "Unrestricted GitHub slug boundary reader",
        scopes: ["read"],
        projects: null,
      });
      const app = createServerApp(store, { ledger });
      await initialize(app, reader.token, 1);

      const invalidProjects = Array.from(
        { length: "^".charCodeAt(0) - ":".charCodeAt(0) + 1 },
        (_, index) => `a${String.fromCharCode(":".charCodeAt(0) + index)}`,
      );
      for (const [index, project] of invalidProjects.entries()) {
        const payload = await callTool(
          app,
          reader.token,
          index + 2,
          "github_list_issues",
          { project, repository: "teamleaderleo/stensibly" },
        );
        expect(payload.result?.isError).toBe(true);
        expect(payload.result?.content?.[0]?.text).toContain(
          "Use a lowercase project slug",
        );
      }
      expect(dispatchedProjects).toEqual([]);

      for (const [index, project] of ["a", "alpha-1", "alpha_1"].entries()) {
        const payload = await callTool(
          app,
          reader.token,
          invalidProjects.length + index + 2,
          "github_list_issues",
          { project, repository: "teamleaderleo/stensibly" },
        );
        expect(payload.result?.isError).not.toBe(true);
      }
      expect(dispatchedProjects).toEqual(["a", "alpha-1", "alpha_1"]);
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
      clientInfo: { name: "github-slug-boundary-test", version: "0.0.1" },
    },
  });
  expect(response.status).toBe(200);
}

async function callTool(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  const response = await mcpRequest(app, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  return await response.json() as ToolPayload;
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
