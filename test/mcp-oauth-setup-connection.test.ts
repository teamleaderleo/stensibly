import { describe, expect, test } from "bun:test";
import type {
  HostedAccountService,
  HostedSessionContext,
} from "../src/hosted-account-service.ts";
import type {
  McpOAuthClientRecord,
  McpOAuthGrant,
  McpOAuthRefreshExchange,
  McpOAuthService,
} from "../src/mcp-oauth-service.ts";
import { createMcpOAuth } from "../src/mcp-oauth.ts";

const issuer = "https://api.stensibly.com";
const resource = `${issuer}/mcp`;
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const sessionCookie = "__Host-stensibly-session=ses_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEF";

type ConnectionRecord = {
  accountId: string;
  clientId: string;
  resource: string;
  projects: string[] | null;
};

type StoredCode = {
  accountId: string;
  id: string;
  secretHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: McpOAuthGrant["scopes"];
  resource: string;
};

class SetupConnectionOAuthService implements McpOAuthService {
  readonly clients = new Map<string, McpOAuthClientRecord>();
  readonly recordAttempts: ConnectionRecord[] = [];
  code: StoredCode | null = null;
  failRecorder = false;

  async registerClient(input: Parameters<McpOAuthService["registerClient"]>[0]) {
    const record: McpOAuthClientRecord = {
      ...input,
      createdAt: new Date(1_000_000).toISOString(),
    };
    this.clients.set(record.clientId, record);
    return record;
  }

  async getClient(clientId: string) {
    return this.clients.get(clientId) ?? null;
  }

  async createAuthorizationCode(input: Parameters<McpOAuthService["createAuthorizationCode"]>[0]) {
    this.code = {
      accountId: input.accountId,
      id: input.id,
      secretHash: input.secretHash,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      resource: input.resource,
    };
    return grant(input.clientId, input.resource, input.scopes, input.accountId);
  }

  async exchangeAuthorizationCode(input: Parameters<McpOAuthService["exchangeAuthorizationCode"]>[0]) {
    const code = this.code;
    if (
      !code
      || code.id !== input.id
      || code.secretHash !== input.secretHash
      || code.clientId !== input.clientId
      || code.redirectUri !== input.redirectUri
      || code.codeChallenge !== input.codeChallenge
    ) return null;
    this.code = null;
    return grant(code.clientId, code.resource, code.scopes, code.accountId);
  }

  async rotateRefreshToken(): Promise<McpOAuthRefreshExchange> {
    return { status: "invalid" };
  }

  async recordSetupConnection(input: ConnectionRecord): Promise<void> {
    this.recordAttempts.push(Object.freeze({
      ...input,
      projects: input.projects === null ? null : [...input.projects],
    }));
    if (this.failRecorder) throw new Error("private evidence backend failure");
  }
}

class SetupConnectionAccountService implements Pick<HostedAccountService, "authenticateSession"> {
  async authenticateSession(
    input: Parameters<HostedAccountService["authenticateSession"]>[0],
  ): Promise<HostedSessionContext | null> {
    return input.id === "ses_abcdefghijkl" ? sessionContext() : null;
  }
}

describe("MCP OAuth setup connection evidence capture", () => {
  test("records account, client, resource, and issuance-time projects after a successful token response", async () => {
    const fixture = await createFixture();
    const code = await fixture.approve();
    expect(fixture.service.recordAttempts).toEqual([]);

    const response = await fixture.exchange(code);
    expect(response.status).toBe(200);
    const tokenPayload = await response.json() as Record<string, unknown>;
    expect(typeof tokenPayload.access_token).toBe("string");
    expect(fixture.service.recordAttempts).toEqual([{
      accountId: "acct_test",
      clientId: fixture.clientId,
      resource,
      projects: ["scrapbook"],
    }]);
    expect(Object.keys(fixture.service.recordAttempts[0] ?? {}).sort()).toEqual([
      "accountId",
      "clientId",
      "projects",
      "resource",
    ]);
    expect(JSON.stringify(fixture.service.recordAttempts)).not.toContain("access_token");
    expect(JSON.stringify(fixture.service.recordAttempts)).not.toContain("refresh_token");
  });

  test("keeps OAuth successful when setup evidence persistence fails", async () => {
    const fixture = await createFixture();
    const code = await fixture.approve();
    fixture.service.failRecorder = true;

    const response = await fixture.exchange(code);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token_type: "Bearer",
      scope: "read offline_access",
    });
    expect(fixture.service.recordAttempts).toEqual([{
      accountId: "acct_test",
      clientId: fixture.clientId,
      resource,
      projects: ["scrapbook"],
    }]);
  });

  test("does not record a rejected authorization-code exchange", async () => {
    const fixture = await createFixture();
    const code = await fixture.approve();

    const response = await fixture.exchange(code, { resource: `${issuer}/other` });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(fixture.service.recordAttempts).toEqual([]);
  });
});

async function createFixture() {
  const service = new SetupConnectionOAuthService();
  const app = createMcpOAuth({
    service,
    accountService: new SetupConnectionAccountService(),
    issuer,
    resource,
    workspace: "default",
    signingSecret: "0123456789abcdef0123456789abcdef",
    now: () => 1_000_000,
    randomBytes: deterministicRandomBytes(),
  });

  const registration = await app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registration.status).toBe(201);
  const registered = await registration.json() as { client_id: string };

  const authorizationUrl = new URL("/oauth/authorize", issuer);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", registered.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("scope", "read offline_access");
  authorizationUrl.searchParams.set("resource", resource);
  authorizationUrl.searchParams.set("state", "setup-connection-state");

  async function approve() {
    const authorization = await app.request(authorizationUrl.toString(), {
      headers: { cookie: sessionCookie },
    });
    expect(authorization.status).toBe(200);
    const html = await authorization.text();
    const consent = {
      request: hiddenValue(html, "request"),
      signature: hiddenValue(html, "signature"),
    };
    const approved = await app.request("/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie,
        origin: issuer,
      },
      body: new URLSearchParams({ ...consent, decision: "approve" }),
    });
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");
    return code;
  }

  async function exchange(code: string, override: Record<string, string> = {}) {
    return await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
        resource,
        ...override,
      }),
    });
  }

  return { app, service, clientId: registered.client_id, approve, exchange };
}

function sessionContext(): HostedSessionContext {
  return {
    session: {
      id: "ses_abcdefghijkl",
      userAgent: "test",
      createdAt: new Date(0).toISOString(),
      lastSeenAt: new Date(0).toISOString(),
      expiresAt: new Date(2_000_000).toISOString(),
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
      scopes: ["read"],
      projects: ["scrapbook"],
    },
    capabilities: { read: true, write: false, admin: false },
  };
}

function grant(
  clientId: string,
  requestedResource: string,
  scopes: McpOAuthGrant["scopes"],
  accountId: string,
): McpOAuthGrant {
  return {
    clientId,
    resource: requestedResource,
    scopes,
    principal: {
      accountId,
      name: "Leo",
      workspace: "default",
      role: "member",
      scopes: ["read"],
      projects: ["scrapbook"],
    },
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
