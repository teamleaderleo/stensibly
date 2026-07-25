import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import type { HostedAccountService } from "../src/hosted-account-service.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import type {
  McpOAuthClientRecord,
  McpOAuthGrant,
  McpOAuthRefreshExchange,
  McpOAuthService,
} from "../src/mcp-oauth-service.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const issuer = "https://api.stensibly.com";
const protocolVersion = "2025-06-18";

class ReadAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    if (rawToken !== "read-token") return null;
    return {
      tokenId: "tok_read",
      name: "Read token",
      scopes: ["read"],
      projects: ["scrapbook"],
    };
  }
}

class UnusedOAuthService implements McpOAuthService {
  async registerClient(): Promise<McpOAuthClientRecord> {
    throw new Error("not used");
  }
  async getClient(): Promise<McpOAuthClientRecord | null> {
    return null;
  }
  async createAuthorizationCode(): Promise<McpOAuthGrant> {
    throw new Error("not used");
  }
  async exchangeAuthorizationCode(): Promise<McpOAuthGrant | null> {
    return null;
  }
  async rotateRefreshToken(): Promise<McpOAuthRefreshExchange> {
    return { status: "invalid" };
  }
}

const accountService: Pick<HostedAccountService, "authenticateSession"> = {
  async authenticateSession() {
    return null;
  },
};

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

describe("MCP OAuth challenges", () => {
  test("distinguishes missing, invalid, and insufficient credentials", async () => {
    const app = createHostedApp({
      ledger: new SqliteWorkLedger(store),
      authenticator: new ReadAuthenticator(),
      mcpOAuth: {
        service: new UnusedOAuthService(),
        accountService,
        issuer,
        resource: `${issuer}/mcp`,
        workspace: "default",
        signingSecret: "0123456789abcdef0123456789abcdef",
      },
    });

    const missing = await mcpCall(app, undefined, "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "challenge-test", version: "0.0.1" },
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).not.toContain("error=");

    const invalid = await mcpCall(app, "invalid-token", "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "challenge-test", version: "0.0.1" },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const insufficient = await mcpCall(app, "read-token", "tools/call", {
      name: "create_item",
      arguments: {
        project: "scrapbook",
        kind: "task",
        title: "Should require write",
        priority: 50,
        actor: { id: "leo", name: "Leo", kind: "human" },
      },
    });
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
  });
});

async function mcpCall(
  app: ReturnType<typeof createHostedApp>,
  token: string | undefined,
  method: string,
  params: Record<string, unknown>,
) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
