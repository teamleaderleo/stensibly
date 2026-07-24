import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import type { WorkLedger } from "../src/ledger.ts";
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
      surfaces: ["api-v1", "mcp"],
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

  test("serves remote MCP from the same ledger and authenticator", async () => {
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

    const listed = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "list_work",
          arguments: { project: "scrapbook" },
        },
      }),
    });
    expect(listed.status).toBe(200);
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
        id: 3,
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
        id: 4,
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
