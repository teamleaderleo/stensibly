import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  HostedAccountContext,
  HostedAccountService,
  HostedSessionContext,
  HostedSessionRecord,
  OAuthStateRecord,
} from "../src/hosted-account-service.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import { HOSTED_SESSION_COOKIE } from "../src/hosted-session-credential.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";
import { FAILURE_CATEGORY_HEADER } from "../src/worker-observability.ts";

const dashboardOrigin = "https://dashboard.stensibly.com";
const machineOrigin = "https://automation.example";
const sessionId = "ses_abcdefghijklmnop";
const sessionSecret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const sessionCookie = `${HOSTED_SESSION_COOKIE}=${sessionId}.${sessionSecret}`;
const actor = { id: "leo", name: "Leo", kind: "human" as const };
const protocolVersion = "2025-06-18";

class FixedTokenAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    if (rawToken !== "hosted-token") return null;
    return {
      tokenId: "tok_hosted",
      name: "Hosted bearer",
      scopes: ["read", "write"],
      projects: ["scrapbook"],
    };
  }
}

class FixedAccountService implements HostedAccountService {
  available = true;
  fail = false;
  lastAuthentication: { id: string; secretHash: string; now: number } | null = null;

  async authenticateSession(input: {
    id: string;
    secretHash: string;
    now: number;
  }): Promise<HostedSessionContext | null> {
    this.lastAuthentication = input;
    if (this.fail) throw new Error("session backend unavailable");
    if (!this.available || input.id !== sessionId) return null;
    return sessionContext;
  }

  async createOAuthState(): Promise<OAuthStateRecord> {
    throw new Error("not used");
  }

  async consumeOAuthState(): Promise<OAuthStateRecord | null> {
    throw new Error("not used");
  }

  async upsertProviderIdentity(): Promise<HostedAccountContext> {
    throw new Error("not used");
  }

  async createSession(): Promise<HostedSessionRecord> {
    throw new Error("not used");
  }

  async touchSession(): Promise<HostedSessionRecord | null> {
    throw new Error("not used");
  }

  async revokeSession(): Promise<HostedSessionRecord | null> {
    throw new Error("not used");
  }
}

const sessionContext: HostedSessionContext = {
  session: {
    id: sessionId,
    userAgent: null,
    createdAt: "2026-07-25T13:00:00.000Z",
    lastSeenAt: "2026-07-25T13:00:00.000Z",
    expiresAt: "2026-08-24T13:00:00.000Z",
    revokedAt: null,
  },
  account: {
    id: "acct_internal_identifier",
    displayName: "Dashboard member",
    primaryEmail: "member@example.com",
    avatarUrl: null,
    defaultActorId: null,
    createdAt: "2026-07-25T13:00:00.000Z",
    updatedAt: "2026-07-25T13:00:00.000Z",
    disabledAt: null,
  },
  membership: {
    workspace: "default",
    role: "member",
    projects: ["scrapbook"],
    createdAt: "2026-07-25T13:00:00.000Z",
    updatedAt: "2026-07-25T13:00:00.000Z",
    revokedAt: null,
  },
  principal: {
    type: "account",
    accountId: "acct_internal_identifier",
    name: "Dashboard member",
    workspace: "default",
    role: "member",
    scopes: ["read", "write"],
    projects: ["scrapbook"],
  },
  capabilities: { read: true, write: true, admin: false },
};

let store: StensiblyStore;
let accountService: FixedAccountService;
let app: ReturnType<typeof createHostedApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Visible to the hosted account",
    priority: 50,
    actor,
  });
  store.createItem({
    project: "private-project",
    kind: "task",
    title: "Outside the hosted account allowlist",
    priority: 50,
    actor,
  });
  accountService = new FixedAccountService();
  app = createHostedApp({
    ledger: new SqliteWorkLedger(store),
    authenticator: new FixedTokenAuthenticator(),
    workspace: "default",
    allowedOrigins: [machineOrigin],
    hostedAuth: {
      accountService,
      githubClient: {
        exchangeCode: async () => "provider-token",
        readIdentity: async () => ({
          subject: "123",
          username: "member",
          displayName: "Dashboard member",
          emailVerified: false,
        }),
      },
      githubClientId: "github-client-id",
      authOrigin: "https://api.stensibly.com",
      allowedReturnOrigins: [`${dashboardOrigin}/`],
      allowedGitHubSubjects: ["123"],
      now: () => Date.parse("2026-07-25T14:00:00.000Z"),
    },
  });
});

afterEach(() => store.close());

describe("hosted REST session authentication", () => {
  test("exposes a redacted account principal and filters unscoped item lists", async () => {
    const principal = await app.request("/api/v1/principal", {
      headers: { cookie: sessionCookie, origin: dashboardOrigin },
    });
    expect(principal.status).toBe(200);
    expect(principal.headers.get("access-control-allow-origin")).toBe(dashboardOrigin);
    expect(principal.headers.get("access-control-allow-credentials")).toBe("true");
    const principalBody = await principal.json();
    expect(principalBody).toEqual({
      principal: {
        kind: "account",
        name: "Dashboard member",
        workspace: "default",
        role: "member",
        scopes: ["read", "write"],
        projects: ["scrapbook"],
      },
      capabilities: { read: true, write: true, admin: false },
    });
    const serialized = JSON.stringify(principalBody);
    expect(serialized).not.toContain("acct_internal_identifier");
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain(sessionSecret);

    const listed = await app.request("/api/v1/items", {
      headers: { cookie: sessionCookie },
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { items: Array<{ project: string }> };
    expect(listedBody.items.map((item) => item.project)).toEqual(["scrapbook"]);
    expect(accountService.lastAuthentication).toMatchObject({
      id: sessionId,
      now: Date.parse("2026-07-25T14:00:00.000Z"),
    });
    expect(accountService.lastAuthentication?.secretHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("requires an approved Origin only for session-authenticated writes", async () => {
    const body = JSON.stringify({
      project: "scrapbook",
      kind: "task",
      title: "Created from the dashboard",
      priority: 60,
      actor,
    });

    const missingOrigin = await app.request("/api/v1/items", {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body,
    });
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.headers.get(FAILURE_CATEGORY_HEADER)).toBe("cors_rejection");
    expect(await missingOrigin.json()).toEqual({
      error: "A valid Origin header is required for browser-session writes",
      code: "forbidden_origin",
    });

    const approved = await app.request("/api/v1/items", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: dashboardOrigin,
        "content-type": "application/json",
      },
      body,
    });
    expect(approved.status).toBe(201);

    const bearer = await app.request("/api/v1/items", {
      method: "POST",
      headers: {
        authorization: "Bearer hosted-token",
        origin: machineOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project: "scrapbook",
        kind: "task",
        title: "Created by bearer client",
        priority: 60,
        actor,
      }),
    });
    expect(bearer.status).toBe(201);
    expect(bearer.headers.get("access-control-allow-credentials")).toBe("false");
  });

  test("gives an explicit bearer header precedence over a valid session cookie", async () => {
    const invalidBearer = await app.request("/api/v1/principal", {
      headers: {
        authorization: "Bearer invalid-token",
        cookie: sessionCookie,
      },
    });
    expect(invalidBearer.status).toBe(401);
    expect(await invalidBearer.json()).toEqual({ error: "A valid Bearer token is required" });

    const validBearer = await app.request("/api/v1/principal", {
      headers: {
        authorization: "Bearer hosted-token",
        cookie: `${HOSTED_SESSION_COOKIE}=malformed`,
      },
    });
    expect(validBearer.status).toBe(200);
    expect(await validBearer.json()).toMatchObject({
      principal: { kind: "api_token", name: "Hosted bearer" },
    });
  });

  test("supports credentialed preflight only for approved dashboard origins", async () => {
    const dashboard = await app.request("/api/v1/items", {
      method: "OPTIONS",
      headers: {
        origin: dashboardOrigin,
        "access-control-request-method": "POST",
      },
    });
    expect(dashboard.status).toBe(204);
    expect(dashboard.headers.get("access-control-allow-origin")).toBe(dashboardOrigin);
    expect(dashboard.headers.get("access-control-allow-credentials")).toBe("true");

    const machine = await app.request("/api/v1/items", {
      method: "OPTIONS",
      headers: {
        origin: machineOrigin,
        "access-control-request-method": "POST",
      },
    });
    expect(machine.status).toBe(204);
    expect(machine.headers.get("access-control-allow-credentials")).toBe("false");

    const denied = await app.request("/api/v1/items", {
      method: "OPTIONS",
      headers: {
        origin: "https://dashboard.stensibly.com.evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Origin is not allowed" });
  });

  test("fails closed for unavailable sessions and session backend errors", async () => {
    accountService.available = false;
    const expired = await app.request("/api/v1/principal", {
      headers: { cookie: sessionCookie },
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({
      error: "A valid Bearer token or hosted session is required",
    });

    accountService.available = true;
    accountService.fail = true;
    const failed = await app.request("/api/v1/principal", {
      headers: { cookie: sessionCookie },
    });
    expect(failed.status).toBe(502);
    expect(failed.headers.get(FAILURE_CATEGORY_HEADER)).toBe("convex_failure");
    expect(await failed.json()).toEqual({
      error: "Hosted session authority failed",
      code: "backend_failure",
    });
  });

  test("keeps MCP bearer-only", async () => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": protocolVersion,
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "session-only", version: "0.0.1" },
        },
      }),
    });
    expect(response.status).toBe(401);
  });
});
