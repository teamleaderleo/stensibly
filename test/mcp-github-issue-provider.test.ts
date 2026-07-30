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
import {
  callToolEnvelope,
  callToolJson,
  initializeMessage,
  mcpRequest,
  toolCall,
} from "./support/mcp-http.ts";

const githubProviderClient = { clientName: "github-provider-test" };

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
      const result = await callToolJson<{
        reference: { externalId: string };
        containsIssueBody: boolean;
      }>(app, reader.token, 2, "github_get_issue", {
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
      const result = await callToolEnvelope(
        app,
        reader.token,
        11,
        "github_search_issues",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          query: "repo:teamleaderleo/fieldwork provider",
        },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("cannot contain provider qualifiers");
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
      const result = await callToolEnvelope(
        app,
        reader.token,
        21,
        "github_get_issue",
        {
          project: "stensibly",
          repository: "teamleaderleo/stensibly",
          issueNumber: 525,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("no mounted provider service");
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
  const response = await mcpRequest(
    app,
    token,
    initializeMessage(id, githubProviderClient),
  );
  expect(response.status).toBe(200);
}
