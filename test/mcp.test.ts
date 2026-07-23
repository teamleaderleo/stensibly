import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const browserAgent = {
  id: "browser-agent",
  name: "Browser Agent",
  kind: "agent" as const,
};

describe("MCP work surface", () => {
  test("runs a complete create, claim, event, and completion loop", async () => {
    const store = new StensiblyStore(":memory:");
    const server = createMcpServer(store);
    const client = new Client(
      { name: "stensibly-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "claim_work",
        "complete_work",
        "create_item",
        "get_item",
        "list_work",
        "record_event",
        "release_work",
      ]);

      const created = parseTextJson<{
        id: string;
        status: string;
        project: string;
      }>(
        await client.callTool({
          name: "create_item",
          arguments: {
            project: "scrapbook",
            kind: "task",
            title: "Give the agents somewhere to leave their stuff",
            nextAction: "Claim this through MCP",
            actor: leo,
            idempotencyKey: "mcp-create-1",
          },
        }),
      );
      expect(created.status).toBe("ready");
      expect(created.project).toBe("scrapbook");

      const available = parseTextJson<Array<{ id: string }>>(
        await client.callTool({
          name: "list_work",
          arguments: { project: "scrapbook", status: "ready" },
        }),
      );
      expect(available.map((item) => item.id)).toContain(created.id);

      const claimed = parseTextJson<{ status: string; claimedBy: string }>(
        await client.callTool({
          name: "claim_work",
          arguments: {
            id: created.id,
            actor: browserAgent,
            leaseSeconds: 900,
          },
        }),
      );
      expect(claimed.status).toBe("active");
      expect(claimed.claimedBy).toBe(browserAgent.id);

      const competingClaim = await client.callTool({
        name: "claim_work",
        arguments: {
          id: created.id,
          actor: leo,
          leaseSeconds: 900,
        },
      });
      expect(competingClaim.isError).toBe(true);

      const recorded = parseTextJson<{ type: string }>(
        await client.callTool({
          name: "record_event",
          arguments: {
            id: created.id,
            actor: browserAgent,
            type: "progress.recorded",
            payload: { summary: "The scrapbook has an MCP door now." },
          },
        }),
      );
      expect(recorded.type).toBe("progress.recorded");

      const completed = parseTextJson<{ status: string; summary: string }>(
        await client.callTool({
          name: "complete_work",
          arguments: {
            id: created.id,
            actor: browserAgent,
            summary: "Handled through the protocol.",
          },
        }),
      );
      expect(completed.status).toBe("done");
      expect(completed.summary).toBe("Handled through the protocol.");

      const detail = parseTextJson<{
        item: { id: string; status: string };
        events: Array<{ type: string }>;
      }>(
        await client.callTool({
          name: "get_item",
          arguments: { id: created.id },
        }),
      );
      expect(detail.item.status).toBe("done");
      expect(detail.events.map((event) => event.type)).toEqual([
        "item.created",
        "claim.created",
        "progress.recorded",
        "item.completed",
      ]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function parseTextJson<T>(result: unknown): T {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP result had no content");
  }

  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP result did not contain JSON text");
  }

  return JSON.parse(first.text) as T;
}
