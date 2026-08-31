import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import type { WorkLedger } from "../src/ledger.ts";
import {
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
} from "../src/mcp-diagnostics.ts";
import { compileMcpExposureRegistrationPlan } from "../src/mcp-exposure-registration.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";
import { FAILURE_CATEGORY_HEADER } from "../src/worker-observability.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const protocolVersion = "2025-06-18";

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    if (rawToken !== "hosted-token") return null;
    return {
      tokenId: "tok_hosted",
      name: "Hosted reader",
      scopes: ["read", "write"],
      projects: ["scrapbook"],
    };
  }
}

class FailingAuthenticator implements ApiTokenAuthenticator {
  async authenticate(): Promise<TokenPrincipal | null> {
    throw new Error("token authority unavailable");
  }
}

let store: StensiblyStore;
let app: ReturnType<typeof createHostedApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Serve this without a hosted SQLite file",
    priority: 50,
    actor: leo,
  });
  app = createHostedApp({
    ledger: new SqliteWorkLedger(store),
    authenticator: new FixedAuthenticator(),
    allowedOrigins: ["https://stensibly.com"],
  });
});

afterEach(() => store.close());

describe("hosted gateway", () => {
  test("keeps health public and requires tokens for API v1", async () => {
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      backend: "convex",
      surfaces: ["api-v1", "mcp", "runner-mcp"],
    });

    const denied = await app.request("/api/v1/items");
    expect(denied.status).toBe(401);
    expect(denied.headers.get(FAILURE_CATEGORY_HEADER)).toBe("auth_failure");

    const listed = await app.request("/api/v1/items", {
      headers: { authorization: "Bearer hosted-token" },
    });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { items: Array<{ project: string }> };
    expect(body.items).toEqual([
      expect.objectContaining({ project: "scrapbook" }),
    ]);
  });

  test("serves the curated published MCP profile from the same ledger and authenticator", async () => {
    const published = compileMcpExposureRegistrationPlan(
      new SqliteWorkLedger(store),
      "published_default",
    );
    expect(published.manifest.tools).toHaveLength(21);

    const initialized = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "hosted-gateway-test", version: "0.0.1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);

    const discovered = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(discovered.status).toBe(200);
    const discovery = await discovered.json() as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const names = discovery.result?.tools?.map((tool) => tool.name) ?? [];
    expect([...names].sort()).toEqual([...published.manifest.tools].sort());
    expect(names).toHaveLength(21);
    expect(names).toContain("get_brief");
    expect(names).toContain("github_create_issue");
    expect(names).toContain("github_publish_change");
    expect(names).not.toContain("get_operation_receipt");
    expect(names).not.toContain("github_call_tool");
    expect(names).not.toContain("enrol_worker");
    expect(discovered.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
      published.manifest.fingerprint,
    );
    expect(discovered.headers.get(MCP_TOOL_COUNT_HEADER)).toBe("21");

    const listed = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_work",
          arguments: { project: "scrapbook" },
        },
      }),
    });
    expect(listed.status).toBe(200);
  });

  test("serves the private runner MCP from the same ledger and token authority", async () => {
    const discovered = await app.request("/runner/mcp", {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      }),
    });

    expect(discovered.status).toBe(200);
    const discovery = await discovered.json() as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const names = discovery.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("claim_runner_work");
    expect(names).toContain("reserve_workstation_adapter_command");
    expect(names).toContain("settle_runner_adapter_command");
  });

  test("applies exact-origin CORS only to the REST surface", async () => {
    const preflight = await app.request("/api/v1/items", {
      method: "OPTIONS",
      headers: {
        origin: "https://stensibly.com",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://stensibly.com");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Request-ID");
    expect(preflight.headers.get("access-control-expose-headers")).toBe("x-request-id");

    const deniedRest = await app.request("/api/v1/items", {
      headers: { origin: "https://untrusted.example" },
    });
    expect(deniedRest.status).toBe(403);
    expect(deniedRest.headers.get(FAILURE_CATEGORY_HEADER)).toBe("cors_rejection");

    const deniedMcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...mcpHeaders(),
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "untrusted", version: "0.0.1" },
        },
      }),
    });
    expect(deniedMcp.status).toBe(403);
    expect(deniedMcp.headers.get(FAILURE_CATEGORY_HEADER)).toBe("cors_rejection");
  });

  test("sanitizes hosted authentication backend failures", async () => {
    const failingApp = createHostedApp({
      ledger: new SqliteWorkLedger(store) as WorkLedger,
      authenticator: new FailingAuthenticator(),
    });
    const restResponse = await failingApp.request("/api/v1/items", {
      headers: { authorization: "Bearer opaque-token" },
    });

    expect(restResponse.status).toBe(502);
    expect(restResponse.headers.get(FAILURE_CATEGORY_HEADER)).toBe("convex_failure");
    expect(await restResponse.json()).toEqual({
      error: "Hosted token authority failed",
      code: "backend_failure",
    });

    const mcpResponse = await failingApp.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "failed-auth", version: "0.0.1" },
        },
      }),
    });
    expect(mcpResponse.status).toBe(502);
    expect(mcpResponse.headers.get(FAILURE_CATEGORY_HEADER)).toBe("convex_failure");
    expect(await mcpResponse.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Hosted token authority failed" },
      id: null,
    });
  });
});

function mcpHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
    authorization: "Bearer hosted-token",
  };
}
