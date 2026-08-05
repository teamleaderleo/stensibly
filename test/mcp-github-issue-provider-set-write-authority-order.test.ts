import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";

describe("public GitHub issue set-write authority ordering", () => {
  test("authenticates every action before revealing missing backend capability", async () => {
    for (const candidate of cases) {
      const result = await call(candidate, undefined);
      expect(JSON.stringify(result)).toContain(
        "authenticated remote MCP principal",
      );
      expect(JSON.stringify(result)).not.toContain(
        "no enabled provider set-write service",
      );
    }
  });

  test("checks write scope before revealing missing backend capability", async () => {
    for (const candidate of cases) {
      const result = await call(candidate, readPrincipal());
      expect(JSON.stringify(result)).toContain("require write scope");
      expect(JSON.stringify(result)).not.toContain(
        "no enabled provider set-write service",
      );
    }
  });

  test("checks project access before revealing missing backend capability", async () => {
    for (const candidate of cases) {
      const result = await call(candidate, foreignProjectPrincipal());
      expect(JSON.stringify(result)).toContain(
        "outside this principal's project scope",
      );
      expect(JSON.stringify(result)).not.toContain(
        "no enabled provider set-write service",
      );
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

async function call(
  candidate: typeof cases[number],
  principal: TokenPrincipal | undefined,
) {
  const store = new StensiblyStore(":memory:");
  const server = createMcpServer(
    new SqliteWorkLedger(store),
    principal ? { principal } : {},
  );
  const client = new Client(
    { name: `set-write-authority-${candidate.name}`, version: "0.0.1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({
      name: candidate.name,
      arguments: {
        project,
        repository,
        issueNumber: 525,
        idempotencyKey: `authority-order-${candidate.name}`,
        ...candidate.arguments,
      },
    });
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
}

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "set-write-read-only-token",
    name: "Set-write read-only test",
    scopes: ["read"],
    projects: [project],
  };
}

function foreignProjectPrincipal(): TokenPrincipal {
  return {
    tokenId: "set-write-foreign-project-token",
    name: "Set-write foreign-project test",
    scopes: ["read", "write"],
    projects: ["another-project"],
  };
}
