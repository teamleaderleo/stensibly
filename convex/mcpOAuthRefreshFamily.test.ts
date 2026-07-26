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
  test("keeps a fixed family deadline through a long chain and retains replay evidence", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const { clientId, rootId } = await createFamily(t, "longchain");
      let currentId = rootId;
      let currentHash = hashFor(0);
      for (let index = 1; index <= 125; index += 1) {
        const now = base + index * 60_000;
        clock.mockReturnValue(now);
        const nextId = refreshId(`long${index.toString().padStart(8, "0")}`);
        const nextHash = hashFor(index);
        const rotated = await rotate(t, {
          clientId,
          id: currentId,
          secretHash: currentHash,
          nextId,
          nextSecretHash: nextHash,
          nextExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
        }) as any;
        expect(rotated.status).toBe("ok");
        currentId = nextId;
        currentHash = nextHash;
      }

      const familyExpiresAt = base + familyLifetimeMs;
      const beforeReplay = await readFamily(t, rootId);
      expect(beforeReplay).toHaveLength(126);
      expect(beforeReplay.every((token: any) => token.expiresAt <= familyExpiresAt)).toBe(true);
      expect(beforeReplay[0].consumedAt).toBeDefined();
      expect(beforeReplay.at(-1)?.externalId).toBe(currentId);

      clock.mockReturnValue(base + 2 * 24 * 60 * 60 * 1000);
      expect(await rotate(t, {
        clientId,
        id: rootId,
        secretHash: hashFor(0),
        nextId: refreshId("replaytarget"),
        nextSecretHash: "e".repeat(64),
        nextExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      })).toEqual({ status: "replayed" });

      const afterReplay = await readFamily(t, rootId);
      expect(afterReplay).toHaveLength(126);
      expect(afterReplay.at(-1)?.revokedAt).toBeDefined();
      const earlyCleanup = await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: rootId,
        familyExpiresAt,
      }) as any;
      expect(earlyCleanup).toMatchObject({
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

  test("cleans only after the family deadline in bounded batches across timer races", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-02-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const { clientId, rootId } = await createFamily(t, "cleanup");
      const familyExpiresAt = base + familyLifetimeMs;
      await insertConsumedHistory(t, {
        rootId,
        clientId,
        count: 205,
        createdAt: base + 1,
        expiresAt: familyExpiresAt,
      });

      clock.mockReturnValue(familyExpiresAt - 1);
      const retained = await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: rootId,
        familyExpiresAt: base + 1,
      }) as any;
      expect(retained).toMatchObject({
        status: "retained",
        cleanedRows: 0,
        hasMore: true,
      });
      expect(await readFamily(t, rootId)).toHaveLength(206);

      const leafId = refreshId("cleanupfinal");
      expect(await rotate(t, {
        clientId,
        id: rootId,
        secretHash: hashFor(0),
        nextId: leafId,
        nextSecretHash: "c".repeat(64),
        nextExpiresAt: familyExpiresAt + 30 * 24 * 60 * 60 * 1000,
      })).toMatchObject({ status: "ok" });
      const leaf = (await readFamily(t, rootId)).find((token: any) => token.externalId === leafId);
      expect(leaf?.expiresAt).toBe(familyExpiresAt);

      clock.mockReturnValue(familyExpiresAt);
      expect(await rotate(t, {
        clientId,
        id: leafId,
        secretHash: "c".repeat(64),
        nextId: refreshId("tooLateNext"),
        nextSecretHash: "d".repeat(64),
        nextExpiresAt: familyExpiresAt + 60_000,
      })).toEqual({ status: "invalid" });

      const first = await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: rootId,
        familyExpiresAt,
      }) as any;
      expect(first).toEqual({
        status: "cleaned",
        retainedRows: 0,
        cleanedRows: 100,
        hasMore: true,
      });
      const second = await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: rootId,
        familyExpiresAt,
      }) as any;
      expect(second.cleanedRows).toBe(100);
      expect(second.hasMore).toBe(true);
      const third = await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: rootId,
        familyExpiresAt,
      }) as any;
      expect(third).toMatchObject({ status: "cleaned", cleanedRows: 7, hasMore: false });
      expect(await readFamily(t, rootId)).toHaveLength(0);
      expect(await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: rootId,
        familyExpiresAt,
      })).toEqual({
        status: "missing",
        retainedRows: 0,
        cleanedRows: 0,
        hasMore: false,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("fails closed for legacy rolling expiry and malformed missing-root families", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const account = await upsertAccount(t);
      const client = await registerClient(t, "legacy");
      const legacyRootId = refreshId("legacyroot");
      const legacyLeafId = refreshId("legacyleaf");
      await t.run(async (ctx) => {
        const ws = await ctx.db.query("workspaces")
          .withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
        const dbAccount = await ctx.db.query("accounts")
          .withIndex("by_external_id", (q) => q.eq("externalId", account.account.id)).unique();
        if (!ws || !dbAccount) throw new Error("Legacy fixture setup failed");
        const rootCreatedAt = base - familyLifetimeMs - 1;
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: ws._id,
          accountId: dbAccount._id,
          externalId: legacyRootId,
          familyExternalId: legacyRootId,
          secretHash: hashFor(0),
          clientExternalId: client.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: rootCreatedAt,
          expiresAt: base - 1,
          consumedAt: rootCreatedAt + 1,
          rotatedToExternalId: legacyLeafId,
        });
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: ws._id,
          accountId: dbAccount._id,
          externalId: legacyLeafId,
          familyExternalId: legacyRootId,
          secretHash: "c".repeat(64),
          clientExternalId: client.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base - 60_000,
          expiresAt: base + 30 * 24 * 60 * 60 * 1000,
        });
      });

      expect(await rotate(t, {
        clientId: client.clientId,
        id: legacyLeafId,
        secretHash: "c".repeat(64),
        nextId: refreshId("legacyextended"),
        nextSecretHash: "d".repeat(64),
        nextExpiresAt: base + 30 * 24 * 60 * 60 * 1000,
      })).toEqual({ status: "invalid" });
      expect((await readFamily(t, legacyRootId)).at(-1)?.revokedAt).toBeDefined();

      const malformedFamilyId = refreshId("missingroot");
      const malformedOldId = refreshId("malformedold");
      const malformedLeafId = refreshId("malformedleaf");
      await t.run(async (ctx) => {
        const ws = await ctx.db.query("workspaces")
          .withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
        const dbAccount = await ctx.db.query("accounts")
          .withIndex("by_external_id", (q) => q.eq("externalId", account.account.id)).unique();
        if (!ws || !dbAccount) throw new Error("Malformed fixture setup failed");
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: ws._id,
          accountId: dbAccount._id,
          externalId: malformedOldId,
          familyExternalId: malformedFamilyId,
          secretHash: "8".repeat(64),
          clientExternalId: client.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base,
          expiresAt: base + 60_000,
          consumedAt: base + 1,
        });
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: ws._id,
          accountId: dbAccount._id,
          externalId: malformedLeafId,
          familyExternalId: malformedFamilyId,
          secretHash: "9".repeat(64),
          clientExternalId: client.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base + 2,
          expiresAt: base + 60_000,
        });
      });

      expect(await rotate(t, {
        clientId: client.clientId,
        id: malformedOldId,
        secretHash: "8".repeat(64),
        nextId: refreshId("malformedreplay"),
        nextSecretHash: "a".repeat(64),
        nextExpiresAt: base + 60_000,
      })).toEqual({ status: "replayed" });
      expect((await readFamily(t, malformedFamilyId)).at(-1)?.revokedAt).toBeDefined();

      const malformedExpiry = base + familyLifetimeMs;
      const retained = await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: malformedFamilyId,
        familyExpiresAt: malformedExpiry,
      }) as any;
      expect(retained.status).toBe("retained");
      clock.mockReturnValue(malformedExpiry);
      const cleaned = await t.mutation(cleanupRefreshFamily as any, {
        familyExternalId: malformedFamilyId,
        familyExpiresAt: malformedExpiry,
      }) as any;
      expect(cleaned).toMatchObject({ status: "cleaned", cleanedRows: 2, hasMore: false });
    } finally {
      clock.mockRestore();
    }
  });
});

async function createFamily(t: ReturnType<typeof convexTest>, label: string) {
  const account = await upsertAccount(t);
  const client = await registerClient(t, label);
  const code = codeId(label);
  const rootId = refreshId(`${label}root`);
  await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
    serviceSecret,
    workspace,
    accountId: account.account.id,
    clientId: client.clientId,
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
    clientId: client.clientId,
    redirectUri,
    codeChallenge,
    refreshId: rootId,
    refreshSecretHash: hashFor(0),
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return { clientId: client.clientId, rootId };
}

async function upsertAccount(t: ReturnType<typeof convexTest>) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject: "refresh-family-account",
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: "member",
    projects: ["scrapbook"],
  }) as any;
}

async function registerClient(t: ReturnType<typeof convexTest>, label: string) {
  return await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace,
    clientId: clientId(label),
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  }) as any;
}

async function rotate(
  t: ReturnType<typeof convexTest>,
  input: {
    clientId: string;
    id: string;
    secretHash: string;
    nextId: string;
    nextSecretHash: string;
    nextExpiresAt: number;
  },
) {
  return await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
    serviceSecret,
    workspace,
    ...input,
  });
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
  input: {
    rootId: string;
    clientId: string;
    count: number;
    createdAt: number;
    expiresAt: number;
  },
) {
  await t.run(async (ctx: any) => {
    const root = await ctx.db.query("mcpOAuthRefreshTokens")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", input.rootId)).unique();
    if (!root) throw new Error("Refresh root disappeared");
    for (let index = 0; index < input.count; index += 1) {
      await ctx.db.insert("mcpOAuthRefreshTokens", {
        workspaceId: root.workspaceId,
        accountId: root.accountId,
        externalId: refreshId(`history${index.toString().padStart(5, "0")}`),
        familyExternalId: input.rootId,
        secretHash: "d".repeat(64),
        clientExternalId: input.clientId,
        scopes: root.scopes,
        resource: root.resource,
        createdAt: input.createdAt + index,
        expiresAt: input.expiresAt,
        consumedAt: input.createdAt + index + 1,
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
