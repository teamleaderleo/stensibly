import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import type {
  HostedAccountService,
  HostedSessionContext,
} from "../src/hosted-account-service.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import {
  MCP_OAUTH_CONSENT_REQUEST_SECONDS,
} from "../src/mcp-oauth-protocol.ts";
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
const alternateRedirectUri = "https://example.com/oauth/callback";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const sessionId = "ses_abcdefghijkl";
const sessionSecret = "abcdefghijklmnopqrstuvwxyzABCDEF";
const sessionSecretHash = "cfd2f1fad75a1978da0a444883db7251414b139f31f5a04704c291fdb0e175e6";
const sessionCookie = `__Host-stensibly-session=${sessionId}.${sessionSecret}`;
const authorizationCodeSeconds = 300;
const refreshTokenSeconds = 3_600;

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
  session: HostedSessionContext | null;

  constructor(currentTime: number) {
    this.session = sessionContext(currentTime + 24 * 60 * 60 * 1000);
  }

  async authenticateSession(
    input: Parameters<HostedAccountService["authenticateSession"]>[0],
  ): Promise<HostedSessionContext | null> {
    if (input.id !== sessionId || input.secretHash !== sessionSecretHash) return null;
    if (!this.session) return null;
    if (Date.parse(this.session.session.expiresAt) <= input.now) return null;
    return this.session;
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
  expiresAt: number;
}

interface StoredRefresh {
  id: string;
  secretHash: string;
  clientId: string;
  consumed: boolean;
  family: string;
  scopes: McpOAuthGrant["scopes"];
  resource: string;
  expiresAt: number;
}

class MemoryOAuthService implements McpOAuthService {
  clients = new Map<string, McpOAuthClientRecord>();
  codes = new Map<string, StoredCode>();
  refresh = new Map<string, StoredRefresh>();

  constructor(private readonly currentTime: () => number) {}

  async registerClient(input: Parameters<McpOAuthService["registerClient"]>[0]) {
    const record: McpOAuthClientRecord = {
      ...input,
      createdAt: new Date(this.currentTime()).toISOString(),
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
      expiresAt: input.expiresAt,
    });
    return this.grant(input.clientId, input.resource, input.scopes);
  }

  async exchangeAuthorizationCode(input: Parameters<McpOAuthService["exchangeAuthorizationCode"]>[0]) {
    const code = this.codes.get(input.id);
    if (!code) return null;
    if (
      code.expiresAt <= this.currentTime()
      || code.secretHash !== input.secretHash
      || code.clientId !== input.clientId
      || code.redirectUri !== input.redirectUri
      || code.codeChallenge !== input.codeChallenge
    ) {
      this.codes.delete(input.id);
      return null;
    }
    this.codes.delete(input.id);
    if (code.scopes.includes("offline_access")) {
      this.refresh.set(input.refreshId, {
        id: input.refreshId,
        secretHash: input.refreshSecretHash,
        clientId: input.clientId,
        consumed: false,
        family: input.refreshId,
        scopes: code.scopes,
        resource: code.resource,
        expiresAt: input.refreshExpiresAt,
      });
    }
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
    if (current.expiresAt <= this.currentTime()) {
      current.consumed = true;
      return { status: "invalid" };
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
      expiresAt: input.nextExpiresAt,
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

interface ConsentFields {
  request: string;
  signature: string;
}

interface IssuedCode {
  clientId: string;
  code: string;
  state: string;
}

let store: StensiblyStore;
let service: MemoryOAuthService;
let accountService: FixedAccountService;
let now: number;

beforeEach(() => {
  now = 1_000_000;
  store = new StensiblyStore(":memory:");
  service = new MemoryOAuthService(() => now);
  accountService = new FixedAccountService(now);
});

afterEach(() => store.close());

describe("MCP OAuth HTTP flow", () => {
  test("publishes discovery and registers a bounded public client", async () => {
    const app = createApp();
    const resourceMetadata = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(resourceMetadata.status).toBe(200);
    expect(await resourceMetadata.json()).toMatchObject({
      resource,
      authorization_servers: [issuer],
    });

    const serverMetadata = await app.request("/.well-known/oauth-authorization-server");
    expect(serverMetadata.status).toBe(200);
    expect(await serverMetadata.json()).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });

    const registered = await registerClient(app);
    expect(registered.client_id).toStartWith("oauth_client_");
  });

  test("requires a current hosted session for authorization and consent", async () => {
    const app = createApp();
    const client = await registerClient(app);
    const url = await authorizationUrl(client.client_id);

    const loginRequired = await app.request(url.toString());
    expect(loginRequired.status).toBe(302);
    expect(loginRequired.headers.get("location")).toStartWith(`${issuer}/auth/github/start?`);

    const unknownSession = await app.request(url.toString(), {
      headers: { cookie: "__Host-stensibly-session=ses_unknownsession.abcdefghijklmnopqrstuvwxyzABCDEF" },
    });
    expect(unknownSession.status).toBe(302);
    expect(unknownSession.headers.get("location")).toStartWith(`${issuer}/auth/github/start?`);

    const consent = await loadConsent(app, url);
    accountService.session = null;
    const missingSession = await submitConsent(app, consent, "approve", { cookie: undefined });
    expect(missingSession.status).toBe(302);
    expect(new URL(missingSession.headers.get("location") ?? "").searchParams.get("error"))
      .toBe("login_required");

    accountService.session = sessionContext(now - 1);
    const expiredSession = await submitConsent(app, consent, "approve");
    expect(expiredSession.status).toBe(302);
    expect(new URL(expiredSession.headers.get("location") ?? "").searchParams.get("error"))
      .toBe("login_required");
  });

  test("enforces consent origin and denial without issuing a code", async () => {
    const app = createApp();
    const client = await registerClient(app);
    const consent = await loadConsent(app, await authorizationUrl(client.client_id));

    const noOrigin = await submitConsent(app, consent, "approve", { origin: undefined });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ error: "access_denied" });

    const denied = await submitConsent(app, consent, "deny");
    expect(denied.status).toBe(302);
    const denial = new URL(denied.headers.get("location") ?? "");
    expect(denial.searchParams.get("error")).toBe("access_denied");
  });

  test("redirects scope errors only after validating the client redirect", async () => {
    const app = createApp();
    const client = await registerClient(app);
    const invalidScope = await authorizationUrl(client.client_id, {
      scope: "read unsupported",
      state: "scope-state",
    });
    const response = await app.request(invalidScope.toString());
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location") ?? "");
    expect(redirect.origin + redirect.pathname).toBe(redirectUri);
    expect(redirect.searchParams.get("error")).toBe("invalid_scope");
    expect(redirect.searchParams.get("state")).toBe("scope-state");

    invalidScope.searchParams.set("redirect_uri", alternateRedirectUri);
    const untrustedRedirect = await app.request(invalidScope.toString());
    expect(untrustedRedirect.status).toBe(400);
    expect(untrustedRedirect.headers.get("location")).toBeNull();
  });

  test("rejects stale signed consent payloads with explicit setup assertions", async () => {
    const app = createApp();
    const client = await registerClient(app);
    const consent = await loadConsent(app, await authorizationUrl(client.client_id));
    now += (MCP_OAUTH_CONSENT_REQUEST_SECONDS + 1) * 1000;

    const expired = await submitConsent(app, consent, "approve");
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: "invalid_request" });
  });

  test("rejects wrong verifier, redirect, client, and resource at token exchange", async () => {
    const app = createApp();

    const wrongVerifier = await issueCode(app);
    expect((await exchangeAuthorizationCode(app, wrongVerifier, {
      verifier: `${verifier.slice(0, -1)}A`,
    })).status).toBe(400);

    const wrongRedirect = await issueCode(app);
    expect((await exchangeAuthorizationCode(app, wrongRedirect, {
      redirectUri: alternateRedirectUri,
    })).status).toBe(400);

    const wrongClient = await issueCode(app);
    expect((await exchangeAuthorizationCode(app, wrongClient, {
      clientId: "oauth_client_competingactor",
    })).status).toBe(400);

    const wrongResource = await issueCode(app);
    expect((await exchangeAuthorizationCode(app, wrongResource, {
      resource: `${issuer}/other`,
    })).status).toBe(400);
  });

  test("rejects expired authorization codes", async () => {
    const app = createApp();
    const issued = await issueCode(app);
    now += (authorizationCodeSeconds + 1) * 1000;
    const response = await exchangeAuthorizationCode(app, issued);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("issues audience-bound access and refresh tokens while preserving legacy bearer access", async () => {
    const app = createApp();
    const issued = await issueCode(app);
    const token = await exchangeAuthorizationCode(app, issued);
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
  });

  test("does not issue refresh tokens without offline_access", async () => {
    const app = createApp();
    const issued = await issueCode(app, { scope: "read" });
    const token = await exchangeAuthorizationCode(app, issued);
    expect(token.status).toBe(200);
    const tokens = await token.json() as Record<string, unknown>;
    expect(tokens.scope).toBe("read");
    expect(tokens.refresh_token).toBeUndefined();
  });

  test("rotates refresh tokens and revokes the active leaf after replay", async () => {
    const app = createApp();
    const issued = await issueCode(app);
    const token = await exchangeAuthorizationCode(app, issued);
    const tokens = await token.json() as { refresh_token: string };

    const refreshed = await exchangeRefreshToken(app, issued.clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const nextTokens = await refreshed.json() as {
      access_token: string;
      refresh_token: string;
    };
    expect(nextTokens.refresh_token).not.toBe(tokens.refresh_token);
    expect((await initialize(app, nextTokens.access_token)).status).toBe(200);

    const replay = await exchangeRefreshToken(app, issued.clientId, tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    const revokedLeaf = await exchangeRefreshToken(app, issued.clientId, nextTokens.refresh_token);
    expect(revokedLeaf.status).toBe(400);
    expect(await revokedLeaf.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("rejects expired refresh tokens", async () => {
    const app = createApp();
    const issued = await issueCode(app);
    const token = await exchangeAuthorizationCode(app, issued);
    const tokens = await token.json() as { refresh_token: string };
    now += (refreshTokenSeconds + 1) * 1000;

    const expired = await exchangeRefreshToken(app, issued.clientId, tokens.refresh_token);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: "invalid_grant" });
  });
});

function createApp() {
  const mcpOAuth: McpOAuthOptions = {
    service,
    accountService,
    issuer,
    resource,
    workspace: "default",
    signingSecret: "0123456789abcdef0123456789abcdef",
    authorizationCodeSeconds,
    refreshTokenSeconds,
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

async function registerClient(app: ReturnType<typeof createApp>) {
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
  return await registration.json() as { client_id: string };
}

async function authorizationUrl(
  clientId: string,
  overrides: { scope?: string; state?: string } = {},
) {
  const url = new URL("/oauth/authorize", issuer);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", overrides.scope ?? "read write offline_access");
  url.searchParams.set("resource", resource);
  url.searchParams.set("state", overrides.state ?? "state-1");
  return url;
}

async function loadConsent(
  app: ReturnType<typeof createApp>,
  url: URL,
): Promise<ConsentFields> {
  const consent = await app.request(url.toString(), {
    headers: { cookie: sessionCookie },
  });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  return {
    request: hiddenValue(html, "request"),
    signature: hiddenValue(html, "signature"),
  };
}

async function submitConsent(
  app: ReturnType<typeof createApp>,
  consent: ConsentFields,
  decision: "approve" | "deny",
  overrides: { origin?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  const origin = Object.prototype.hasOwnProperty.call(overrides, "origin")
    ? overrides.origin
    : issuer;
  const cookie = Object.prototype.hasOwnProperty.call(overrides, "cookie")
    ? overrides.cookie
    : sessionCookie;
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return await app.request("/oauth/consent", {
    method: "POST",
    headers,
    body: new URLSearchParams({
      request: consent.request,
      signature: consent.signature,
      decision,
    }),
  });
}

async function issueCode(
  app: ReturnType<typeof createApp>,
  overrides: { scope?: string } = {},
): Promise<IssuedCode> {
  const registered = await registerClient(app);
  const state = `state-${registered.client_id}`;
  const consent = await loadConsent(app, await authorizationUrl(registered.client_id, {
    scope: overrides.scope,
    state,
  }));
  const approved = await submitConsent(app, consent, "approve");
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get("location") ?? "");
  expect(callback.searchParams.get("state")).toBe(state);
  const code = callback.searchParams.get("code");
  expect(code).toStartWith("oauth_code_");
  if (!code) throw new Error("Authorization code was not returned");
  return { clientId: registered.client_id, code, state };
}

async function exchangeAuthorizationCode(
  app: ReturnType<typeof createApp>,
  issued: IssuedCode,
  overrides: {
    verifier?: string;
    redirectUri?: string;
    clientId?: string;
    resource?: string;
  } = {},
) {
  return await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: overrides.clientId ?? issued.clientId,
      redirect_uri: overrides.redirectUri ?? redirectUri,
      code: issued.code,
      code_verifier: overrides.verifier ?? verifier,
      resource: overrides.resource ?? resource,
    }),
  });
}

async function exchangeRefreshToken(
  app: ReturnType<typeof createApp>,
  clientId: string,
  refreshToken: string,
) {
  return await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource,
    }),
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

function sessionContext(expiresAt: number): HostedSessionContext {
  return {
    session: {
      id: sessionId,
      userAgent: "test",
      createdAt: new Date(0).toISOString(),
      lastSeenAt: new Date(0).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
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
