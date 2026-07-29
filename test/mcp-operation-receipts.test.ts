import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";
const actor = {
  id: "receipt-http-agent",
  name: "Receipt HTTP Agent",
  kind: "agent" as const,
};

describe("remote operation receipts", () => {
  test("allows project-scoped reads, holds unknown keys, and rejects missing scope or project access", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);

    try {
      const item = await ledger.createItem({
        project: "alpha",
        kind: "task",
        title: "Remote receipt",
        priority: 80,
        actor,
        idempotencyKey: "remote-receipt-create",
      });
      const reader = createApiToken(store, {
        name: "Alpha receipt reader",
        scopes: ["read"],
        projects: ["alpha"],
      });
      const foreignReader = createApiToken(store, {
        name: "Beta receipt reader",
        scopes: ["read"],
        projects: ["beta"],
      });
      const writer = createApiToken(store, {
        name: "Write-only token",
        scopes: ["write"],
        projects: ["alpha"],
      });
      const app = createServerApp(store);

      await initialize(app, reader.token, 1);
      const receipt = await callTool<any>(app, reader.token, 2, {
        project: "alpha",
        idempotencyKey: "remote-receipt-create",
      });
      expect(receipt).toMatchObject({
        status: "recorded",
        operation: "item.created",
        itemId: item.id,
        result: { kind: "item", id: item.id },
        reconciliation: {
          retry: "do_not_retry",
          nextAction: "read_item",
          itemId: item.id,
        },
      });

      const unknown = await callTool<any>(app, reader.token, 3, {
        project: "alpha",
        idempotencyKey: "remote-missing-key",
      });
      expect(unknown).toMatchObject({
        status: "unknown",
        project: "alpha",
        idempotencyKey: "remote-missing-key",
        reconciliation: {
          retry: "hold",
          nextAction: "verify_project_scope_before_retry",
        },
      });

      const foreign = await mcpRequest(app, foreignReader.token, toolCall(4, {
        project: "alpha",
        idempotencyKey: "remote-receipt-create",
      }));
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({
        error: { message: "Token cannot access project alpha" },
        id: 4,
      });

      const missingReadScope = await mcpRequest(app, writer.token, toolCall(5, {
        project: "alpha",
        idempotencyKey: "remote-receipt-create",
      }));
      expect(missingReadScope.status).toBe(403);
      expect(await missingReadScope.json()).toMatchObject({
        error: { message: "Token requires read scope" },
        id: 5,
      });
    } finally {
      store.close();
    }
  });
});

async function initialize(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
): Promise<void> {
  const response = await mcpRequest(app, token, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "operation-receipt-test", version: "0.0.1" },
    },
  });
  expect(response.status).toBe(200);
}

async function callTool<T>(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await mcpRequest(app, token, toolCall(id, args));
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }> };
  };
  const first = payload.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Operation receipt response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}

function toolCall(id: number, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "get_operation_receipt", arguments: args },
  };
}

async function mcpRequest(
  app: ReturnType<typeof createServerApp>,
  token: string,
  body: unknown,
): Promise<Response> {
  return await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(body),
  });
}
