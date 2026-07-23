import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const protocolVersion = "2025-06-18";

class FixedAuthenticator implements ApiTokenAuthenticator {
  calls: string[] = [];

  constructor(readonly principal: TokenPrincipal | null) {}

  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    this.calls.push(rawToken);
    return rawToken === "hosted-token" ? this.principal : null;
  }
}

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Visible through hosted auth",
    priority: 50,
    actor: leo,
  });
  store.createItem({
    project: "secret",
    kind: "task",
    title: "Hidden through hosted auth",
    priority: 50,
    actor: leo,
  });
});

afterEach(() => store.close());

describe("async hosted authentication", () => {
  test("preserves an outer async principal through API v1", async () => {
    const authenticator = new FixedAuthenticator({
      tokenId: "tok_hosted",
      name: "Hosted reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });
    const app = createServerApp(store, {
      httpAuth: { required: true },
      authenticator,
    });

    const response = await app.request("/api/v1/items", {
      headers: { authorization: "Bearer hosted-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ project: string }> };
    expect(body.items.map((item) => item.project)).toEqual(["scrapbook"]);
    expect(authenticator.calls).toEqual(["hosted-token"]);

    const invalid = await app.request("/api/v1/items", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(invalid.status).toBe(401);
  });

  test("uses the async authenticator for remote MCP", async () => {
    const authenticator = new FixedAuthenticator({
      tokenId: "tok_hosted",
      name: "Hosted MCP reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });
    const app = createServerApp(store, {
      authenticator,
      mcp: { authenticator },
    });

    const initialized = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("hosted-token"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "hosted-auth-test", version: "0.0.1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);

    const listed = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("hosted-token"),
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
    expect(authenticator.calls).toEqual(["hosted-token", "hosted-token"]);

    const denied = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("hosted-token"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_work",
          arguments: { project: "secret" },
        },
      }),
    });
    expect(denied.status).toBe(403);
  });
});

function mcpHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
    authorization: `Bearer ${token}`,
  };
}
