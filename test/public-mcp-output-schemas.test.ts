import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.ts";
import { artifactKinds } from "../src/artifacts.ts";
import { publicMcpArtifactKinds } from "../src/public-mcp-output-schemas.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "schema-agent", name: "Schema Agent", kind: "agent" } as const;

describe("precise public coordination output schemas", () => {
  test("keeps the Worker-safe artifact enum aligned with the ledger contract", () => {
    expect(publicMcpArtifactKinds).toEqual(artifactKinds);
  });

  test("validate the exact task-to-dispatch-to-context result loop", async () => {
    const store = new StensiblyStore(":memory:");
    const server = createChatGptMcpServer(new SqliteWorkLedger(store));
    const client = new Client(
      { name: "public-output-schema-test", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const first = data(await client.callTool({
        name: "create_item",
        arguments: {
          project: "schema-proof",
          title: "Prove precise public outputs",
          priority: 80,
          actor,
          idempotencyKey: "schema-create-1",
        },
      }));
      const firstId = stringField(first, "id");

      expect(data(await client.callTool({
        name: "attach_artifact",
        arguments: {
          id: firstId,
          actor,
          kind: "commit",
          label: "Candidate",
          uri: "urn:git:commit:0123456789abcdef",
          metadata: { source: "schema-test" },
          idempotencyKey: "schema-artifact-1",
        },
      }))).toMatchObject({ itemId: firstId, kind: "commit" });

      const claimed = data(await client.callTool({
        name: "claim_work",
        arguments: {
          id: firstId,
          actor,
          leaseSeconds: 900,
          idempotencyKey: "schema-claim-1",
        },
      }));
      expect(data(await client.callTool({
        name: "handoff_work",
        arguments: {
          id: firstId,
          actor,
          expectedClaimGeneration: numberField(claimed, "claimGeneration"),
          summary: "Schema-valid handoff",
          nextAction: "Continue from the canonical context packet",
          idempotencyKey: "schema-handoff-1",
        },
      }))).toMatchObject({ id: firstId, status: "ready" });

      const blockedItem = data(await client.callTool({
        name: "create_item",
        arguments: {
          project: "schema-proof",
          title: "Exercise block lifecycle",
          actor,
          idempotencyKey: "schema-create-2",
        },
      }));
      const blockedId = stringField(blockedItem, "id");
      const blockedClaim = data(await client.callTool({
        name: "claim_work",
        arguments: {
          id: blockedId,
          actor,
          leaseSeconds: 900,
          idempotencyKey: "schema-claim-2",
        },
      }));
      const blocked = data(await client.callTool({
        name: "block_work",
        arguments: {
          id: blockedId,
          actor,
          expectedClaimGeneration: numberField(blockedClaim, "claimGeneration"),
          reason: "Exercise the output schema",
          idempotencyKey: "schema-block-2",
        },
      }));
      expect(data(await client.callTool({
        name: "unblock_work",
        arguments: {
          id: blockedId,
          actor,
          expectedClaimGeneration: numberField(blocked, "claimGeneration"),
          idempotencyKey: "schema-unblock-2",
        },
      }))).toMatchObject({ id: blockedId, status: "ready" });

      const dispatchItem = data(await client.callTool({
        name: "create_item",
        arguments: {
          project: "schema-proof",
          title: "Dispatch exact machine query",
          actor,
          idempotencyKey: "schema-create-3",
        },
      }));
      const dispatchId = stringField(dispatchItem, "id");
      const dispatched = data(await client.callTool({
        name: "dispatch_work",
        arguments: {
          project: "schema-proof",
          itemId: dispatchId,
          expectedClaimGeneration: numberField(dispatchItem, "claimGeneration"),
          actor,
          runnerType: "glaeda",
          runnerProfile: "owned-workstation-query",
          runnerProfileVersion: "1",
          executionEnvelope: executionEnvelope(),
          leaseSeconds: 900,
          maxAttempts: 2,
          retryBackoffSeconds: 30,
          idempotencyKey: "schema-dispatch-3",
        },
      }));
      expect(dispatched).toMatchObject({
        status: "dispatched",
        item: { id: dispatchId, status: "active" },
        run: { itemId: dispatchId, runnerType: "glaeda", status: "queued" },
      });

      expect(data(await client.callTool({
        name: "get_runner_context",
        arguments: { id: dispatchId },
      }))).toMatchObject({
        version: 1,
        item: { id: dispatchId },
        intent: { objective: "Dispatch exact machine query" },
        runs: [expect.objectContaining({ id: stringField(recordField(dispatched, "run"), "id") })],
      });
      expect(data(await client.callTool({
        name: "get_brief",
        arguments: { project: "schema-proof", limit: 10 },
      }))).toMatchObject({ project: "schema-proof", counts: { total: 3 } });
      expect(data(await client.callTool({
        name: "list_work",
        arguments: { project: "schema-proof" },
      }))).toHaveLength(3);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function data(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  expect(result.isError).not.toBe(true);
  const structured = result.structuredContent;
  if (!isRecord(structured) || !("data" in structured)) {
    throw new Error("Missing structured data");
  }
  return structured.data;
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value[key])) throw new Error(`Missing record field: ${key}`);
  return value[key];
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string") {
    throw new Error(`Missing string field: ${key}`);
  }
  return value[key];
}

function numberField(value: unknown, key: string): number {
  if (!isRecord(value) || typeof value[key] !== "number") {
    throw new Error(`Missing number field: ${key}`);
  }
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function executionEnvelope() {
  return {
    schemaVersion: 1,
    objective: "Query the exact owned workstation state",
    scopeClass: "atomic",
    estimate: { lowMinutes: 1, likelyMinutes: 2, highMinutes: 5, confidence: 0.8 },
    budget: { expectedMessages: 2, expectedToolCalls: 3, expectedReviewMinutes: 1 },
    boundaries: { softCheckpointMinutes: 2, forcedHandoffMinutes: 5, hardRecoveryMinutes: 10 },
    completion: {
      requiredOutputs: ["Bounded receipt"],
      verificationRequired: true,
      continuationStateRequired: true,
      acceptanceChecks: ["Exact task and machine identity are present"],
    },
    durableState: {
      accessClass: "project",
      retentionClass: "standard",
      redactionRequired: true,
      deleteAfter: null,
    },
  };
}
