import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-test-secret";
const workspace = "test";
const resource = "https://api.stensibly.com/mcp";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const codeChallenge = "a".repeat(43);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex MCP OAuth authority", () => {
  test("registers public clients and exchanges a single-use PKCE code", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t);

    expect(client).toMatchObject({
      clientId: "oauth_client_abcdefghijkl",
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    expect(await t.query(convexApi.mcpOAuth.getClient, {
      serviceSecret,
      workspace,
      clientId: client.clientId,
    })).toMatchObject({ clientId: client.clientId });

    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: "oauth_code_abcdefghijkl",
      scopes: ["read", "write", "offline_access"],
    });
    const exchanged = await exchangeCode(t, {
      clientId: client.clientId,
      id: "oauth_code_abcdefghijkl",
      refreshId: "oauth_refresh_abcdefghijkl",
    }) as any;
    expect(exchanged).toMatchObject({
      scopes: ["read", "write", "offline_access"],
      principal: {
        accountId: account.account.id,
        role: "member",
        projects: ["scrapbook"],
      },
    });
    expect(JSON.stringify(exchanged)).not.toContain("a".repeat(64));

    expect(await exchangeCode(t, {
      clientId: client.clientId,
      id: "oauth_code_abcdefghijkl",
      refreshId: "oauth_refresh_secondtoken",
    })).toBeNull();
  });

  test("invalidates a code after any failed redemption attempt", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t);
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: "oauth_code_failedattempt",
      scopes: ["read", "offline_access"],
    });

    expect(await exchangeCode(t, {
      clientId: client.clientId,
      id: "oauth_code_failedattempt",
      codeChallenge: "b".repeat(43),
      refreshId: "oauth_refresh_failedattempt",
    })).toBeNull();
    expect(await exchangeCode(t, {
      clientId: client.clientId,
      id: "oauth_code_failedattempt",
      refreshId: "oauth_refresh_afterfailure",
    })).toBeNull();
  });

  test("rejects expired codes and preserves workspace isolation", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t);
    const now = Date.now();
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: "oauth_code_expirycheck",
      scopes: ["read", "offline_access"],
      expiresAt: now + 60_000,
    });

    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect(await exchangeCode(t, {
        clientId: client.clientId,
        id: "oauth_code_expirycheck",
        refreshId: "oauth_refresh_expirycheck",
      })).toBeNull();
    } finally {
      clock.mockRestore();
    }

    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: "oauth_code_workspaceiso",
      scopes: ["read", "offline_access"],
    });
    expect(await t.query(convexApi.mcpOAuth.getClient, {
      serviceSecret,
      workspace: "other",
      clientId: client.clientId,
    })).toBeNull();
    expect(await exchangeCode(t, {
      workspace: "other",
      clientId: client.clientId,
      id: "oauth_code_workspaceiso",
      refreshId: "oauth_refresh_otherworkspace",
    })).toBeNull();
    expect(await exchangeCode(t, {
      clientId: client.clientId,
      id: "oauth_code_workspaceiso",
      refreshId: "oauth_refresh_correctspace",
    })).not.toBeNull();
  });

  test("keeps invalid refresh secrets non-mutating and revokes the active leaf after old-token replay", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "viewer", ["scrapbook"]);
    const client = await registerClient(t);
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: "oauth_code_refreshflow",
      scopes: ["read", "offline_access"],
    });
    await exchangeCode(t, {
      clientId: client.clientId,
      id: "oauth_code_refreshflow",
      refreshId: "oauth_refresh_abcdefghijkl",
    });

    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: "oauth_refresh_abcdefghijkl",
      secretHash: "f".repeat(64),
      nextId: "oauth_refresh_wrongsecret",
    })).toEqual({ status: "invalid" });

    const rotated = await rotateRefresh(t, {
      clientId: client.clientId,
      id: "oauth_refresh_abcdefghijkl",
      secretHash: "b".repeat(64),
      nextId: "oauth_refresh_mnopqrstuvwx",
    }) as any;
    expect(rotated).toMatchObject({
      status: "ok",
      grant: { scopes: ["read", "offline_access"] },
    });

    const createdAt = Date.now() - 10_000;
    await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      const dbAccount = await ctx.db.query("accounts").withIndex("by_external_id", (q) => q.eq("externalId", account.account.id)).unique();
      if (!ws || !dbAccount) throw new Error("OAuth test state disappeared");
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: ws._id,
          accountId: dbAccount._id,
          externalId: `oauth_refresh_history${index.toString().padStart(3, "0")}`,
          familyExternalId: "oauth_refresh_abcdefghijkl",
          secretHash: "d".repeat(64),
          clientExternalId: client.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: createdAt + index,
          expiresAt: Date.now() + 120_000,
          consumedAt: createdAt + index + 1,
        });
      }
    });

    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: "oauth_refresh_history000",
      secretHash: "d".repeat(64),
      nextId: "oauth_refresh_replayattempt",
    })).toEqual({ status: "replayed" });
    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: "oauth_refresh_mnopqrstuvwx",
      secretHash: "c".repeat(64),
      nextId: "oauth_refresh_afterreplay",
    })).toEqual({ status: "replayed" });
  });

  test("rejects expired refresh tokens and scope downgrades", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t);
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: "oauth_code_scopechange",
      scopes: ["read", "write", "offline_access"],
    });
    await exchangeCode(t, {
      clientId: client.clientId,
      id: "oauth_code_scopechange",
      refreshId: "oauth_refresh_scopechange",
      refreshExpiresAt: Date.now() + 60_000,
    });

    await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      const dbAccount = await ctx.db.query("accounts").withIndex("by_external_id", (q) => q.eq("externalId", account.account.id)).unique();
      if (!ws || !dbAccount) throw new Error("Test account disappeared");
      const membership = await ctx.db
        .query("workspaceMemberships")
        .withIndex("by_account_workspace", (q) => q.eq("accountId", dbAccount._id).eq("workspaceId", ws._id))
        .unique();
      if (!membership) throw new Error("Test membership disappeared");
      await ctx.db.patch(membership._id, { role: "viewer" });
    });
    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: "oauth_refresh_scopechange",
      secretHash: "b".repeat(64),
      nextId: "oauth_refresh_scopedown",
    })).toEqual({ status: "invalid" });

    const second = await upsertAccount(t, "expiry", "viewer", ["scrapbook"]);
    const expiryClient = await registerClient(t, {
      workspace: "expiry",
      clientId: "oauth_client_expiryclient",
    });
    const now = Date.now();
    await createCode(t, {
      workspace: "expiry",
      accountId: second.account.id,
      clientId: expiryClient.clientId,
      id: "oauth_code_refreshexpiry",
      scopes: ["read", "offline_access"],
    });
    await exchangeCode(t, {
      workspace: "expiry",
      clientId: expiryClient.clientId,
      id: "oauth_code_refreshexpiry",
      refreshId: "oauth_refresh_expiringtoken",
      refreshExpiresAt: now + 60_000,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect(await rotateRefresh(t, {
        workspace: "expiry",
        clientId: expiryClient.clientId,
        id: "oauth_refresh_expiringtoken",
        secretHash: "b".repeat(64),
        nextId: "oauth_refresh_afterexpiry",
      })).toEqual({ status: "invalid" });
    } finally {
      clock.mockRestore();
    }
  });

  test("caps persistent public clients per workspace", async () => {
    const t = convexTest(schema, modules);
    await registerClient(t);
    await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      if (!ws) throw new Error("Test workspace disappeared");
      const now = Date.now();
      for (let index = 1; index < 1_000; index += 1) {
        await ctx.db.insert("mcpOAuthClients", {
          workspaceId: ws._id,
          externalId: `oauth_client_cap${index.toString().padStart(4, "0")}`,
          clientName: "Bounded client",
          redirectUris: [redirectUri],
          tokenEndpointAuthMethod: "none",
          grantTypes: ["authorization_code"],
          responseTypes: ["code"],
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
    });
    await expect(registerClient(t, { clientId: "oauth_client_overcapacity" }))
      .rejects.toThrow("registration limit reached");
  });
});

async function upsertAccount(
  t: ReturnType<typeof convexTest>,
  targetWorkspace: string,
  role: "owner" | "admin" | "member" | "viewer",
  projects?: string[],
) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace: targetWorkspace,
    provider: "github",
    subject: "1001",
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: role,
    projects,
  }) as any;
}

async function registerClient(
  t: ReturnType<typeof convexTest>,
  overrides: { workspace?: string; clientId?: string } = {},
) {
  return await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace: overrides.workspace ?? workspace,
    clientId: overrides.clientId ?? "oauth_client_abcdefghijkl",
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  }) as any;
}

async function createCode(
  t: ReturnType<typeof convexTest>,
  input: {
    workspace?: string;
    accountId: string;
    clientId: string;
    id: string;
    scopes: ("read" | "write" | "offline_access")[];
    expiresAt?: number;
  },
) {
  return await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
    serviceSecret,
    workspace: input.workspace ?? workspace,
    accountId: input.accountId,
    clientId: input.clientId,
    redirectUri,
    codeChallenge,
    scopes: input.scopes,
    resource,
    id: input.id,
    secretHash: "a".repeat(64),
    expiresAt: input.expiresAt ?? Date.now() + 60_000,
  });
}

async function exchangeCode(
  t: ReturnType<typeof convexTest>,
  input: {
    workspace?: string;
    clientId: string;
    id: string;
    codeChallenge?: string;
    refreshId: string;
    refreshExpiresAt?: number;
  },
) {
  return await t.mutation(convexApi.mcpOAuth.exchangeAuthorizationCode, {
    serviceSecret,
    workspace: input.workspace ?? workspace,
    id: input.id,
    secretHash: "a".repeat(64),
    clientId: input.clientId,
    redirectUri,
    codeChallenge: input.codeChallenge ?? codeChallenge,
    refreshId: input.refreshId,
    refreshSecretHash: "b".repeat(64),
    refreshExpiresAt: input.refreshExpiresAt ?? Date.now() + 120_000,
  });
}

async function rotateRefresh(
  t: ReturnType<typeof convexTest>,
  input: {
    workspace?: string;
    clientId: string;
    id: string;
    secretHash: string;
    nextId: string;
  },
) {
  return await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
    serviceSecret,
    workspace: input.workspace ?? workspace,
    id: input.id,
    secretHash: input.secretHash,
    clientId: input.clientId,
    nextId: input.nextId,
    nextSecretHash: "c".repeat(64),
    nextExpiresAt: Date.now() + 120_000,
  });
}
