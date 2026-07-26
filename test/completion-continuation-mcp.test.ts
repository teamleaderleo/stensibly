import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };

type CompletionResult = {
  item: { status: string; summary: string };
  continuations: Array<{ status: string; sourceItemId: string }>;
};

describe("atomic MCP completion continuations", () => {
  test("returns the completed item and durable proposals from complete_work", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Complete and suggest a follow-up through MCP",
      priority: 65,
      actor: agent,
    });
    const server = createMcpServer(ledger);
    const client = new Client(
      { name: "completion-continuation-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const input = {
        id: item.id,
        actor: agent,
        expectedClaimGeneration: item.claimGeneration,
        summary: "Completed with an atomic proposal.",
        continuations: [{
          title: "Review the completed MCP work",
          rationale: "A human decision should survive this model turn.",
          instruction: "Review the completed item and approve the next action.",
          action: { kind: "request_decision", decisionType: "mcp_completion_review" },
          deliveryMode: "current_conversation",
        }],
        idempotencyKey: "mcp-complete-with-continuation",
      };

      const result = await call<CompletionResult>(client, "complete_work", input);
      expect(result.item).toMatchObject({
        status: "done",
        summary: "Completed with an atomic proposal.",
      });
      expect(result.continuations).toHaveLength(1);
      expect(result.continuations[0]).toMatchObject({
        status: "proposed",
        sourceItemId: item.id,
      });
      const replay = await call<CompletionResult>(client, "complete_work", input);
      expect(replay).toEqual(result);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

async function call<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(textContent(result));
  }
  return JSON.parse(textContent(result)) as T;
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP result had no content");
  }
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP result did not contain text");
  }
  return first.text;
}
