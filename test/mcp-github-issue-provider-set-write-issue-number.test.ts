import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  withGitHubIssueProviderSetWriteService,
  type GitHubIssueProviderSetWriteService,
} from "../src/github-issue-provider-set-write-service.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const aboveGitHubIssueCeiling = 2_147_483_648;

describe("public GitHub issue set-write issue number admission", () => {
  test("rejects every issue number above the provider ceiling before dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    let calls = 0;
    const service: GitHubIssueProviderSetWriteService = {
      async addIssueLabels() {
        calls += 1;
        throw new Error("provider dispatch must remain unreachable");
      },
      async removeIssueLabel() {
        calls += 1;
        throw new Error("provider dispatch must remain unreachable");
      },
      async addIssueAssignees() {
        calls += 1;
        throw new Error("provider dispatch must remain unreachable");
      },
      async removeIssueAssignees() {
        calls += 1;
        throw new Error("provider dispatch must remain unreachable");
      },
    };
    const ledger = withGitHubIssueProviderSetWriteService(
      new SqliteWorkLedger(store),
      service,
    );
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const client = new Client(
      { name: "github-set-write-issue-ceiling-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      for (const candidate of cases) {
        const result = await client.callTool({
          name: candidate.name,
          arguments: {
            project,
            repository,
            issueNumber: aboveGitHubIssueCeiling,
            idempotencyKey: `issue-ceiling-${candidate.name}`,
            ...candidate.arguments,
          },
        });
        expect(result.isError).toBe(true);
      }

      expect(calls).toBe(0);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

const cases = [
  {
    name: "github_add_issue_labels",
    arguments: { labels: ["area:github"] },
  },
  {
    name: "github_remove_issue_label",
    arguments: { label: "area:github" },
  },
  {
    name: "github_add_issue_assignees",
    arguments: { assignees: ["teamleaderleo"] },
  },
  {
    name: "github_remove_issue_assignees",
    arguments: { assignees: ["teamleaderleo"] },
  },
] as const;

function writePrincipal(): TokenPrincipal {
  return {
    tokenId: "github-set-write-issue-ceiling-token",
    name: "GitHub set-write issue ceiling test",
    scopes: ["read", "write"],
    projects: [project],
  };
}
