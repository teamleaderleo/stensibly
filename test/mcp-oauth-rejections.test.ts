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
const otherRedirectUri = "https://chatgpt.com/connector/oauth/other";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const validSessionCookie = "__Host-stensibly-session=ses_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEF";
const invalidSessionCookie = "__Host-stensibly-session=ses_unknownsession.abcdefghijklmnopqrstuvwxyzABCDEF";

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
  family: string;
  scopes: McpOAuthGrant["scopes"];
  resource: string;
  expiresAt: number;
  consumed: boolean;
  revoked: boolean;
}

class RejectionOAuthService implements McpOAuthService {
  readonly clients = new Map<string, McpOAuthClientRecord>();
  readonly codes = new Map<string, StoredCode>();
  readonly refresh = new Map<string, StoredRefresh>();

  constructor(private readonly now: () => number) {}

  async registerClient(input: Parameters<McpOAuthService["registerClient"]>[0]) {
    const record: McpOAuthClientRecord = {
      ...input,
      createdAt: new Date(this.now()).toISOString(),
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
    return grant(input.clientId, input.resource, input.scopes);
  }

  async exchangeAuthorizationCode(input: Parameters<McpOAuthService["exchangeAuthorizationCode"]>[0]) {
    const code = this.codes.get(input.id);
    if (!code || code.expiresAt <= this.now()) {
      if (code) this.codes.delete(code.id);
      return null;
    }
    if (
      code.secretHash !== input.secretHash
      || code.clientId !== input.clientId
      || code.redirectUri !== input.redirectUri
      || code.codeChallenge !== input.codeChallenge
    ) {
      this.codes.delete(code.id);
      return null;
    }
    this.codes.delete(code.id);
    if (code.scopes.includes("offline_access")) {
      this.refresh.set(input.refreshId, {
        id: input.refreshId,
        secretHash: input.refreshSecretHash,
        clientId: input.clientId,
        family: input.refreshId,
        scopes: code.scopes,
        resource: code.resource,
        expiresAt: input.refreshExpiresAt,
        consumed: false,
        revoked: false,
      });
    }
    return grant(input.clientId, code.resource, code.scopes);
  }

  async rotateRefreshToken(
    input: Parameters<McpOAuthService["rotateRefreshToken"]>[0],
  ): Promise<McpOAuthRefreshExchange> {
    const current = this.refresh.get(input.id);
    if (
      !current
      || current.secretHash !== input.secretHash
      || current.clientId !== input.clientId
      || current.expiresAt <= this.now()
    ) return { status: "invalid" };
    if (current.consumed || current.revoked) {
      for (const token of this.refresh.values()) {
        if (token.family === current.family) token.revoked = true;
      }
      return { status: "replayed" };
    }
    current.consumed = true;
    this.refresh.set(input.nextId, {
      id: input.nextId,
      secretHash: input.nextSecretHash,
      clientId: input.clientId,
      family: current.family,
      scopes: current.scopes,
      resource: current.resource,
      expiresAt: input.nextExpiresAt,
      consumed: false,
      revoked: false,
    });
    return {
      status: "ok",
      grant: grant(current.clientId, current.resource, current.scopes),
    };
  }
}

class RejectionAccountService implements Pick<HostedAccountService, "authenticateSession"> {
  available = true;
  expiresAt = 2_000_000;

  constructor(private readonly now: () => number) {}

  async authenticateSession(
    input: Parameters<HostedAccountService["authenticateSession"]>[0],
  ): Promise<HostedSessionContext | null> {
    if (!this.available || input.id !== "ses_abcdefghijkl" || this.expiresAt <= this.now()) {
      return null;
    }
    return sessionContext(this.expiresAt);
  }
}

describe("MCP OAuth rejection paths", () => {
  test("fails closed for consent CSRF, denial, and invalid sessions", async () => {
    const fixture = await createFixture();
    const consent = await fixture.loadConsent();

    const missingOrigin = await fixture.app.request("/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: validSessionCookie,
      },
      body: consentForm(consent, "approve"),
    });
    expect(missingOrigin.status).toBe(403);

    const denied = await fixture.app.request("/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: validSessionCookie,
        origin: issuer,
      },
      body: consentForm(consent, "deny"),
    });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("error"))
      .toBe("access_denied");

    for (const cookie of [undefined, invalidSessionCookie]) {
      const response = await fixture.app.request("/oauth/consent", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(cookie ? { cookie } : {}),
          origin: issuer,
        },
        body: consentForm(consent, "approve"),
      });
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "").searchParams.get("error"))
        .toBe("login_required");
    }

    fixture.accountService.expiresAt = fixture.now();
    const expired = await fixture.app.request("/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: validSessionCookie,
        origin: issuer,
      },
      body: consentForm(consent, "approve"),
    });
    expect(expired.status).toBe(302);
    expect(new URL(expired.headers.get("location") ?? "").searchParams.get("error"))
      .toBe("login_required");
  });

  test("rejects mismatched code exchanges and expires codes", async () => {
    for (const override of [
      { code_verifier: "z".repeat(43) },
      { redirect_uri: otherRedirectUri },
      { client_id: "oauth_client_differentxxx" },
    ]) {
      const fixture = await createFixture();
      const code = await fixture.approve();
      const response = await fixture.exchangeCode(code, override);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });

      const retry = await fixture.exchangeCode(code);
      expect(retry.status).toBe(400);
    }

    const wrongResource = await createFixture();
    const resourceCode = await wrongResource.approve();
    const resourceResponse = await wrongResource.exchangeCode(resourceCode, {
      resource: `${issuer}/other`,
    });
    expect(resourceResponse.status).toBe(400);

    const expiredFixture = await createFixture();
    const expiredCode = await expiredFixture.approve();
    expiredFixture.advance(301_000);
    const expiredResponse = await expiredFixture.exchangeCode(expiredCode);
    expect(expiredResponse.status).toBe(400);
    expect(await expiredResponse.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("revokes the active refresh token after replay", async () => {
    const fixture = await createFixture();
    const code = await fixture.approve();
    const issued = await fixture.exchangeCode(code);
    expect(issued.status).toBe(200);
    const first = await issued.json() as { refresh_token: string };

    const rotated = await fixture.exchangeRefresh(first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = await rotated.json() as { refresh_token: string };

    const replay = await fixture.exchangeRefresh(first.refresh_token);
    expect(replay.status).toBe(400);

    const activeAfterReplay = await fixture.exchangeRefresh(second.refresh_token);
    expect(activeAfterReplay.status).toBe(400);
  });
});

async function createFixture() {
  let clock = 1_000_000;
  const now = () => clock;
  const service = new RejectionOAuthService(now);
  const accountService = new RejectionAccountService(now);
  const app = createMcpOAuth({
    service,
    accountService,
    issuer,
    resource,
    workspace: "default",
    signingSecret: "0123456789abcdef0123456789abcdef",
    now,
    randomBytes: deterministicRandomBytes(),
  });
  const registration = await app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [redirectUri, otherRedirectUri],
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
  authorizationUrl.searchParams.set("scope", "read write offline_access");
  authorizationUrl.searchParams.set("resource", resource);
  authorizationUrl.searchParams.set("state", "rejection-state");

  async function loadConsent() {
    const response = await app.request(authorizationUrl.toString(), {
      headers: { cookie: validSessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    return {
      request: hiddenValue(html, "request"),
      signature: hiddenValue(html, "signature"),
    };
  }

  async function approve() {
    const consent = await loadConsent();
    const response = await app.request("/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: validSessionCookie,
        origin: issuer,
      },
      body: consentForm(consent, "approve"),
    });
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get("location") ?? "").searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");
    return code;
  }

  async function exchangeCode(
    code: string,
    override: Partial<Record<"client_id" | "redirect_uri" | "code_verifier" | "resource", string>> = {},
  ) {
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

  async function exchangeRefresh(refreshToken: string) {
    return await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: refreshToken,
        resource,
      }),
    });
  }

  return {
    app,
    accountService,
    now,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    loadConsent,
    approve,
    exchangeCode,
    exchangeRefresh,
  };
}

function consentForm(
  consent: { request: string; signature: string },
  decision: "approve" | "deny",
) {
  return new URLSearchParams({ ...consent, decision });
}

function sessionContext(expiresAt: number): HostedSessionContext {
  return {
    session: {
      id: "ses_abcdefghijkl",
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

function grant(
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
