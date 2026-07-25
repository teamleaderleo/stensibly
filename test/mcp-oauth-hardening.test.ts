import { describe, expect, test } from "bun:test";
import type { HostedAccountService } from "../src/hosted-account-service.ts";
import type {
  McpOAuthClientRecord,
  McpOAuthGrant,
  McpOAuthRefreshExchange,
  McpOAuthService,
} from "../src/mcp-oauth-service.ts";
import { createMcpOAuth } from "../src/mcp-oauth.ts";
import { consentPage } from "../src/mcp-oauth-protocol.ts";

const issuer = "https://api.stensibly.com";
const resource = `${issuer}/mcp`;
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

class HardeningOAuthService implements McpOAuthService {
  client: McpOAuthClientRecord = {
    clientId: "oauth_client_abcdefghijkl",
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    createdAt: new Date(0).toISOString(),
  };

  async registerClient(input: Parameters<McpOAuthService["registerClient"]>[0]) {
    this.client = { ...input, createdAt: new Date(0).toISOString() };
    return this.client;
  }

  async getClient(clientId: string) {
    return clientId === this.client.clientId ? this.client : null;
  }

  async createAuthorizationCode(): Promise<McpOAuthGrant> {
    throw new Error("not used");
  }

  async exchangeAuthorizationCode(): Promise<McpOAuthGrant> {
    return grant(["read"]);
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

describe("MCP OAuth hardening", () => {
  test("does not issue or advertise refresh access without offline_access", async () => {
    const service = new HardeningOAuthService();
    const app = createMcpOAuth(options(service));
    const rawCode = `oauth_code_abcdefghijkl.${"s".repeat(32)}`;

    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: service.client.clientId,
        redirect_uri: redirectUri,
        code: rawCode,
        code_verifier: verifier,
        resource,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.scope).toBe("read");
    expect(body.refresh_token).toBeUndefined();

    const html = consentPage({
      clientName: "ChatGPT",
      accountName: "Leo",
      scopes: ["read"],
      projects: ["scrapbook"],
      payload: "payload",
      signature: "signature",
    });
    expect(html).not.toContain("A refresh token keeps the connection active");
  });

  test("redirects scope errors only after validating the client redirect", async () => {
    const service = new HardeningOAuthService();
    const app = createMcpOAuth(options(service));
    const authorize = new URL("/oauth/authorize", issuer);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", service.client.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("code_challenge", "a".repeat(43));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("scope", "read offline_access");
    authorize.searchParams.set("resource", resource);
    authorize.searchParams.set("state", "scope-state");

    const response = await app.request(authorize.toString());
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location") ?? "");
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("error")).toBe("invalid_scope");
    expect(callback.searchParams.get("state")).toBe("scope-state");

    authorize.searchParams.set("client_id", "oauth_client_unknownxxxxx");
    const unknownClient = await app.request(authorize.toString());
    expect(unknownClient.status).toBe(400);
    expect(await unknownClient.json()).toMatchObject({ error: "invalid_request" });
  });

  test("requires JSON registration and protects OAuth pages from framing", async () => {
    const service = new HardeningOAuthService();
    const app = createMcpOAuth(options(service));

    const metadata = await app.request("/.well-known/oauth-authorization-server");
    expect(metadata.headers.get("x-frame-options")).toBe("DENY");
    expect(metadata.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const registration = await app.request("/oauth/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    expect(registration.status).toBe(400);
    expect(await registration.json()).toMatchObject({
      error: "invalid_client_metadata",
    });
  });
});

function options(service: McpOAuthService) {
  return {
    service,
    accountService,
    issuer,
    resource,
    workspace: "default",
    signingSecret: "0123456789abcdef0123456789abcdef",
    now: () => 1_000_000,
    randomBytes: deterministicRandomBytes(),
  };
}

function grant(scopes: McpOAuthGrant["scopes"]): McpOAuthGrant {
  return {
    clientId: "oauth_client_abcdefghijkl",
    resource,
    scopes,
    principal: {
      accountId: "acct_test",
      name: "Leo",
      workspace: "default",
      role: "member",
      scopes: ["read", "write"],
      projects: ["scrapbook"],
    },
  };
}

function deterministicRandomBytes() {
  let call = 0;
  return (length: number) => new Uint8Array(length).fill(++call);
}
