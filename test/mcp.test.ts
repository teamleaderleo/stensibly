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
        "edit_continuation",
        "get_brief",
        "get_continuation",
        "get_item",
        "get_runner_context",
        "handoff_work",
        "list_artifacts",
        "list_continuation_inbox",
        "list_continuations",
        "list_work",
        "propose_continuation",
        "queue_continuation_for_supervisor",
        "record_event",
        "release_work",
        "renew_claim",
        "resolve_continuation",
        "run_continuation_supervisor_policy",
        "survey_workspace",
        "unblock_work",
      ]);

      const created = await call<{ id: string; status: string; project: string }>(
        client,
        "create_item",
        {
          project: "scrapbook",
          kind: "task",
          title: "Give the agents somewhere to leave their stuff",
          nextAction: "Claim this through MCP",
          actor: leo,
          idempotencyKey: "mcp-create-1",
        },
      );
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
        idempotencyKey: "mcp-claim-1",
      });
      expect(claimed.status).toBe("active");
      expect(claimed.claimedBy).toBe(agent.id);
      expect(Date.parse(claimed.claimExpiresAt)).toBeGreaterThan(Date.now());

      const attached = await call<{ itemId: string; kind: string; uri: string }>(
        client,
        "attach_artifact",
        {
          id: created.id,
          actor: agent,
          kind: "commit",
          label: "Scrapbook foundation",
          uri: "git:repo@abc123",
          metadata: { sha: "abc123" },
          idempotencyKey: "mcp-artifact-1",
        },
      );
      expect(attached).toMatchObject({ itemId: created.id, kind: "commit" });

      const recorded = await call<{ type: string; payload: { note: string } }>(
        client,
        "record_event",
        {
          id: created.id,
          actor: agent,
          type: "progress.recorded",
          payload: { note: "MCP can write durable history." },
          idempotencyKey: "mcp-event-1",
        },
      );
      expect(recorded).toMatchObject({
        type: "progress.recorded",
        payload: { note: "MCP can write durable history." },
      });

      const handedOff = await call<{
        status: string;
        summary: string;
        nextAction: string;
        claimedBy: string | null;
      }>(client, "handoff_work", {
        id: created.id,
        actor: agent,
        summary: "The shared MCP surface is wired up.",
        nextAction: "Let another agent inspect the artifact and continue.",
        toActorId: "next-agent",
        idempotencyKey: "mcp-handoff-1",
      });
      expect(handedOff).toMatchObject({
        status: "ready",
        summary: "The shared MCP surface is wired up.",
        nextAction: "Let another agent inspect the artifact and continue.",
        claimedBy: null,
      });

      const artifacts = await call<Array<{ id: string; uri: string }>>(
        client,
        "list_artifacts",
        { id: created.id },
      );
      expect(artifacts.map((artifact) => artifact.uri)).toEqual(["git:repo@abc123"]);

      const detail = await call<{
        item: { id: string; status: string };
        events: Array<{ type: string }>;
        artifacts: Array<{ uri: string }>;
      }>(client, "get_item", { id: created.id });
      expect(detail.item.status).toBe("ready");
      expect(detail.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "item.created",
        "claim.created",
        "artifact.attached",
        "progress.recorded",
        "work.handed_off",
      ]));
      expect(detail.artifacts.map((artifact) => artifact.uri)).toEqual(["git:repo@abc123"]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  if (first?.type !== "text" || !first.text) throw new Error(`Tool ${name} returned no text`);
  return JSON.parse(first.text) as T;
}
