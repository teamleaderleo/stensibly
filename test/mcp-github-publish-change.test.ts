import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withGitHubPublishChangeService } from "../src/github-publish-change-operation.js";
import { buildOperationWorkflow } from "../src/operation-workflow-machine.js";
import { createMcpServer } from "../src/mcp.js";
import { SqliteWorkLedger } from "../src/sqlite-ledger.js";
import { StensiblyStore } from "../src/store.js";
import type { TokenPrincipal } from "../src/token-contracts.js";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const actorId = "api-token:oauth-grant-operation";

describe("GitHub publish-change MCP operation", () => {
  test("derives the exact runner authority server-side and exposes durable readback", async () => {
    const store = new StensiblyStore(":memory:");
    const base = new SqliteWorkLedger(store);
    const received: unknown[] = [];
    const workflow = fixtureWorkflow();
    const ledger = Object.assign(
      withGitHubPublishChangeService(base, {
        execute: async (input: any) => {
          received.push(input);
          return workflow;
        },
        reconcile: async (input: any) => {
          received.push({ ...input, reconciled: true });
          return workflow;
        },
      } as any),
      {
        async getRun(id: string) {
          if (id !== "run_operation") throw new Error("missing run");
          return {
            id,
            itemId: "item_operation",
            actorId,
            runnerType: "codex",
            runnerProfile: "github-operation",
            externalRunId: null,
            status: "running" as const,
            generation: 7,
            leaseGeneration: 3,
            leaseOwnerId: actorId,
            leaseExpiresAt: "2026-08-10T00:10:00.000Z",
            lastHeartbeatAt: "2026-08-10T00:00:00.000Z",
            checkpoint: null,
            outcome: null,
            continuationRef: null,
            usage: {},
            retryAttempt: 0,
            maxAttempts: 1,
            retryBackoffSeconds: 0,
            nextRetryAt: null,
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
            startedAt: "2026-08-10T00:00:00.000Z",
            endedAt: null,
          };
        },
        async getItem(id: string) {
          if (id !== "item_operation") throw new Error("missing item");
          return {
            item: { id, project },
            control: {}, events: [], artifacts: [], dependencies: [], reservations: [],
          };
        },
        async reserveOperationWorkflow(value: unknown) {
          return { outcome: "reserved" as const, workflow: value };
        },
        async transitionOperationWorkflow(input: { next: unknown }) {
          return input.next;
        },
        async getOperationWorkflow(requestedProject: string, key: string) {
          return requestedProject === project && key === "publish-change:mcp" ? workflow : null;
        },
      },
    );
    const server = createMcpServer(ledger as any, { principal: principal() });
    const client = new Client(
      { name: "github-publish-change-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "github_publish_change")?.annotations)
        .toMatchObject({ idempotentHint: true, destructiveHint: true });

      const result = await client.callTool({
        name: "github_publish_change",
        arguments: {
          project,
          repository,
          runId: "run_operation",
          branch: "codex/operation",
          fromCommitSha: "a".repeat(40),
          file: {
            operation: "create_file",
            path: "docs/operation.md",
            content: "bounded change\n",
            message: "Add bounded operation",
          },
          base: "main",
          expectedBaseSha: "a".repeat(40),
          title: "Publish bounded operation",
          draft: true,
          idempotencyKey: "publish-change:mcp",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        project,
        repository,
        actorId,
        clientId: `mcp:${actorId}`,
        itemId: "item_operation",
        runId: "run_operation",
        authorityFence: {
          resource: "run:run_operation:generation:7",
          holderId: actorId,
          generation: 3,
          expiresAt: "2026-08-10T00:10:00.000Z",
        },
      });

      const reconciled = await client.callTool({
        name: "reconcile_github_publish_change",
        arguments: {
          project,
          repository,
          runId: "run_operation",
          branch: "codex/operation",
          fromCommitSha: "a".repeat(40),
          file: {
            operation: "create_file",
            path: "docs/operation.md",
            content: "bounded change\n",
            message: "Add bounded operation",
          },
          base: "main",
          expectedBaseSha: "a".repeat(40),
          title: "Publish bounded operation",
          draft: true,
          idempotencyKey: "publish-change:mcp",
        },
      });
      expect(reconciled.isError).not.toBe(true);
      expect(received).toHaveLength(2);
      expect(received[1]).toMatchObject({
        reconciled: true,
        runId: "run_operation",
        authorityFence: {
          resource: "run:run_operation:generation:7",
          generation: 3,
        },
      });

      const readback = await client.callTool({
        name: "get_operation_workflow",
        arguments: { project, idempotencyKey: "publish-change:mcp" },
      });
      expect(JSON.parse(textContent(readback))).toMatchObject({
        id: "opw_mcp",
        kind: "github_publish_change",
      });
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function fixtureWorkflow() {
  return buildOperationWorkflow({
    id: "opw_mcp",
    project,
    itemId: "item_operation",
    runId: "run_operation",
    actorId,
    clientId: `mcp:${actorId}`,
    kind: "github_publish_change",
    target: `${repository}:refs/heads/codex/operation`,
    request: { key: "publish-change:mcp" },
    idempotencyKey: "publish-change:mcp",
    authorityFence: {
      resource: "run:run_operation:generation:7",
      holderId: actorId,
      generation: 3,
      expiresAt: "2026-08-10T00:10:00.000Z",
    },
    steps: [{
      kind: "github_create_branch",
      command: { branch: "codex/operation" },
      compensation: { disposition: "irreversible" },
    }],
    now: "2026-08-10T00:00:00.000Z",
  });
}

function principal(): TokenPrincipal {
  return {
    tokenId: "operation-token",
    authorizationId: "oauth-grant-operation",
    name: "Operation test",
    scopes: ["read", "write"],
    projects: [project],
  };
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length < 1) throw new Error("missing MCP content");
  const first = content[0] as { text?: unknown };
  if (typeof first.text !== "string") throw new Error("missing MCP text content");
  return first.text;
}