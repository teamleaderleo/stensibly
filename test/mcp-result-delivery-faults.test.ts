import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createMcpServer } from "../src/mcp.ts";
import { asToolResult } from "../src/mcp-tool-result.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";
const actor = {
  id: "delivery-fault-agent",
  name: "Delivery Fault Agent",
  kind: "agent" as const,
};

describe("MCP result delivery faults", () => {
  test("preserves a committed mutation when result serialization fails", async () => {
    const store = new StensiblyStore(":memory:");

    try {
      const token = createApiToken(store, {
        name: "Serialization fault writer",
        scopes: ["read", "write"],
        projects: ["oauth-dogfood"],
      });
      const app = createServerApp(store, {
        mcp: {
          createServer(ledger) {
            const wrapped = new Proxy(ledger, {
              get(target, property, receiver) {
                if (property === "createItem") {
                  return async (input: Parameters<typeof target.createItem>[0]) => {
                    const created = await target.createItem(input);
                    const circular: Record<string, unknown> = { ...created };
                    circular.self = circular;
                    return circular;
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

      await initialize(app, token.token, 1);
      const response = await mcpRequest(app, token.token, toolCall(2, "create_item", {
        project: "oauth-dogfood",
        kind: "task",
        title: "Committed before serialization failure",
        actor,
        idempotencyKey: "delivery-serialization-create",
      }));
      expect(response.status).toBe(200);
      const failure = await readToolEnvelope(response);
      expect(failure.isError).toBe(true);
      expect(JSON.parse(failure.text)).toEqual({
        error: {
          code: "result_serialization_failed",
          message: "Tool operation completed but its result could not be serialized",
          stage: "result_serialization",
          operationMayHaveCompleted: true,
          retryable: false,
          reconciliation: "inspect_state_before_retry",
          recommendedAction: "read_state_or_operation_receipt_before_retry",
        },
      });

      const receipt = await callTool<any>(app, token.token, 3, "get_operation_receipt", {
        project: "oauth-dogfood",
        idempotencyKey: "delivery-serialization-create",
      });
      expect(receipt).toMatchObject({
        status: "recorded",
        operation: "item.created",
        result: { kind: "item" },
        reconciliation: { retry: "do_not_retry" },
      });
    } finally {
      store.close();
    }
  });

  test("keeps a mutation committed when the client abandons its response body", async () => {
    const store = new StensiblyStore(":memory:");

    try {
      const token = createApiToken(store, {
        name: "Abandoned response writer",
        scopes: ["read", "write"],
        projects: ["oauth-dogfood"],
      });
      const app = createServerApp(store);
      await initialize(app, token.token, 1);

      const response = await mcpRequest(app, token.token, toolCall(2, "create_item", {
        project: "oauth-dogfood",
        kind: "task",
        title: "Client abandoned the response",
        actor,
        idempotencyKey: "delivery-abandoned-create",
      }));
      expect(response.status).toBe(200);
      await response.body?.cancel("synthetic client disconnect");

      const receipt = await callTool<any>(app, token.token, 3, "get_operation_receipt", {
        project: "oauth-dogfood",
        idempotencyKey: "delivery-abandoned-create",
      });
      expect(receipt).toMatchObject({
        status: "recorded",
        operation: "item.created",
        result: { kind: "item" },
        reconciliation: { retry: "do_not_retry" },
      });
    } finally {
      store.close();
    }
  });

  test("keeps execution errors compatible and classifies non-JSON results", async () => {
    const executionFailure = await asToolResult(async () => {
      throw new Error("bounded domain failure");
    });
    expect(executionFailure).toEqual({
      content: [{ type: "text", text: "bounded domain failure" }],
      isError: true,
    });

    const undefinedResult = await asToolResult(async () => undefined);
    expect(undefinedResult.isError).toBe(true);
    expect(JSON.parse(undefinedResult.content[0]!.text)).toMatchObject({
      error: { code: "result_serialization_failed" },
    });
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
      clientInfo: { name: "delivery-fault-test", version: "0.0.1" },
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
  const response = await mcpRequest(app, token, toolCall(id, name, args));
  expect(response.status).toBe(200);
  const envelope = await readToolEnvelope(response);
  if (envelope.isError) throw new Error(envelope.text);
  return JSON.parse(envelope.text) as T;
}

async function readToolEnvelope(response: Response): Promise<{
  isError: boolean;
  text: string;
}> {
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

function toolCall(id: number, name: string, args: Record<string, unknown>) {
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
      "x-request-id": `delivery-${String((body as { id?: unknown }).id ?? "none")}`,
    },
    body: JSON.stringify(body),
  });
}
