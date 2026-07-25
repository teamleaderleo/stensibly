import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import type {
  HostedAccountService,
  HostedSessionContext,
} from "../src/hosted-account-service.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import type {
  McpOAuthClientRecord,
  McpOAuthGrant,
  McpOAuthRefreshExchange,
  McpOAuthService,
} from "../src/mcp-oauth-service.ts";
import type { McpOAuthOptions } from "../src/mcp-oauth.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const protocolVersion = "2025-06-18";
const issuer = "https://api.stensibly.com";
const resource = `${issuer}/mcp`;
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const sessionCookie = "__Host-stensibly-session=ses_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEF";

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    if (rawToken !== "legacy-token") return null;
    return {
      tokenId: "tok_legacy",
      name: "Legacy reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    };
  }
}

class FixedAccountService implements Pick<HostedAccountService, "authenticateSession"> {
  async authenticateSession(
    _input: Parameters<HostedAccountService["authenticateSession"]>[0],
  ): Promise<HostedSessionContext> {
    return {
      session: {
        id: "ses_abcdefghijkl",
        userAgent: "test",
        createdAt: new Date(0).toISOString(),
        lastSeenAt: new Date(0).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        revokedAt: null,
      },
      account: {
        id: "acct_test",
        displayName: "Leo",
        primaryEmail: null,
        avatarUrl: null,
        defaultActorId: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        disabledAt: null,
      },
      membership: {
        workspace: "default",
        role: "member",
        projects: ["scrapbook"],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        revokedAt: null,
      },
      principal: {
        type: "account",
        accountId: "acct_test",
        name: "Leo",
        workspace: "default",
        role: "member",
        scopes: ["read", "write"],
        projects: ["scrapbook"],
      },
      capabilities: { read: true, write: true, admin: false },
    };
  }
}

interface StoredCode {
  id: string;
  secretHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: McpOAuthGrant["scopes"];
  resource: string;
}

interface StoredRefresh {
  id: string;
  secretHash: string;
  clientId: string;
  consumed: boolean;
  family: string;
  scopes: McpOAuthGrant["scopes"];
  resource: string;
}

class MemoryOAuthService implements McpOAuthService {
  clients = new Map<string, McpOAuthClientRecord>();
  codes = new Map<string, StoredCode>();
  refresh = new Map<string, StoredRefresh>();

  async registerClient(input: Parameters<McpOAuthService["registerClient"]>[0]) {
    const record: McpOAuthClientRecord = {
      ...input,
      createdAt: new Date(1_000).toISOString(),
    };
    this.clients.set(record.clientId, record);
    return record;
  }

  async getClient(clientId: string) {
    return this.clients.get(clientId) ?? null;
  }

  async createAuthorizationCode(input: Parameters<McpOAuthService["createAuthorizationCode"]>[0]) {
    this.codes.set(input.id, {
      id: input.id,
      secretHash: input.secretHash,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      resource: input.resource,
    });
    return this.grant(input.clientId, input.resource, input.scopes);
  }

  async exchangeAuthorizationCode(input: Parameters<McpOAuthService["exchangeAuthorizationCode"]>[0]) {
    const code = this.codes.get(input.id);
    if (
      !code
      || code.secretHash !== input.secretHash
      || code.clientId !== input.clientId
      || code.redirectUri !== input.redirectUri
      || code.codeChallenge !== input.codeChallenge
    ) return null;
    this.codes.delete(input.id);
    this.refresh.set(input.refreshId, {
      id: input.refreshId,
      secretHash: input.refreshSecretHash,
      clientId: input.clientId,
      consumed: false,
      family: input.refreshId,
      scopes: code.scopes,
      resource: code.resource,
    });
    return this.grant(input.clientId, code.resource, code.scopes);
  }

  async rotateRefreshToken(
    input: Parameters<McpOAuthService["rotateRefreshToken"]>[0],
  ): Promise<McpOAuthRefreshExchange> {
    const current = this.refresh.get(input.id);
    if (!current || current.secretHash !== input.secretHash || current.clientId !== input.clientId) {
      return { status: "invalid" };
    }
    if (current.consumed) {
      for (const token of this.refresh.values()) {
        if (token.family === current.family) token.consumed = true;
      }
      return { status: "replayed" };
    }
    current.consumed = true;
    this.refresh.set(input.nextId, {
      id: input.nextId,
      secretHash: input.nextSecretHash,
      clientId: input.clientId,
      consumed: false,
      family: current.family,
      scopes: current.scopes,
      resource: current.resource,
    });
    return { status: "ok", grant: this.grant(current.clientId, current.resource, current.scopes) };
  }

  private grant(
    clientId: string,
    requestedResource: string,
    scopes: McpOAuthGrant["scopes"],
  ): McpOAuthGrant {
    return {
      clientId,
      resource: requestedResource,
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
}

let store: StensiblyStore;
let service: MemoryOAuthService;
let now: number;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  service = new MemoryOAuthService();
  now = 1_000_000;
});

afterEach(() => store.close());

describe("MCP OAuth HTTP flow", () => {
  test("discovers, authorises, refreshes, and keeps legacy bearer clients working", async () => {
    const app = createApp();

    const resourceMetadata = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(resourceMetadata.status).toBe(200);
    expect(await resourceMetadata.json()).toMatchObject({
      resource,
      authorization_servers: [issuer],
    });

    const serverMetadata = await app.request("/.well-known/oauth-authorization-server");
    expect(await serverMetadata.json()).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });

    const registration = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };

    const challenge = await sha256Base64Url(verifier);
    const authorizationUrl = new URL("/oauth/authorize", issuer);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", registered.client_id);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("scope", "read write offline_access");
    authorizationUrl.searchParams.set("resource", resource);
    authorizationUrl.searchParams.set("state", "state-1");

    const loginRequired = await app.request(authorizationUrl.toString());
    expect(loginRequired.status).toBe(302);
    expect(loginRequired.headers.get("location")).toStartWith(`${issuer}/auth/github/start?`);

    const consent = await app.request(authorizationUrl.toString(), {
      headers: { cookie: sessionCookie },
    });
    expect(consent.status).toBe(200);
    const html = await consent.text();
    const payload = hiddenValue(html, "request");
    const signature = hiddenValue(html, "signature");

    const approved = await app.request("/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie,
        origin: issuer,
      },
      body: new URLSearchParams({ request: payload, signature, decision: "approve" }),
    });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location") ?? "");
    expect(callback.searchParams.get("state")).toBe("state-1");
    const code = callback.searchParams.get("code");
    expect(code).toStartWith("oauth_code_");

    const token = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code: code ?? "",
        code_verifier: verifier,
        resource,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = await token.json() as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.access_token.split(".")).toHaveLength(3);
    expect(tokens.refresh_token).toStartWith("oauth_refresh_");
    expect(tokens.scope).toBe("read write offline_access");

    expect((await initialize(app, tokens.access_token)).status).toBe(200);
    expect((await initialize(app, "legacy-token")).status).toBe(200);

    const unauthorised = await initialize(app, "invalid-token");
    expect(unauthorised.status).toBe(401);
    expect(unauthorised.headers.get("www-authenticate")).toContain(
      `resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
    );

    const refreshed = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: tokens.refresh_token,
        resource,
      }),
    });
    expect(refreshed.status).toBe(200);
    const nextTokens = await refreshed.json() as {
      access_token: string;
      refresh_token: string;
    };
    expect(nextTokens.refresh_token).not.toBe(tokens.refresh_token);
    expect((await initialize(app, nextTokens.access_token)).status).toBe(200);

    const replay = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: tokens.refresh_token,
        resource,
      }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("rejects expired signed consent payloads", async () => {
    const app = createApp();
    const registration = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri] }),
    });
    const registered = await registration.json() as { client_id: string };
    const authorizationUrl = new URL("/oauth/authorize", issuer);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", registered.client_id);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", resource);

    const consent = await app.request(authorizationUrl.toString(), {
      headers: { cookie: sessionCookie },
    });
    const html = await consent.text();
    now += 11 * 60 * 1000;
    const expired = await app.request("/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie,
        origin: issuer,
      },
      body: new URLSearchParams({
        request: hiddenValue(html, "request"),
        signature: hiddenValue(html, "signature"),
        decision: "approve",
      }),
    });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: "invalid_request" });
  });
});

function createApp() {
  const accountService = new FixedAccountService();
  const mcpOAuth: McpOAuthOptions = {
    service,
    accountService,
    issuer,
    resource,
    workspace: "default",
    signingSecret: "0123456789abcdef0123456789abcdef",
    now: () => now,
    randomBytes: deterministicRandomBytes(),
  };
  return createHostedApp({
    ledger: new SqliteWorkLedger(store),
    authenticator: new FixedAuthenticator(),
    allowedOrigins: [],
    mcpOAuth,
  });
}

async function initialize(app: ReturnType<typeof createApp>, token: string) {
  return await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "oauth-test", version: "0.0.1" },
      },
    }),
  });
}

function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match?.[1]) throw new Error(`Missing hidden input ${name}`);
  return match[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function deterministicRandomBytes() {
  let call = 0;
  return (length: number) => new Uint8Array(length).fill(++call);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
