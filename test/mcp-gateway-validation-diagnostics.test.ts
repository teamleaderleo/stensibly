import { describe, expect, test } from "bun:test";
import { MCP_FAILURE_STAGE_HEADER } from "../src/mcp-diagnostics.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "gateway-diagnostic-test", version: "0.0.1" },
  },
};

describe("MCP gateway validation diagnostics", () => {
  test("classifies rejected origins as gateway origin validation", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        mcp: { allowedOrigins: ["https://allowed.example"] },
      });
      const response = await app.request("https://api.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://blocked.example",
          "x-request-id": "origin-rejected-1",
        },
        body: JSON.stringify(initialize),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get(MCP_FAILURE_STAGE_HEADER)).toBe("origin_validation");
      const payload = await response.json() as {
        error?: { data?: Record<string, unknown> };
      };
      expect(payload.error?.data).toMatchObject({
        layer: "gateway",
        stage: "origin_validation",
        requestId: "origin-rejected-1",
        retryable: false,
        reconciliation: "not_required",
        recommendedAction: "fix_request",
        method: "initialize",
      });
    } finally {
      store.close();
    }
  });

  test("classifies rejected hosts as gateway host validation", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        mcp: { allowedHosts: ["allowed.example"] },
      });
      const response = await app.request("https://blocked.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "host-rejected-1",
        },
        body: JSON.stringify(initialize),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get(MCP_FAILURE_STAGE_HEADER)).toBe("host_validation");
      const payload = await response.json() as {
        error?: { data?: Record<string, unknown> };
      };
      expect(payload.error?.data).toMatchObject({
        layer: "gateway",
        stage: "host_validation",
        requestId: "host-rejected-1",
        retryable: false,
        reconciliation: "not_required",
        recommendedAction: "fix_request",
        method: "initialize",
      });
    } finally {
      store.close();
    }
  });
});
