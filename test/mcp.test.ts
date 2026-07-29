import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "browser-agent", name: "Browser Agent", kind: "agent" as const };

describe("MCP work surface", () => {
  test("carries the generation-fenced work lifecycle through an async ledger", async () => {
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
        "get_github_project_context",
        "get_item",
        "get_operation_receipt",
        "get_project_attachment",
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

      const created = await call<{
        id: string;
        status: string;
        project: string;
        claimGeneration: number;
      }>(client, "create_item", {
        project: "scrapbook",
        kind: "task",
        title: "Give the agents somewhere to leave their stuff",
        nextAction: "Claim this through MCP",
        actor: leo,
        idempotencyKey: "mcp-create-1",
      });
      expect(created).toMatchObject({
        status: "ready",
        project: "scrapbook",
        claimGeneration: 0,
      });

      const brief = await call<{
        project: string;
        counts: { total: number };
        ready: Array<{ id: string }>;
      }>(client, "get_brief", { project: "scrapbook", limit: 5 });
      expect(brief.project).toBe("scrapbook");
      expect(brief.counts.total).toBe(1);
      expect(brief.ready[0]?.id).toBe(created.id);

      const claimed = await call<{
        status: string;
        claim: { holder: { id: string }; generation: number };
      }>(client, "claim_work", {
        id: created.id,
        actor: agent,
        leaseSeconds: 120,
        idempotencyKey: "mcp-claim-1",
      });
      expect(claimed.status).toBe("claimed");
      expect(claimed.claim.holder.id).toBe(agent.id);
      expect(claimed.claim.generation).toBe(1);

      const renewed = await call<{
        claim: { generation: number };
      }>(client, "renew_claim", {
        id: created.id,
        actor: agent,
        expectedClaimGeneration: claimed.claim.generation,
        leaseSeconds: 120,
        idempotencyKey: "mcp-renew-1",
      });
      expect(renewed.claim.generation).toBe(2);

      const handedOff = await call<{
        status: string;
        claimGeneration: number;
      }>(client, "handoff_work", {
        id: created.id,
        actor: agent,
        expectedClaimGeneration: renewed.claim.generation,
        summary: "Browser agent left a handoff.",
        nextAction: "Leo should reclaim this.",
        toActorId: leo.id,
        idempotencyKey: "mcp-handoff-1",
      });
      expect(handedOff).toMatchObject({ status: "ready", claimGeneration: 3 });

      const leoClaim = await call<{
        claim: { generation: number };
      }>(client, "claim_work", {
        id: created.id,
        actor: leo,
        leaseSeconds: 120,
        idempotencyKey: "mcp-claim-2",
      });
      expect(leoClaim.claim.generation).toBe(4);

      const blocked = await call<{
        status: string;
        claimGeneration: number;
      }>(client, "block_work", {
        id: created.id,
        actor: leo,
        expectedClaimGeneration: leoClaim.claim.generation,
        reason: "Need a better shelf.",
        nextAction: "Find the shelf.",
        idempotencyKey: "mcp-block-1",
      });
      expect(blocked).toMatchObject({ status: "blocked", claimGeneration: 5 });

      const unblocked = await call<{
        status: string;
        claimGeneration: number;
      }>(client, "unblock_work", {
        id: created.id,
        actor: leo,
        expectedClaimGeneration: blocked.claimGeneration,
        nextAction: "Use the new shelf.",
        idempotencyKey: "mcp-unblock-1",
      });
      expect(unblocked).toMatchObject({ status: "ready", claimGeneration: 6 });

      const finalClaim = await call<{
        claim: { generation: number };
      }>(client, "claim_work", {
        id: created.id,
        actor: agent,
        leaseSeconds: 120,
        idempotencyKey: "mcp-claim-3",
      });
      expect(finalClaim.claim.generation).toBe(7);

      const completed = await call<{
        status: string;
        claimGeneration: number;
      }>(client, "complete_work", {
        id: created.id,
        actor: agent,
        expectedClaimGeneration: finalClaim.claim.generation,
        summary: "The shelf is ready.",
        idempotencyKey: "mcp-complete-1",
      });
      expect(completed).toMatchObject({ status: "done", claimGeneration: 8 });
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const text = result.content.find((entry) => entry.type === "text");
  if (!text || text.type !== "text") throw new Error("MCP tool did not return text");
  return JSON.parse(text.text) as T;
}
