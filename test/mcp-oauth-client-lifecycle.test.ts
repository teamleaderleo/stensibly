import { describe, expect, test } from "bun:test";
import type { HostedAccountService } from "../src/hosted-account-service.ts";
import {
  ConvexMcpOAuthService,
  type McpOAuthClientRecord,
  type McpOAuthGrant,
  type McpOAuthRefreshExchange,
  type McpOAuthService,
} from "../src/mcp-oauth-service.ts";
import { createMcpOAuth } from "../src/mcp-oauth.ts";
import { FAILURE_CATEGORY_HEADER } from "../src/worker-observability.ts";

const issuer = "https://api.stensibly.com";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const validClientId = "oauth_client_abcdefghijkl";

class CapacityPressureService implements McpOAuthService {
  async registerClient(
    input: Parameters<McpOAuthService["registerClient"]>[0],
  ): Promise<McpOAuthClientRecord> {
    throw new Error(
      `MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED ${input.clientName} ${input.redirectUris[0]}`,
    );
  }

  async getClient(): Promise<McpOAuthClientRecord | null> {
    throw new Error("unused");
  }

  async createAuthorizationCode(): Promise<McpOAuthGrant> {
    throw new Error("unused");
  }

  async exchangeAuthorizationCode(): Promise<McpOAuthGrant | null> {
    throw new Error("unused");
  }

  async rotateRefreshToken(): Promise<McpOAuthRefreshExchange> {
    throw new Error("unused");
  }
}

const accountService: Pick<HostedAccountService, "authenticateSession"> = {
  async authenticateSession() {
    return null;
  },
};

describe("OAuth client lifecycle HTTP handling", () => {
  test("returns a generic retryable backend error without registration metadata", async () => {
    const app = createMcpOAuth({
      service: new CapacityPressureService(),
      accountService,
      issuer,
      resource: `${issuer}/mcp`,
      workspace: "default",
      signingSecret: "0123456789abcdef0123456789abcdef",
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const clientName = "Sensitive retry client";
    const response = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });

    expect(response.status).toBe(502);
    expect(response.headers.get(FAILURE_CATEGORY_HEADER)).toBe("convex_failure");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: "server_error",
      error_description: "OAuth service is temporarily unavailable",
    });
    expect(body).not.toContain("MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED");
    expect(body).not.toContain(clientName);
    expect(body).not.toContain(redirectUri);
  });

  test("passes trusted current time as part of the Convex client-query key", async () => {
    const calls: Array<{ kind: "query" | "mutation"; args: Record<string, unknown> }> = [];
    const client = {
      async query(_reference: unknown, args: Record<string, unknown>) {
        calls.push({ kind: "query", args });
        return null;
      },
      async mutation(_reference: unknown, args: Record<string, unknown>) {
        calls.push({ kind: "mutation", args });
        return { status: "limit" };
      },
    } as any;
    const service = new ConvexMcpOAuthService({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });

    const before = Date.now();
    expect(await service.getClient(validClientId)).toBeNull();
    const after = Date.now();
    expect(calls[0]?.kind).toBe("query");
    expect(calls[0]?.args).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      clientId: validClientId,
    });
    const now = calls[0]?.args.now;
    expect(typeof now).toBe("number");
    expect(now as number).toBeGreaterThanOrEqual(before);
    expect(now as number).toBeLessThanOrEqual(after);
  });
});
