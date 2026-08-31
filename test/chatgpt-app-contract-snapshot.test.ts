import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.ts";
import { createMcpReleaseManifest } from "../src/mcp-release-manifest.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { withHostedMcpProviders } from "./support/hosted-mcp-ledger.ts";

interface ChatGptAppContractSnapshot {
  toolContractFingerprint: string;
}

const snapshotPath = new URL("../docs/chatgpt-app-actions.json", import.meta.url);

function readSnapshot(): ChatGptAppContractSnapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as ChatGptAppContractSnapshot;
}

describe("ChatGPT app published contract snapshot", () => {
  test("requires a checked-in refresh checkpoint for the curated live contract", async () => {
    const snapshot = readSnapshot();
    const store = new StensiblyStore(":memory:");
    const server = createChatGptMcpServer(withHostedMcpProviders(
      new SqliteWorkLedger(store),
    ));
    const client = new Client(
      { name: "chatgpt-contract-snapshot-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const manifest = createMcpReleaseManifest(listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.annotations === undefined
          ? {}
          : { annotations: tool.annotations as Record<string, unknown> }),
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })));

      expect(listed.tools).toHaveLength(20);
      expect(manifest.digest).toBe(snapshot.toolContractFingerprint);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
