import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";
const project = "oauth-dogfood";
const actor = {
  id: "keel:ambiguous-retry",
  name: "Keel Ambiguous Retry",
  kind: "agent" as const,
};

describe("MCP ambiguous mutation retry", () => {
  test("re-executes the handler but persists one effect after result loss and exact retry", async () => {
    const store = new StensiblyStore(":memory:");
    let createItemCalls = 0;

    try {
      const token = createApiToken(store, {
        name: "Ambiguous retry writer",
        scopes: ["read", "write"],
        projects: [project],
      });
      const createApp = () => createServerApp(store, {
        mcp: {
          createServer(ledger) {
            const wrapped = new Proxy(ledger, {
              get(target, property, receiver) {
                if (property === "createItem") {
                  return async (input: Parameters<typeof target.createItem>[0]) => {
                    createItemCalls += 1;
                    return await target.createItem(input);
                  };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            return createMcpServer(wrapped);
          },
        },
      });

      const idempotencyKey = "lane-68-ambiguous-create-v1";
      const request = {
        project,
        kind: "task",
        title: "Ambiguous MCP result delivery",
        summary: "The server commits before the client consumes the result.",
        nextAction: "Reconcile by operation receipt, then retry the exact request.",
        priority: 97,
        actor,
        idempotencyKey,
      };

      const firstApp = createApp();
      await initialize(firstApp, token.token, 1);
      const abandoned = await mcpRequest(
        firstApp,
        token.token,
        toolCall(2, "create_item", request),
      );
      expect(abandoned.status).toBe(200);
      await abandoned.body?.cancel("synthetic result-delivery loss");
      expect(createItemCalls).toBe(1);

      const reconnectedApp = createApp();
      await initialize(reconnectedApp, token.token, 3);
      const receipt = await callTool<{
        status: string;
        operation: string;
        eventId: string;
        itemId: string;
        result: { kind: string; id: string };
        reconciliation: { retry: string; nextAction: string; itemId: string };
      }>(reconnectedApp, token.token, 4, "get_operation_receipt", {
        project,
        idempotencyKey,
      });
      expect(receipt).toMatchObject({
        status: "recorded",
        operation: "item.created",
        result: { kind: "item" },
        reconciliation: { retry: "do_not_retry", nextAction: "read_item" },
      });

      const replayed = await callTool<{
        id: string;
        title: string;
        status: string;
      }>(reconnectedApp, token.token, 5, "create_item", request);
      expect(replayed).toMatchObject({
        id: receipt.itemId,
        title: request.title,
        status: "ready",
      });
      expect(createItemCalls).toBe(2);

      const detail = await callTool<{
        item: { id: string; title: string };
        events: Array<{ id: string; type: string }>;
      }>(reconnectedApp, token.token, 6, "get_item", { id: receipt.itemId });
      expect(detail.item).toMatchObject({ id: receipt.itemId, title: request.title });
      const createdEvents = detail.events.filter((event) => event.type === "item.created");
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]?.id).toBe(receipt.eventId);

      const work = await callTool<Array<{ id: string }>>(
        reconnectedApp,
        token.token,
        7,
        "list_work",
        { project },
      );
      expect(work.map((item) => item.id)).toEqual([receipt.itemId]);

      const changed = await callToolEnvelope(
        reconnectedApp,
        token.token,
        8,
        "create_item",
        { ...request, title: "Changed request under the same key" },
      );
      expect(changed.isError).toBe(true);
      expect(changed.text).toMatch(/different operation/i);
      expect(createItemCalls).toBe(3);

      const afterConflict = await callTool<Array<{ id: string }>>(
        reconnectedApp,
        token.token,
        9,
        "list_work",
        { project },
      );
      expect(afterConflict.map((item) => item.id)).toEqual([receipt.itemId]);
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
      clientInfo: { name: "ambiguous-retry-test", version: "0.0.1" },
    },
  });
  expect(response.status).toBe(200);
}

async function callTool<T>(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const envelope = await callToolEnvelope(app, token, id, name, args);
  if (envelope.isError) throw new Error(envelope.text);
  return JSON.parse(envelope.text) as T;
}

async function callToolEnvelope(
  app: ReturnType<typeof createServerApp>,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const response = await mcpRequest(app, token, toolCall(id, name, args));
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    result?: {
      isError?: boolean;
      content?: Array<{ type?: unknown; text?: unknown }>;
    };
  };
  const first = payload.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP result did not contain text");
  }
  return { isError: payload.result?.isError === true, text: first.text };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
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
      "x-request-id": `lane-68-${String((body as { id?: unknown }).id ?? "none")}`,
    },
    body: JSON.stringify(body),
  });
}
