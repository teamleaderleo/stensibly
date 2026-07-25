import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "../src/auth.ts";
import type {
  HostedAccountContext,
  HostedAccountService,
  HostedSessionContext,
  HostedSessionRecord,
  OAuthStateRecord,
} from "../src/hosted-account-service.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import type { GitHubIdentity, GitHubOAuthClient } from "../src/hosted-auth.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const protocolVersion = "2025-06-18";
const actor = { id: "leo", name: "Leo", kind: "human" as const };

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    if (rawToken !== "hosted-token") return null;
    return {
      tokenId: "tok_hosted",
      name: "Hosted reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    };
  }
}

class FakeGitHubClient implements GitHubOAuthClient {
  async exchangeCode(): Promise<string> {
    return "provider-token";
  }

  async readIdentity(): Promise<GitHubIdentity> {
    return {
      subject: "1001",
      username: "teamleaderleo",
      displayName: "Leo",
      emailVerified: false,
    };
  }
}

class StubAccountService implements HostedAccountService {
  async createOAuthState(input: {
    id: string;
    returnTo: string;
    expiresAt: number;
  }): Promise<OAuthStateRecord> {
    return {
      id: input.id,
      returnTo: input.returnTo,
      createdAt: new Date(1_000).toISOString(),
      expiresAt: new Date(input.expiresAt).toISOString(),
      consumedAt: null,
    };
  }

  async consumeOAuthState(): Promise<OAuthStateRecord | null> {
    return null;
  }

  async upsertProviderIdentity(): Promise<HostedAccountContext> {
    throw new Error("not used");
  }

  async createSession(): Promise<HostedSessionRecord> {
    throw new Error("not used");
  }

  async authenticateSession(): Promise<HostedSessionContext | null> {
    return null;
  }

  async touchSession(): Promise<HostedSessionRecord | null> {
    return null;
  }

  async revokeSession(): Promise<HostedSessionRecord | null> {
    return null;
  }
}

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Keep bearer clients working",
    priority: 50,
    actor,
  });
});

afterEach(() => store.close());

describe("hosted gateway auth mount", () => {
  test("mounts account login while keeping REST and MCP bearer-only", async () => {
    const app = createHostedApp({
      ledger: new SqliteWorkLedger(store),
      authenticator: new FixedAuthenticator(),
      allowedOrigins: ["https://www.stensibly.com"],
      hostedAuth: {
        accountService: new StubAccountService(),
        githubClient: new FakeGitHubClient(),
        githubClientId: "github-client-id",
        authOrigin: "https://api.stensibly.com",
        allowedReturnOrigins: ["https://www.stensibly.com"],
        allowedGitHubSubjects: ["1001"],
        now: () => 1_000,
        randomBytes: deterministicRandomBytes(),
      },
    });

    const health = await app.request("/health");
    expect(await health.json()).toMatchObject({
      surfaces: ["api-v1", "mcp", "auth"],
    });
    const started = await app.request("/auth/github/start");
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toStartWith("https://github.com/login/oauth/authorize");

    const cookieOnlyRest = await app.request("/api/v1/items", {
      headers: { cookie: "__Host-stensibly-session=ses_example.secret" },
    });
    expect(cookieOnlyRest.status).toBe(401);

    const bearerRest = await app.request("/api/v1/items", {
      headers: { authorization: "Bearer hosted-token" },
    });
    expect(bearerRest.status).toBe(200);

    const cookieOnlyMcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": protocolVersion,
        cookie: "__Host-stensibly-session=ses_example.secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "cookie-only", version: "0.0.1" },
        },
      }),
    });
    expect(cookieOnlyMcp.status).toBe(401);
  });
});

function deterministicRandomBytes() {
  let call = 0;
  return (length: number) => new Uint8Array(length).fill(++call);
}
