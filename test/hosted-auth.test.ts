import { describe, expect, test } from "bun:test";
import {
  createHostedAuth,
  HttpGitHubOAuthClient,
  type GitHubIdentity,
  type GitHubOAuthClient,
} from "../src/hosted-auth.ts";
import type {
  HostedAccountContext,
  HostedAccountService,
  HostedSessionContext,
  HostedSessionRecord,
  OAuthStateRecord,
} from "../src/hosted-account-service.ts";

class FakeGitHubClient implements GitHubOAuthClient {
  exchangeCount = 0;
  constructor(private readonly subject = "1001") {}

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string> {
    this.exchangeCount += 1;
    expect(input.redirectUri).toBe("https://api.stensibly.com/auth/github/callback");
    expect(input.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    if (input.code !== "valid-code") throw new Error("secret provider failure");
    return "provider-token";
  }

  async readIdentity(accessToken: string): Promise<GitHubIdentity> {
    expect(accessToken).toBe("provider-token");
    return {
      subject: this.subject,
      username: "teamleaderleo",
      displayName: "Leo",
      emailVerified: false,
      avatarUrl: "https://avatars.githubusercontent.com/u/1001?v=4",
    };
  }
}

class FakeAccountService implements HostedAccountService {
  states = new Map<string, {
    secretHash: string;
    pkceVerifierHash: string;
    returnTo: string;
    expiresAt: number;
  }>();
  sessions = new Map<string, {
    accountId: string;
    secretHash: string;
    expiresAt: number;
    revoked: boolean;
  }>();
  failTouch = false;
  failRevoke = false;

  async createOAuthState(input: {
    id: string;
    secretHash: string;
    pkceVerifierHash: string;
    returnTo: string;
    expiresAt: number;
  }): Promise<OAuthStateRecord> {
    this.states.set(input.id, input);
    return stateRecord(input.id, input.returnTo, input.expiresAt);
  }

  async consumeOAuthState(input: {
    id: string;
    secretHash: string;
    pkceVerifierHash: string;
  }): Promise<OAuthStateRecord | null> {
    const state = this.states.get(input.id);
    if (
      !state
      || state.secretHash !== input.secretHash
      || state.pkceVerifierHash !== input.pkceVerifierHash
    ) return null;
    this.states.delete(input.id);
    return { ...stateRecord(input.id, state.returnTo, state.expiresAt), consumedAt: new Date(1_000).toISOString() };
  }

  async upsertProviderIdentity(): Promise<HostedAccountContext> {
    return accountContext();
  }

  async createSession(input: {
    accountId: string;
    id: string;
    secretHash: string;
    expiresAt: number;
  }): Promise<HostedSessionRecord> {
    this.sessions.set(input.id, { ...input, revoked: false });
    return sessionRecord(input.id, input.expiresAt);
  }

  async authenticateSession(input: {
    id: string;
    secretHash: string;
    now: number;
  }): Promise<HostedSessionContext | null> {
    const session = this.sessions.get(input.id);
    if (
      !session
      || session.revoked
      || session.secretHash !== input.secretHash
      || session.expiresAt <= input.now
    ) return null;
    return sessionContext(input.id, session.expiresAt);
  }

  async touchSession(input: {
    id: string;
    secretHash: string;
  }): Promise<HostedSessionRecord | null> {
    if (this.failTouch) return null;
    const session = this.sessions.get(input.id);
    if (!session || session.revoked || session.secretHash !== input.secretHash) return null;
    return sessionRecord(input.id, session.expiresAt);
  }

  async revokeSession(input: {
    accountId: string;
    id: string;
  }): Promise<HostedSessionRecord | null> {
    if (this.failRevoke) throw new Error("secret backend failure");
    const session = this.sessions.get(input.id);
    if (!session || session.accountId !== input.accountId) return null;
    session.revoked = true;
    return { ...sessionRecord(input.id, session.expiresAt), revokedAt: new Date(1_000).toISOString() };
  }
}

describe("hosted GitHub authentication", () => {
  test("binds one-time state and PKCE, issues a secure session, and revokes it", async () => {
    const service = new FakeAccountService();
    const github = new FakeGitHubClient();
    const app = createHostedAuth(authOptions(service, github));

    const started = await app.request("/github/start?returnTo=https%3A%2F%2Fwww.stensibly.com%2Fprojects%2Falpha");
    expect(started.status).toBe(302);
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(started.headers.get("referrer-policy")).toBe("no-referrer");
    const authorize = new URL(started.headers.get("location") ?? "");
    expect(authorize.origin).toBe("https://github.com");
    expect(authorize.searchParams.get("client_id")).toBe("github-client-id");
    expect(authorize.searchParams.get("scope")).toBeNull();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const stateId = authorize.searchParams.get("state") ?? "";
    expect(stateId).toMatch(/^oauth_/);
    const oauthCookie = cookieValue(started, "__Secure-stensibly-oauth-state");
    expect(oauthCookie).not.toContain(stateId);
    expect(allCookies(started)).toContain("HttpOnly");
    expect(allCookies(started)).toContain("Secure");
    expect(allCookies(started)).toContain("SameSite=Lax");
    expect(allCookies(started)).toContain("Path=/auth/github/callback");

    const callback = await app.request(
      `/github/callback?code=valid-code&state=${encodeURIComponent(stateId)}`,
      { headers: { cookie: `__Secure-stensibly-oauth-state=${oauthCookie}` } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://www.stensibly.com/projects/alpha");
    const sessionCookie = cookieValue(callback, "__Host-stensibly-session");
    const setCookie = allCookies(callback);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    const current = await app.request("/session", {
      headers: {
        cookie: `__Host-stensibly-session=${sessionCookie}`,
        origin: "https://www.stensibly.com",
      },
    });
    expect(current.status).toBe(200);
    expect(current.headers.get("access-control-allow-origin")).toBe("https://www.stensibly.com");
    expect(current.headers.get("access-control-allow-credentials")).toBe("true");
    expect(await current.json()).toMatchObject({
      authenticated: true,
      account: { id: "acct_test" },
      principal: { type: "account", scopes: ["read", "write", "admin"] },
    });

    const logout = await app.request("/logout", {
      method: "POST",
      headers: {
        cookie: `__Host-stensibly-session=${sessionCookie}`,
        origin: "https://www.stensibly.com",
      },
    });
    expect(logout.status).toBe(204);
    expect(allCookies(logout)).toContain("__Host-stensibly-session=");

    const afterLogout = await app.request("/session", {
      headers: { cookie: `__Host-stensibly-session=${sessionCookie}` },
    });
    expect(afterLogout.status).toBe(401);
  });

  test("rejects callback replay, mismatched state, unapproved returns, and origins", async () => {
    const service = new FakeAccountService();
    const github = new FakeGitHubClient();
    const app = createHostedAuth(authOptions(service, github));

    const badReturn = await app.request("/github/start?returnTo=https%3A%2F%2Fevil.example%2F");
    expect(badReturn.status).toBe(400);
    expect(JSON.stringify(await badReturn.json())).not.toContain("evil.example/");

    const started = await app.request("/github/start");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cookie = cookieValue(started, "__Secure-stensibly-oauth-state");
    const mismatch = await app.request("/github/callback?code=valid-code&state=oauth_wrong12345678", {
      headers: { cookie: `__Secure-stensibly-oauth-state=${cookie}` },
    });
    expect(mismatch.status).toBe(400);
    expect(github.exchangeCount).toBe(0);

    const success = await app.request(`/github/callback?code=valid-code&state=${state}`, {
      headers: { cookie: `__Secure-stensibly-oauth-state=${cookie}` },
    });
    expect(success.status).toBe(302);
    const replay = await app.request(`/github/callback?code=valid-code&state=${state}`, {
      headers: { cookie: `__Secure-stensibly-oauth-state=${cookie}` },
    });
    expect(replay.status).toBe(400);

    const cors = await app.request("/session", { headers: { origin: "https://evil.example" } });
    expect(cors.status).toBe(403);
    const logout = await app.request("/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(logout.status).toBe(403);
  });

  test("fails closed across session-touch races and preserves the cookie on revocation failure", async () => {
    const service = new FakeAccountService();
    const app = createHostedAuth(authOptions(service, new FakeGitHubClient()));
    const sessionCookie = await signIn(app);

    service.failTouch = true;
    const raced = await app.request("/session", {
      headers: { cookie: `__Host-stensibly-session=${sessionCookie}` },
    });
    expect(raced.status).toBe(401);
    expect(await raced.json()).toEqual({ authenticated: false });
    expect(allCookies(raced)).toContain("__Host-stensibly-session=");

    service.failTouch = false;
    service.failRevoke = true;
    const failedLogout = await app.request("/logout", {
      method: "POST",
      headers: {
        cookie: `__Host-stensibly-session=${sessionCookie}`,
        origin: "https://www.stensibly.com",
      },
    });
    expect(failedLogout.status).toBe(502);
    expect(allCookies(failedLogout)).not.toContain("__Host-stensibly-session=");
    const stillActive = await app.request("/session", {
      headers: { cookie: `__Host-stensibly-session=${sessionCookie}` },
    });
    expect(stillActive.status).toBe(200);
  });

  test("rejects inherited GitHub OAuth scopes and malformed provider identity", async () => {
    const scoped = new HttpGitHubOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: (async () => Response.json({ access_token: "provider-token", scope: "user:email" })) as typeof fetch,
    });
    await expect(scoped.exchangeCode({
      code: "code",
      redirectUri: "https://api.stensibly.com/auth/github/callback",
      codeVerifier: "v".repeat(43),
    })).rejects.toThrow("GitHub authorization failed");

    const malformed = new HttpGitHubOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: (async () => Response.json(
        { id: -1, login: "teamleaderleo" },
        { headers: { "x-oauth-scopes": "" } },
      )) as typeof fetch,
    });
    await expect(malformed.readIdentity("provider-token"))
      .rejects.toThrow("GitHub identity subject is invalid");
  });
});

async function signIn(app: ReturnType<typeof createHostedAuth>): Promise<string> {
  const started = await app.request("/github/start");
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const oauthCookie = cookieValue(started, "__Secure-stensibly-oauth-state");
  const callback = await app.request(`/github/callback?code=valid-code&state=${state}`, {
    headers: { cookie: `__Secure-stensibly-oauth-state=${oauthCookie}` },
  });
  return cookieValue(callback, "__Host-stensibly-session");
}

function authOptions(service: HostedAccountService, github: GitHubOAuthClient) {
  return {
    accountService: service,
    githubClient: github,
    githubClientId: "github-client-id",
    authOrigin: "https://api.stensibly.com",
    allowedReturnOrigins: ["https://www.stensibly.com"],
    allowedGitHubSubjects: ["1001"],
    now: () => 1_000,
    randomBytes: deterministicRandomBytes(),
  };
}

function deterministicRandomBytes() {
  let call = 0;
  return (length: number) => new Uint8Array(length).fill(++call);
}

function cookieValue(response: Response, name: string): string {
  const raw = allCookies(response);
  const match = raw.match(new RegExp(`${name}=([^;,]+)`));
  if (!match?.[1]) throw new Error(`Missing cookie ${name}: ${raw}`);
  return match[1];
}

function allCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.().join(",") ?? response.headers.get("set-cookie") ?? "";
}

function stateRecord(id: string, returnTo: string, expiresAt: number): OAuthStateRecord {
  return {
    id,
    returnTo,
    createdAt: new Date(1_000).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    consumedAt: null,
  };
}

function accountContext(): HostedAccountContext {
  return {
    account: {
      id: "acct_test",
      displayName: "Leo",
      primaryEmail: null,
      avatarUrl: null,
      defaultActorId: "leo",
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
      disabledAt: null,
    },
    identity: {
      provider: "github",
      subject: "1001",
      username: "teamleaderleo",
      email: null,
      emailVerified: false,
      avatarUrl: null,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
    },
    membership: {
      workspace: "test",
      role: "owner",
      projects: null,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
      revokedAt: null,
    },
  };
}

function sessionContext(id: string, expiresAt: number): HostedSessionContext {
  const account = accountContext();
  return {
    session: sessionRecord(id, expiresAt),
    account: account.account,
    membership: account.membership,
    principal: {
      type: "account",
      accountId: account.account.id,
      name: account.account.displayName,
      workspace: "test",
      role: "owner",
      scopes: ["read", "write", "admin"],
      projects: null,
    },
    capabilities: { read: true, write: true, admin: true },
  };
}

function sessionRecord(id: string, expiresAt: number): HostedSessionRecord {
  return {
    id,
    userAgent: null,
    createdAt: new Date(1_000).toISOString(),
    lastSeenAt: new Date(1_000).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: null,
  };
}
