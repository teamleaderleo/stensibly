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
const codeId = (label: string) => `oauth_code_${label.padEnd(12, "x")}`;
const refreshId = (label: string) => `oauth_refresh_${label.padEnd(12, "x")}`;
const clientId = (label: string) => `oauth_client_${label.padEnd(12, "x")}`;

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex MCP OAuth authority", () => {
  test("registers clients and exchanges a single-use PKCE code", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t, { id: clientId("primary") });

    expect(client).toMatchObject({
      clientId: clientId("primary"),
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
      id: codeId("primary"),
      scopes: ["read", "write", "offline_access"],
    });
    const exchanged = await exchangeCode(t, {
      clientId: client.clientId,
      id: codeId("primary"),
      refreshId: refreshId("primary"),
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
      id: codeId("primary"),
      refreshId: refreshId("second"),
    })).toBeNull();
  });

  test("invalidates a code after failed redemption", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t, { id: clientId("failure") });
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: codeId("failure"),
      scopes: ["read", "offline_access"],
    });

    expect(await exchangeCode(t, {
      clientId: client.clientId,
      id: codeId("failure"),
      codeChallenge: "b".repeat(43),
      refreshId: refreshId("failure"),
    })).toBeNull();
    expect(await exchangeCode(t, {
      clientId: client.clientId,
      id: codeId("failure"),
      refreshId: refreshId("afterfailure"),
    })).toBeNull();
  });

  test("rejects expiry and preserves workspace isolation", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t, { id: clientId("isolation") });
    const now = Date.now();
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: codeId("expiry"),
      scopes: ["read", "offline_access"],
      expiresAt: now + 60_000,
    });

    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect(await exchangeCode(t, {
        clientId: client.clientId,
        id: codeId("expiry"),
        refreshId: refreshId("expiry"),
      })).toBeNull();
    } finally {
      clock.mockRestore();
    }

    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: codeId("workspace"),
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
      id: codeId("workspace"),
      refreshId: refreshId("other"),
    })).toBeNull();
    expect(await exchangeCode(t, {
      clientId: client.clientId,
      id: codeId("workspace"),
      refreshId: refreshId("correct"),
    })).not.toBeNull();
  });

  test("keeps wrong refresh secrets non-mutating and revokes the active leaf on old-token replay", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "viewer", ["scrapbook"]);
    const client = await registerClient(t, { id: clientId("refresh") });
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: codeId("refresh"),
      scopes: ["read", "offline_access"],
    });
    await exchangeCode(t, {
      clientId: client.clientId,
      id: codeId("refresh"),
      refreshId: refreshId("root"),
    });

    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: refreshId("root"),
      secretHash: "f".repeat(64),
      nextId: refreshId("wrong"),
    })).toEqual({ status: "invalid" });
    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: refreshId("root"),
      secretHash: "b".repeat(64),
      nextId: refreshId("leaf"),
    })).toMatchObject({ status: "ok" });

    const createdAt = Date.now() - 10_000;
    await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      const dbAccount = await ctx.db.query("accounts").withIndex("by_external_id", (q) => q.eq("externalId", account.account.id)).unique();
      if (!ws || !dbAccount) throw new Error("OAuth test state disappeared");
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: ws._id,
          accountId: dbAccount._id,
          externalId: refreshId(`history${index.toString().padStart(5, "0")}`),
          familyExternalId: refreshId("root"),
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
      id: refreshId("history00000"),
      secretHash: "d".repeat(64),
      nextId: refreshId("replay"),
    })).toEqual({ status: "replayed" });
    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: refreshId("leaf"),
      secretHash: "c".repeat(64),
      nextId: refreshId("afterreplay"),
    })).toEqual({ status: "replayed" });
  });

  test("rejects expired refresh tokens and scope downgrades", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, workspace, "member", ["scrapbook"]);
    const client = await registerClient(t, { id: clientId("scope") });
    await createCode(t, {
      accountId: account.account.id,
      clientId: client.clientId,
      id: codeId("scope"),
      scopes: ["read", "write", "offline_access"],
    });
    await exchangeCode(t, {
      clientId: client.clientId,
      id: codeId("scope"),
      refreshId: refreshId("scope"),
    });
    await setMembershipRole(t, account.account.id, workspace, "viewer");
    expect(await rotateRefresh(t, {
      clientId: client.clientId,
      id: refreshId("scope"),
      secretHash: "b".repeat(64),
      nextId: refreshId("scopedown"),
    })).toEqual({ status: "invalid" });

    const expiryWorkspace = "expiry";
    const expiryAccount = await upsertAccount(t, expiryWorkspace, "viewer", ["scrapbook"]);
    const expiryClient = await registerClient(t, {
      workspace: expiryWorkspace,
      id: clientId("expiry"),
    });
    const now = Date.now();
    await createCode(t, {
      workspace: expiryWorkspace,
      accountId: expiryAccount.account.id,
      clientId: expiryClient.clientId,
      id: codeId("refreshexpiry"),
      scopes: ["read", "offline_access"],
    });
    await exchangeCode(t, {
      workspace: expiryWorkspace,
      clientId: expiryClient.clientId,
      id: codeId("refreshexpiry"),
      refreshId: refreshId("expiring"),
      refreshExpiresAt: now + 60_000,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect(await rotateRefresh(t, {
        workspace: expiryWorkspace,
        clientId: expiryClient.clientId,
        id: refreshId("expiring"),
        secretHash: "b".repeat(64),
        nextId: refreshId("afterexpiry"),
      })).toEqual({ status: "invalid" });
    } finally {
      clock.mockRestore();
    }
  });

  test("caps persistent public clients per workspace", async () => {
    const t = convexTest(schema, modules);
    await registerClient(t, { id: clientId("first") });
    await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      if (!ws) throw new Error("Test workspace disappeared");
      const now = Date.now();
      for (let index = 1; index < 1_000; index += 1) {
        await ctx.db.insert("mcpOAuthClients", {
          workspaceId: ws._id,
          externalId: clientId(`cap${index.toString().padStart(9, "0")}`),
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
    await expect(registerClient(t, { id: clientId("overcapacity") }))
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
    subject: targetWorkspace === workspace ? "1001" : `1001-${targetWorkspace}`,
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: role,
    projects,
  }) as any;
}

async function setMembershipRole(
  t: ReturnType<typeof convexTest>,
  accountExternalId: string,
  targetWorkspace: string,
  role: "owner" | "admin" | "member" | "viewer",
) {
  await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q: any) => q.eq("slug", targetWorkspace)).unique();
    const account = await ctx.db.query("accounts").withIndex("by_external_id", (q: any) => q.eq("externalId", accountExternalId)).unique();
    if (!ws || !account) throw new Error("Test account disappeared");
    const membership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_account_workspace", (q: any) => q.eq("accountId", account._id).eq("workspaceId", ws._id))
      .unique();
    if (!membership) throw new Error("Test membership disappeared");
    await ctx.db.patch(membership._id, { role });
  });
}

async function registerClient(
  t: ReturnType<typeof convexTest>,
  overrides: { workspace?: string; id?: string } = {},
) {
  return await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace: overrides.workspace ?? workspace,
    clientId: overrides.id ?? clientId("default"),
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
