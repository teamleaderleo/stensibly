import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-family-test-secret";
const workspace = "test";
const resource = "https://api.stensibly.com/mcp";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const codeChallenge = "a".repeat(43);
const familyLifetimeMs = 90 * 24 * 60 * 60 * 1000;
const cleanupRefreshFamily = makeFunctionReference<"mutation">(
  "mcpOAuth:cleanupRefreshFamilyScheduled",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth refresh-family lifetime and cleanup", () => {
  test("keeps one deadline through a long chain and replays revoke the newest leaf", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const { clientId, rootId } = await createFamily(t, "longchain", familyLifetimeMs);
      const familyExpiresAt = base + familyLifetimeMs;
      let currentId = rootId;
      let currentHash = hashFor(0);

      for (let index = 1; index <= 125; index += 1) {
        const now = base + index * 12 * 60 * 60 * 1000;
        clock.mockReturnValue(now);
        const nextId = refreshId(`chain${index.toString().padStart(8, "0")}`);
        const nextHash = hashFor(index);
        expect(await rotate(t, {
          clientId,
          id: currentId,
          secretHash: currentHash,
          nextId,
          nextSecretHash: nextHash,
          nextExpiresAt: now + familyLifetimeMs,
        })).toMatchObject({ status: "ok" });
        currentId = nextId;
        currentHash = nextHash;
      }

      const family = await readFamily(t, rootId);
      expect(family).toHaveLength(126);
      expect(family.every((token: any) => token.expiresAt === familyExpiresAt)).toBe(true);

      clock.mockReturnValue(base + 70 * 24 * 60 * 60 * 1000);
      expect(await rotate(t, {
        clientId,
        id: rootId,
        secretHash: hashFor(0),
        nextId: refreshId("replaytarget"),
        nextSecretHash: "e".repeat(64),
        nextExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      })).toEqual({ status: "replayed" });

      const replayedFamily = await readFamily(t, rootId);
      expect(replayedFamily).toHaveLength(126);
      expect(replayedFamily.at(-1)?.externalId).toBe(currentId);
      expect(replayedFamily.at(-1)?.revokedAt).toBeDefined();

      clock.mockReturnValue(familyExpiresAt - 1);
      expect(await cleanup(t, rootId, familyExpiresAt)).toEqual({
        status: "retained",
        retainedRows: 100,
        cleanedRows: 0,
        hasMore: true,
      });
      expect(await readFamily(t, rootId)).toHaveLength(126);
    } finally {
      clock.mockRestore();
    }
  });

  test("cleans expired families in bounded continuation batches", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-02-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const { clientId, rootId } = await createFamily(t, "cleanup", familyLifetimeMs);
      const familyExpiresAt = base + familyLifetimeMs;
      await insertConsumedHistory(t, rootId, clientId, 205, base + 1, familyExpiresAt);

      clock.mockReturnValue(familyExpiresAt - 1);
      expect(await cleanup(t, rootId, familyExpiresAt)).toMatchObject({
        status: "retained",
        cleanedRows: 0,
        hasMore: true,
      });
      expect(await readFamily(t, rootId)).toHaveLength(206);

      clock.mockReturnValue(familyExpiresAt);
      expect(await cleanup(t, rootId, familyExpiresAt)).toEqual({
        status: "cleaned",
        retainedRows: 0,
        cleanedRows: 100,
        hasMore: true,
      });
      await t.finishInProgressScheduledFunctions();
      await t.finishInProgressScheduledFunctions();
      expect(await readFamily(t, rootId)).toHaveLength(0);
      expect(await cleanup(t, rootId, familyExpiresAt)).toEqual({
        status: "missing",
        retainedRows: 0,
        cleanedRows: 0,
        hasMore: false,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("fails closed for legacy rolling expiry and missing-root families", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const { accountId, accountDbId, clientId, workspaceId } = await setup(t, "legacy");
      const legacyRootId = refreshId("legacyroot");
      const legacyLeafId = refreshId("legacyleaf");
      await t.run(async (ctx: any) => {
        const rootCreatedAt = base - familyLifetimeMs - 1;
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId,
          accountId: accountDbId,
          externalId: legacyRootId,
          familyExternalId: legacyRootId,
          secretHash: hashFor(0),
          clientExternalId: clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: rootCreatedAt,
          expiresAt: base - 1,
          consumedAt: rootCreatedAt + 1,
          rotatedToExternalId: legacyLeafId,
        });
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId,
          accountId: accountDbId,
          externalId: legacyLeafId,
          familyExternalId: legacyRootId,
          secretHash: "c".repeat(64),
          clientExternalId: clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base - 60_000,
          expiresAt: base + 30 * 24 * 60 * 60 * 1000,
        });
      });

      expect(await rotate(t, {
        clientId,
        id: legacyLeafId,
        secretHash: "c".repeat(64),
        nextId: refreshId("legacyextended"),
        nextSecretHash: "d".repeat(64),
        nextExpiresAt: base + 30 * 24 * 60 * 60 * 1000,
      })).toEqual({ status: "invalid" });
      expect((await readFamily(t, legacyRootId)).at(-1)?.revokedAt).toBeDefined();

      const missingRootId = refreshId("missingroot");
      const oldId = refreshId("missingold");
      const leafId = refreshId("missingleaf");
      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId,
          accountId: accountDbId,
          externalId: oldId,
          familyExternalId: missingRootId,
          secretHash: "8".repeat(64),
          clientExternalId: clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base,
          expiresAt: base + 60_000,
          consumedAt: base + 1,
        });
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId,
          accountId: accountDbId,
          externalId: leafId,
          familyExternalId: missingRootId,
          secretHash: "9".repeat(64),
          clientExternalId: clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base + 2,
          expiresAt: base + 60_000,
        });
      });

      expect(accountId).toBeTruthy();
      expect(await rotate(t, {
        clientId,
        id: oldId,
        secretHash: "8".repeat(64),
        nextId: refreshId("missingreplay"),
        nextSecretHash: "a".repeat(64),
        nextExpiresAt: base + 60_000,
      })).toEqual({ status: "replayed" });
      expect((await readFamily(t, missingRootId)).at(-1)?.revokedAt).toBeDefined();

      const fallbackExpiry = base + familyLifetimeMs;
      expect((await cleanup(t, missingRootId, fallbackExpiry)).status).toBe("retained");
      clock.mockReturnValue(fallbackExpiry);
      expect(await cleanup(t, missingRootId, fallbackExpiry)).toMatchObject({
        status: "cleaned",
        cleanedRows: 2,
        hasMore: false,
      });
    } finally {
      clock.mockRestore();
    }
  });
});

async function createFamily(
  t: ReturnType<typeof convexTest>,
  label: string,
  refreshLifetimeMs: number,
) {
  const fixture = await setup(t, label);
  const code = codeId(label);
  const rootId = refreshId(`${label}root`);
  await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
    serviceSecret,
    workspace,
    accountId: fixture.accountId,
    clientId: fixture.clientId,
    redirectUri,
    codeChallenge,
    scopes: ["read", "offline_access"],
    resource,
    id: code,
    secretHash: "a".repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  await t.mutation(convexApi.mcpOAuth.exchangeAuthorizationCode, {
    serviceSecret,
    workspace,
    id: code,
    secretHash: "a".repeat(64),
    clientId: fixture.clientId,
    redirectUri,
    codeChallenge,
    refreshId: rootId,
    refreshSecretHash: hashFor(0),
    refreshExpiresAt: Date.now() + refreshLifetimeMs,
  });
  return { clientId: fixture.clientId, rootId };
}

async function setup(t: ReturnType<typeof convexTest>, label: string) {
  const account = await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject: `refresh-family-${label}`,
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: "member",
    projects: ["scrapbook"],
  }) as any;
  const client = await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace,
    clientId: clientId(label),
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  }) as any;
  return await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    const dbAccount = await ctx.db.query("accounts")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", account.account.id)).unique();
    if (!ws || !dbAccount) throw new Error("OAuth fixture setup failed");
    return {
      accountId: account.account.id as string,
      accountDbId: dbAccount._id,
      clientId: client.clientId as string,
      workspaceId: ws._id,
    };
  });
}

async function rotate(t: ReturnType<typeof convexTest>, input: Record<string, unknown>) {
  return await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
    serviceSecret,
    workspace,
    ...input,
  }) as any;
}

async function cleanup(t: ReturnType<typeof convexTest>, familyExternalId: string, familyExpiresAt: number) {
  return await t.mutation(cleanupRefreshFamily as any, {
    familyExternalId,
    familyExpiresAt,
  }) as any;
}

async function readFamily(t: ReturnType<typeof convexTest>, familyExternalId: string) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_family_created", (q: any) => q.eq("familyExternalId", familyExternalId))
    .order("asc")
    .collect());
}

async function insertConsumedHistory(
  t: ReturnType<typeof convexTest>,
  rootId: string,
  clientIdValue: string,
  count: number,
  createdAt: number,
  expiresAt: number,
) {
  await t.run(async (ctx: any) => {
    const root = await ctx.db.query("mcpOAuthRefreshTokens")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", rootId)).unique();
    if (!root) throw new Error("Refresh root disappeared");
    for (let index = 0; index < count; index += 1) {
      await ctx.db.insert("mcpOAuthRefreshTokens", {
        workspaceId: root.workspaceId,
        accountId: root.accountId,
        externalId: refreshId(`history${index.toString().padStart(5, "0")}`),
        familyExternalId: rootId,
        secretHash: "d".repeat(64),
        clientExternalId: clientIdValue,
        scopes: root.scopes,
        resource: root.resource,
        createdAt: createdAt + index,
        expiresAt,
        consumedAt: createdAt + index + 1,
      });
    }
  });
}

function codeId(label: string): string {
  return `oauth_code_${label.padEnd(12, "x")}`;
}

function refreshId(label: string): string {
  return `oauth_refresh_${label.padEnd(12, "x")}`;
}

function clientId(label: string): string {
  return `oauth_client_${label.padEnd(12, "x")}`;
}

function hashFor(index: number): string {
  return (index % 16).toString(16).repeat(64);
}
