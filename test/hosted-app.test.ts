import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

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

    expect((await app.request("/api/v1/items")).status).toBe(401);
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
