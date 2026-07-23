import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "browser-agent", name: "Browser Agent", kind: "agent" as const };

describe("MCP work surface", () => {
  test("carries the work lifecycle through an async ledger", async () => {
    const store = new StensiblyStore(":memory:");
    const server = createMcpServer(new SqliteWorkLedger(store));
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
        "attach_artifact",
        "block_work",
        "claim_work",
        "complete_work",
        "create_item",
        "get_brief",
        "get_item",
        "handoff_work",
        "list_artifacts",
        "list_work",
        "record_event",
        "release_work",
        "renew_claim",
        "unblock_work",
      ]);

      const created = await call<{ id: string; status: string; project: string }>(client, "create_item", {
        project: "scrapbook",
        kind: "task",
        title: "Give the agents somewhere to leave their stuff",
        nextAction: "Claim this through MCP",
        actor: leo,
        idempotencyKey: "mcp-create-1",
      });
      expect(created).toMatchObject({ status: "ready", project: "scrapbook" });

      const brief = await call<{
        project: string;
        counts: { total: number };
        ready: Array<{ id: string }>;
      }>(client, "get_brief", { project: "scrapbook", limit: 5 });
      expect(brief.project).toBe("scrapbook");
      expect(brief.counts.total).toBe(1);
      expect(brief.ready.map((item) => item.id)).toEqual([created.id]);

      const claimed = await call<{
        status: string;
        claimedBy: string;
        claimExpiresAt: string;
      }>(client, "claim_work", {
        id: created.id,
        actor: agent,
        leaseSeconds: 900,
      });
      expect(claimed).toMatchObject({ status: "active", claimedBy: agent.id });

      const renewed = await call<{ claimExpiresAt: string }>(client, "renew_claim", {
        id: created.id,
        actor: agent,
        leaseSeconds: 1800,
      });
      expect(Date.parse(renewed.claimExpiresAt)).toBeGreaterThan(Date.parse(claimed.claimExpiresAt));

      const competing = await client.callTool({
        name: "claim_work",
        arguments: { id: created.id, actor: leo, leaseSeconds: 900 },
      });
      expect(competing.isError).toBe(true);

      const event = await call<{ type: string }>(client, "record_event", {
        id: created.id,
        actor: agent,
        type: "progress.recorded",
        payload: { summary: "The async protocol path works." },
      });
      expect(event.type).toBe("progress.recorded");

      const artifact = await call<{ id: string; kind: string }>(client, "attach_artifact", {
        id: created.id,
        actor: agent,
        kind: "commit",
        label: "MCP implementation",
        uri: "git:teamleaderleo/stensibly@mcp123",
        metadata: { sha: "mcp123" },
        idempotencyKey: "mcp-artifact-1",
      });
      expect(artifact.kind).toBe("commit");

      const handedOff = await call<{ status: string; claimedBy: null }>(client, "handoff_work", {
        id: created.id,
        actor: agent,
        summary: "The protocol path works and needs a human pass.",
        nextAction: "Review the visible wording.",
        toActorId: leo.id,
      });
      expect(handedOff).toMatchObject({ status: "ready", claimedBy: null });

      await call(client, "claim_work", { id: created.id, actor: leo, leaseSeconds: 900 });
      const blocked = await call<{ status: string }>(client, "block_work", {
        id: created.id,
        actor: leo,
        reason: "Needs a sample client configuration.",
        nextAction: "Add one client example.",
      });
      expect(blocked.status).toBe("blocked");

      await call(client, "unblock_work", {
        id: created.id,
        actor: leo,
        nextAction: "Finish the sample and close the work.",
      });
      await call(client, "claim_work", { id: created.id, actor: agent, leaseSeconds: 900 });
      const completed = await call<{ status: string; summary: string }>(client, "complete_work", {
        id: created.id,
        actor: agent,
        summary: "Handled through the protocol.",
      });
      expect(completed).toMatchObject({ status: "done", summary: "Handled through the protocol." });

      const detail = await call<{
        item: { status: string };
        events: Array<{ type: string }>;
        artifacts: Array<{ id: string }>;
      }>(client, "get_item", { id: created.id });
      expect(detail.item.status).toBe("done");
      expect(detail.artifacts.map((entry) => entry.id)).toEqual([artifact.id]);
      expect(detail.events.map((entry) => entry.type)).toContain("item.completed");
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
