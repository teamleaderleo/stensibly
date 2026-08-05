import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  withGitHubIssueProviderReadService,
  withGitHubIssueProviderWriteService,
  type GitHubIssueProviderReadService,
  type GitHubIssueProviderWriteService,
} from "../src/github-issue-provider-mcp.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const aboveGitHubIssueCeiling = 2_147_483_648;
const sourceRevision = `sha256:${"a".repeat(64)}`;

describe("public GitHub issue number ceiling", () => {
  test("rejects impossible get, update, and comment targets before service dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let readCalls = 0;
    let writeCalls = 0;
    const reads: GitHubIssueProviderReadService = {
      async listIssues() {
        throw new Error("outside this control");
      },
      async searchIssues() {
        throw new Error("outside this control");
      },
      async getIssue() {
        readCalls += 1;
        throw new Error("provider read must remain unreachable");
      },
    };
    const writes: GitHubIssueProviderWriteService = {
      async createIssue() {
        throw new Error("outside this control");
      },
      async updateIssue() {
        writeCalls += 1;
        throw new Error("provider update must remain unreachable");
      },
      async addIssueComment() {
        writeCalls += 1;
        throw new Error("provider comment must remain unreachable");
      },
    };
    const ledger = withGitHubIssueProviderWriteService(
      withGitHubIssueProviderReadService(new SqliteWorkLedger(store), reads),
      writes,
    );
    const server = createMcpServer(ledger, { principal: principal() });
    const client = new Client(
      { name: "github-issue-number-ceiling-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const getResult = await client.callTool({
        name: "github_get_issue",
        arguments: {
          project,
          repository,
          issueNumber: aboveGitHubIssueCeiling,
        },
      });
      expect(getResult.isError).toBe(true);

      const updateResult = await client.callTool({
        name: "github_update_issue",
        arguments: {
          project,
          repository,
          issueNumber: aboveGitHubIssueCeiling,
          expectedSourceRevision: sourceRevision,
          title: "must remain unreachable",
          idempotencyKey: "public-issue-number-ceiling-update",
        },
      });
      expect(updateResult.isError).toBe(true);

      const commentResult = await client.callTool({
        name: "github_add_issue_comment",
        arguments: {
          project,
          repository,
          issueNumber: aboveGitHubIssueCeiling,
          body: "must remain unreachable",
          idempotencyKey: "public-issue-number-ceiling-comment",
        },
      });
      expect(commentResult.isError).toBe(true);

      expect(readCalls).toBe(0);
      expect(writeCalls).toBe(0);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function principal(): TokenPrincipal {
  return {
    tokenId: "github-issue-number-ceiling-token",
    name: "GitHub issue number ceiling test",
    scopes: ["read", "write"],
    projects: [project],
  };
}
