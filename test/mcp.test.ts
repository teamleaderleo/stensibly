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
  test("carries a project brief, work, artifacts, handoffs, blocking, and completion", async () => {
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

      const created = parseTextJson<{ id: string; status: string; project: string }>(
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

      const brief = parseTextJson<{
        project: string;
        counts: { total: number };
        ready: Array<{ id: string }>;
      }>(
        await client.callTool({
          name: "get_brief",
          arguments: { project: "scrapbook", limit: 5 },
        }),
      );
      expect(brief.project).toBe("scrapbook");
      expect(brief.counts.total).toBe(1);
      expect(brief.ready.map((item) => item.id)).toEqual([created.id]);

      const available = parseTextJson<Array<{ id: string }>>(
        await client.callTool({
          name: "list_work",
          arguments: { project: "scrapbook", status: "ready" },
        }),
      );
      expect(available.map((item) => item.id)).toContain(created.id);

      const claimed = parseTextJson<{
        status: string;
        claimedBy: string;
        claimExpiresAt: string;
      }>(
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

      const renewed = parseTextJson<{ claimExpiresAt: string }>(
        await client.callTool({
          name: "renew_claim",
          arguments: {
            id: created.id,
            actor: browserAgent,
            leaseSeconds: 1800,
          },
        }),
      );
      expect(new Date(renewed.claimExpiresAt).getTime()).toBeGreaterThan(
        new Date(claimed.claimExpiresAt).getTime(),
      );

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

      const artifact = parseTextJson<{
        id: string;
        kind: string;
        actorId: string;
        metadata: Record<string, unknown>;
      }>(
        await client.callTool({
          name: "attach_artifact",
          arguments: {
            id: created.id,
            actor: browserAgent,
            kind: "commit",
            label: "MCP implementation",
            uri: "git:teamleaderleo/stensibly@mcp123",
            metadata: { sha: "mcp123" },
            idempotencyKey: "mcp-artifact-1",
          },
        }),
      );
      expect(artifact).toMatchObject({
        kind: "commit",
        actorId: browserAgent.id,
        metadata: { sha: "mcp123" },
      });

      const artifacts = parseTextJson<Array<{ id: string }>>(
        await client.callTool({
          name: "list_artifacts",
          arguments: { id: created.id },
        }),
      );
      expect(artifacts.map((entry) => entry.id)).toEqual([artifact.id]);

      const handedOff = parseTextJson<{
        status: string;
        claimedBy: null;
        summary: string;
        nextAction: string;
      }>(
        await client.callTool({
          name: "handoff_work",
          arguments: {
            id: created.id,
            actor: browserAgent,
            summary: "The protocol path works and needs a human pass.",
            nextAction: "Review the visible wording.",
            toActorId: leo.id,
          },
        }),
      );
      expect(handedOff).toMatchObject({
        status: "ready",
        claimedBy: null,
        summary: "The protocol path works and needs a human pass.",
        nextAction: "Review the visible wording.",
      });

      parseTextJson(
        await client.callTool({
          name: "claim_work",
          arguments: { id: created.id, actor: leo, leaseSeconds: 900 },
        }),
      );

      const blocked = parseTextJson<{
        status: string;
        claimedBy: null;
        summary: string;
      }>(
        await client.callTool({
          name: "block_work",
          arguments: {
            id: created.id,
            actor: leo,
            reason: "Needs a sample client configuration.",
            nextAction: "Add one client example.",
          },
        }),
      );
      expect(blocked).toMatchObject({
        status: "blocked",
        claimedBy: null,
        summary: "Needs a sample client configuration.",
      });

      const blockedClaim = await client.callTool({
        name: "claim_work",
        arguments: { id: created.id, actor: browserAgent, leaseSeconds: 900 },
      });
      expect(blockedClaim.isError).toBe(true);

      const unblocked = parseTextJson<{ status: string; nextAction: string }>(
        await client.callTool({
          name: "unblock_work",
          arguments: {
            id: created.id,
            actor: leo,
            nextAction: "Finish the sample and close the work.",
          },
        }),
      );
      expect(unblocked).toMatchObject({
        status: "ready",
        nextAction: "Finish the sample and close the work.",
      });

      parseTextJson(
        await client.callTool({
          name: "claim_work",
          arguments: { id: created.id, actor: browserAgent, leaseSeconds: 900 },
        }),
      );

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
        artifacts: Array<{ id: string }>;
      }>(
        await client.callTool({
          name: "get_item",
          arguments: { id: created.id },
        }),
      );
      expect(detail.item.status).toBe("done");
      expect(detail.artifacts.map((entry) => entry.id)).toEqual([artifact.id]);
      expect(detail.events.map((event) => event.type)).toEqual([
        "item.created",
        "claim.created",
        "claim.renewed",
        "progress.recorded",
        "artifact.attached",
        "work.handed_off",
        "claim.created",
        "work.blocked",
        "work.unblocked",
        "claim.created",
        "item.completed",
      ]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function parseTextJson<T = unknown>(result: unknown): T {
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
