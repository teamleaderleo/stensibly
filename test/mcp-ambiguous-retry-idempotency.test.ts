import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import {
  callToolEnvelope,
  callToolJson,
  initializeMessage,
  mcpRequest,
  toolCall,
} from "./support/mcp-http.ts";

const project = "oauth-dogfood";
const actor = {
  id: "keel:ambiguous-retry",
  name: "Keel Ambiguous Retry",
  kind: "agent" as const,
};
const retryClient = { clientName: "ambiguous-retry-test" };

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
        requestHeaders(2),
      );
      expect(abandoned.status).toBe(200);
      await abandoned.body?.cancel("synthetic result-delivery loss");
      expect(createItemCalls).toBe(1);

      const reconnectedApp = createApp();
      await initialize(reconnectedApp, token.token, 3);
      const receipt = await callToolJson<{
        status: string;
        operation: string;
        eventId: string;
        itemId: string;
        result: { kind: string; id: string };
        reconciliation: { retry: string; nextAction: string; itemId: string };
      }>(reconnectedApp, token.token, 4, "get_operation_receipt", {
        project,
        idempotencyKey,
      }, requestHeaders(4));
      expect(receipt).toMatchObject({
        status: "recorded",
        operation: "item.created",
        result: { kind: "item" },
        reconciliation: { retry: "do_not_retry", nextAction: "read_item" },
      });

      const replayed = await callToolJson<{
        id: string;
        title: string;
        status: string;
      }>(reconnectedApp, token.token, 5, "create_item", request, requestHeaders(5));
      expect(replayed).toMatchObject({
        id: receipt.itemId,
        title: request.title,
        status: "ready",
      });
      expect(createItemCalls).toBe(2);

      const detail = await callToolJson<{
        item: { id: string; title: string };
        events: Array<{ id: string; type: string }>;
      }>(reconnectedApp, token.token, 6, "get_item", {
        id: receipt.itemId,
      }, requestHeaders(6));
      expect(detail.item).toMatchObject({ id: receipt.itemId, title: request.title });
      const createdEvents = detail.events.filter((event) => event.type === "item.created");
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]?.id).toBe(receipt.eventId);

      const work = await callToolJson<Array<{ id: string }>>(
        reconnectedApp,
        token.token,
        7,
        "list_work",
        { project },
        requestHeaders(7),
      );
      expect(work.map((item) => item.id)).toEqual([receipt.itemId]);

      const changed = await callToolEnvelope(
        reconnectedApp,
        token.token,
        8,
        "create_item",
        { ...request, title: "Changed request under the same key" },
        requestHeaders(8),
      );
      expect(changed.isError).toBe(true);
      expect(changed.text).toMatch(/different operation/i);
      expect(createItemCalls).toBe(3);

      const afterConflict = await callToolJson<Array<{ id: string }>>(
        reconnectedApp,
        token.token,
        9,
        "list_work",
        { project },
        requestHeaders(9),
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
  const response = await mcpRequest(
    app,
    token,
    initializeMessage(id, retryClient),
    requestHeaders(id),
  );
  expect(response.status).toBe(200);
}

function requestHeaders(id: number): Record<string, string> {
  return { "x-request-id": `lane-68-${id}` };
}
