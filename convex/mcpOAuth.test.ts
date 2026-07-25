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
    const account = await upsertAccount(t, "member", ["scrapbook"]);
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

    const created = await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      scopes: ["read", "write", "offline_access"],
      resource,
      id: "oauth_code_abcdefghijkl",
      secretHash: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    }) as any;
    expect(created).toMatchObject({
      clientId: client.clientId,
      resource,
      scopes: ["read", "write", "offline_access"],
      principal: {
        accountId: account.account.id,
        role: "member",
        projects: ["scrapbook"],
      },
    });

    const wrongVerifier = await exchangeCode(t, {
      clientId: client.clientId,
      codeChallenge: "b".repeat(43),
      refreshId: "oauth_refresh_abcdefghijkl",
    });
    expect(wrongVerifier).toBeNull();

    const exchanged = await exchangeCode(t, {
      clientId: client.clientId,
      codeChallenge,
      refreshId: "oauth_refresh_abcdefghijkl",
    }) as any;
    expect(exchanged).toMatchObject({
      scopes: ["read", "write", "offline_access"],
      principal: { projects: ["scrapbook"] },
    });
    expect(JSON.stringify(exchanged)).not.toContain("a".repeat(64));

    expect(await exchangeCode(t, {
      clientId: client.clientId,
      codeChallenge,
      refreshId: "oauth_refresh_secondtoken",
    })).toBeNull();
  });

  test("rotates refresh tokens and revokes the family on replay", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "viewer", ["scrapbook"]);
    const client = await registerClient(t);
    await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      scopes: ["read", "offline_access"],
      resource,
      id: "oauth_code_abcdefghijkl",
      secretHash: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    await exchangeCode(t, {
      clientId: client.clientId,
      codeChallenge,
      refreshId: "oauth_refresh_abcdefghijkl",
    });

    const rotated = await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
      serviceSecret,
      workspace,
      id: "oauth_refresh_abcdefghijkl",
      secretHash: "b".repeat(64),
      clientId: client.clientId,
      nextId: "oauth_refresh_mnopqrstuvwx",
      nextSecretHash: "c".repeat(64),
      nextExpiresAt: Date.now() + 120_000,
    }) as any;
    expect(rotated).toMatchObject({
      status: "ok",
      grant: { scopes: ["read", "offline_access"] },
    });

    const replayed = await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
      serviceSecret,
      workspace,
      id: "oauth_refresh_abcdefghijkl",
      secretHash: "b".repeat(64),
      clientId: client.clientId,
      nextId: "oauth_refresh_yzabcdefghij",
      nextSecretHash: "d".repeat(64),
      nextExpiresAt: Date.now() + 120_000,
    }) as any;
    expect(replayed).toEqual({ status: "replayed" });

    const latestAfterReplay = await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
      serviceSecret,
      workspace,
      id: "oauth_refresh_mnopqrstuvwx",
      secretHash: "c".repeat(64),
      clientId: client.clientId,
      nextId: "oauth_refresh_klmnopqrstuv",
      nextSecretHash: "e".repeat(64),
      nextExpiresAt: Date.now() + 120_000,
    }) as any;
    expect(latestAfterReplay).toEqual({ status: "replayed" });
  });

  test("fails closed when membership can no longer grant the stored scopes", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "member", ["scrapbook"]);
    const client = await registerClient(t);
    await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      scopes: ["read", "write", "offline_access"],
      resource,
      id: "oauth_code_abcdefghijkl",
      secretHash: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
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

    expect(await exchangeCode(t, {
      clientId: client.clientId,
      codeChallenge,
      refreshId: "oauth_refresh_abcdefghijkl",
    })).toBeNull();
  });
});

async function upsertAccount(
  t: ReturnType<typeof convexTest>,
  role: "owner" | "admin" | "member" | "viewer",
  projects?: string[],
) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject: "1001",
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: role,
    projects,
  }) as any;
}

async function registerClient(t: ReturnType<typeof convexTest>) {
  return await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace,
    clientId: "oauth_client_abcdefghijkl",
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  }) as any;
}

async function exchangeCode(
  t: ReturnType<typeof convexTest>,
  input: { clientId: string; codeChallenge: string; refreshId: string },
) {
  return await t.mutation(convexApi.mcpOAuth.exchangeAuthorizationCode, {
    serviceSecret,
    workspace,
    id: "oauth_code_abcdefghijkl",
    secretHash: "a".repeat(64),
    clientId: input.clientId,
    redirectUri,
    codeChallenge: input.codeChallenge,
    refreshId: input.refreshId,
    refreshSecretHash: "b".repeat(64),
    refreshExpiresAt: Date.now() + 120_000,
  });
}
