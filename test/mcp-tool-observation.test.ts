import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import type { McpToolObservation } from "../src/mcp-tool-observation.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { withHostedMcpProviders } from "./support/hosted-mcp-ledger.ts";

describe("MCP GitHub tool observations", () => {
  test("records bounded digests and timing without argument or result content", async () => {
    const observations: McpToolObservation[] = [];
    const store = new StensiblyStore(":memory:");
    const server = createMcpServer(
      withHostedMcpProviders(new SqliteWorkLedger(store)),
      {
        requestId: "rpc-7",
        onToolCall: (observation) => {
          observations.push(observation);
        },
      },
      { exposureProfile: "published_default" },
    );
    const client = new Client(
      { name: "mcp-observation-test", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: "github_repo_health",
        arguments: {
          project: "missing-project",
          repository: "teamleaderleo/stensibly",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(observations).toHaveLength(1);
      expect(observations[0]).toEqual({
        event: "mcp.tool.complete",
        requestId: "rpc-7",
        toolName: "github_repo_health",
        outcome: expect.stringMatching(/^(success|failure)$/),
        durationMs: expect.any(Number),
        argumentsSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        resultSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(observations)).not.toContain("teamleaderleo/stensibly");
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
