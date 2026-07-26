import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "surface-agent", name: "Surface Agent", kind: "agent" as const };

describe("item control surface parity", () => {
  test("REST and MCP return the same canonical control view", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const app = createServerApp(store);
    const server = createMcpServer(ledger);
    const client = new Client(
      { name: "item-control-surface-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const item = await ledger.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Compare canonical control surfaces",
        summary: "Use one server-owned projection.",
        nextAction: "Claim and compare it.",
        priority: 70,
        actor: leo,
      });
      const claimed = await ledger.claimWork({
        id: item.id,
        actor: agent,
        leaseSeconds: 900,
      });

      const restClaimed = await restDetail(app, item.id);
      const mcpClaimed = await call<{ control: unknown }>(client, "get_item", { id: item.id });
      expect(mcpClaimed.control).toEqual(restClaimed.control);
      expect(restClaimed.control).toMatchObject({
        authority: {
          state: "live",
          holderActorId: agent.id,
          generation: claimed.claimGeneration,
          allowedOperations: ["renew", "release", "complete", "handoff", "block"],
        },
        responsibility: { actorId: agent.id },
      });

      await ledger.handoffWork({
        id: item.id,
        actor: agent,
        expectedClaimGeneration: claimed.claimGeneration,
        summary: "The projection matches across both transports.",
        nextAction: "Leo should review the result.",
        toActorId: leo.id,
      });
      const restHandedOff = await restDetail(app, item.id);
      const mcpHandedOff = await call<{ control: unknown }>(client, "get_item", { id: item.id });
      expect(mcpHandedOff.control).toEqual(restHandedOff.control);
      expect(restHandedOff.control).toMatchObject({
        authority: {
          state: "superseded",
          holderActorId: null,
          allowedOperations: ["claim", "complete", "handoff", "block"],
        },
        responsibility: {
          actorId: leo.id,
          summary: "The projection matches across both transports.",
          nextAction: "Leo should review the result.",
        },
      });
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

async function restDetail(
  app: ReturnType<typeof createServerApp>,
  itemId: string,
): Promise<{ control: any }> {
  const response = await app.request(`/api/v1/items/${encodeURIComponent(itemId)}`);
  expect(response.status).toBe(200);
  return await response.json() as { control: any };
}

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(textContent(result));
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
