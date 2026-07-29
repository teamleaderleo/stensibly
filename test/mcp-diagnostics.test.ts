import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import {
  MCP_FAILURE_STAGE_HEADER,
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
  MCP_TOOL_NAMES,
} from "../src/mcp-diagnostics.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const protocolVersion = "2025-06-18";

describe("MCP connector diagnostics", () => {
  test("publishes one stable manifest fingerprint that matches tools/list", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const token = createApiToken(store, {
        name: "Manifest diagnostics reader",
        scopes: ["read"],
      });
      const app = createServerApp(store);
      const initialized = await mcpRequest(app, token.token, initializeMessage(1));
      expect(initialized.status).toBe(200);
      expect(initialized.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_TOOL_MANIFEST_FINGERPRINT,
      );
      expect(initialized.headers.get(MCP_TOOL_COUNT_HEADER)).toBe(String(MCP_TOOL_NAMES.length));

      const listed = await mcpRequest(app, token.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const payload = await listed.json() as {
        result?: { tools?: Array<{ name?: unknown }> };
      };
      const names = (payload.result?.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string")
        .sort();
      expect(names).toEqual([...MCP_TOOL_NAMES]);
      expect(listed.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_TOOL_MANIFEST_FINGERPRINT,
      );
    } finally {
      store.close();
    }
  });

  test("returns typed stage and reconciliation guidance for gateway MCP failures", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const token = createApiToken(store, {
        name: "Failure diagnostics reader",
        scopes: ["read"],
      });
      const app = createServerApp(store, {
        mcp: {
          createServer() {
            throw new Error("synthetic construction failure");
          },
        },
      });
      const response = await app.request("/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
          "mcp-protocol-version": protocolVersion,
          "x-request-id": "diag-construction-1",
        },
        body: JSON.stringify(initializeMessage(9)),
      });
      expect(response.status).toBe(500);
      expect(response.headers.get(MCP_FAILURE_STAGE_HEADER)).toBe("server_construction");
      expect(response.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
        MCP_TOOL_MANIFEST_FINGERPRINT,
      );
      const payload = await response.json() as {
        error?: { data?: Record<string, unknown> };
      };
      expect(payload.error?.data).toEqual({
        layer: "mcp",
        stage: "server_construction",
        requestId: "diag-construction-1",
        retryable: true,
        reconciliation: "safe_to_retry",
        recommendedAction: "retry_with_same_request_id",
        manifestFingerprint: MCP_TOOL_MANIFEST_FINGERPRINT,
        manifestToolCount: MCP_TOOL_NAMES.length,
        method: "initialize",
      });
    } finally {
      store.close();
    }
  });
});

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

function initializeMessage(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "mcp-diagnostics-test", version: "0.0.1" },
    },
  };
}
