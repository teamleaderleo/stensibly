import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-family-followup-secret";
const workspace = "test";
const resource = "https://api.stensibly.com/mcp";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const codeChallenge = "a".repeat(43);
const cleanupRefreshFamily = makeFunctionReference<"mutation">(
  "mcpOAuth:cleanupRefreshFamilyScheduled",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth refresh-family follow-up hardening", () => {
  test("wrong-client refresh attempts leave the family unchanged and preserve correct rotation", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-04-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const { clientId, rootId } = await createFamily(t, "wrongclient");
      const before = await readByExternalId(t, rootId);
      expect(before).toBeTruthy();

      const rejectedNextId = refreshId("wrongclientnext");
      expect(await rotate(t, {
        clientId: "oauth_client_wrongclient00",
        id: rootId,
        secretHash: "0".repeat(64),
        nextId: rejectedNextId,
        nextSecretHash: "1".repeat(64),
        nextExpiresAt: base + 60_000,
      })).toEqual({ status: "invalid" });

      expect(await readByExternalId(t, rootId)).toEqual(before);
      expect(await readByExternalId(t, rejectedNextId)).toBeNull();
      expect(clientId).not.toBe("oauth_client_wrongclient00");

      const acceptedNextId = refreshId("correctclientnext");
      expect(await rotate(t, {
        clientId,
        id: rootId,
        secretHash: "0".repeat(64),
        nextId: acceptedNextId,
        nextSecretHash: "5".repeat(64),
        nextExpiresAt: base + 60_000,
      })).toMatchObject({ status: "ok" });
      expect(await readByExternalId(t, rootId)).toMatchObject({
        consumedAt: base,
        rotatedToExternalId: acceptedNextId,
      });
      expect(await readByExternalId(t, acceptedNextId)).toMatchObject({
        externalId: acceptedNextId,
        clientExternalId: clientId,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("rootless families enrol once, recover early timers, and clean in bounded batches", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-05-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const fixture = await setup(t, "rootless");
      const familyExternalId = refreshId("missingroot");
      const consumedId = refreshId("rootlessold");
      const leafId = refreshId("rootlessleaf");
      const familyExpiresAt = base + 60_000;

      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: fixture.workspaceId,
          accountId: fixture.accountDbId,
          externalId: consumedId,
          familyExternalId,
          secretHash: "2".repeat(64),
          clientExternalId: fixture.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base,
          expiresAt: familyExpiresAt,
          consumedAt: base + 1,
          rotatedToExternalId: leafId,
        });
        for (let index = 0; index < 101; index += 1) {
          const createdAt = base + 2 + index;
          await ctx.db.insert("mcpOAuthRefreshTokens", {
            workspaceId: fixture.workspaceId,
            accountId: fixture.accountDbId,
            externalId: refreshId(`rootlesshistory${index.toString().padStart(3, "0")}`),
            familyExternalId,
            secretHash: "6".repeat(64),
            clientExternalId: fixture.clientId,
            scopes: ["read", "offline_access"],
            resource,
            createdAt,
            expiresAt: familyExpiresAt,
            consumedAt: createdAt + 1,
          });
        }
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: fixture.workspaceId,
          accountId: fixture.accountDbId,
          externalId: leafId,
          familyExternalId,
          familyExpiresAt: base + 90 * 24 * 60 * 60 * 1000,
          secretHash: "3".repeat(64),
          clientExternalId: fixture.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base + 1_000,
          expiresAt: familyExpiresAt,
        });
      });

      for (let replay = 0; replay < 2; replay += 1) {
        expect(await rotate(t, {
          clientId: fixture.clientId,
          id: consumedId,
          secretHash: "2".repeat(64),
          nextId: refreshId(`rootlessreplay${replay}`),
          nextSecretHash: "4".repeat(64),
          nextExpiresAt: familyExpiresAt,
        })).toEqual({ status: "replayed" });
      }

      const enrolledFamily = await readFamily(t, familyExternalId);
      expect(enrolledFamily).toHaveLength(103);
      expect(enrolledFamily[0]).toMatchObject({
        externalId: consumedId,
        familyExpiresAt,
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration: 1,
      });
      expect(enrolledFamily.at(-1)).toMatchObject({ externalId: leafId });
      expect(enrolledFamily.at(-1)?.revokedAt).toBeDefined();

      clock.mockReturnValue(familyExpiresAt - 1);
      expect(await cleanup(t, familyExternalId, familyExpiresAt, 1)).toEqual({
        status: "retained",
        retainedRows: 100,
        cleanedRows: 0,
        hasMore: true,
      });
      expect(await readByExternalId(t, consumedId)).toMatchObject({
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration: 2,
      });
      expect(await cleanup(t, familyExternalId, familyExpiresAt, 1)).toMatchObject({
        status: "retained",
        cleanedRows: 0,
      });
      expect(await readByExternalId(t, consumedId)).toMatchObject({
        cleanupScheduleGeneration: 2,
      });

      clock.mockReturnValue(familyExpiresAt);
      expect(await cleanup(t, familyExternalId, familyExpiresAt, 2)).toEqual({
        status: "cleaned",
        retainedRows: 0,
        cleanedRows: 100,
        hasMore: true,
      });
      expect(await readFamily(t, familyExternalId)).toHaveLength(3);
      expect(await cleanup(t, familyExternalId, familyExpiresAt, 2)).toEqual({
        status: "cleaned",
        retainedRows: 0,
        cleanedRows: 3,
        hasMore: false,
      });
      expect(await readFamily(t, familyExternalId)).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });
});

async function createFamily(t: ReturnType<typeof convexTest>, label: string) {
  const fixture = await setup(t, label);
  const authorizationCodeId = codeId(label);
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
    id: authorizationCodeId,
    secretHash: "a".repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  await t.mutation(convexApi.mcpOAuth.exchangeAuthorizationCode, {
    serviceSecret,
    workspace,
    id: authorizationCodeId,
    secretHash: "a".repeat(64),
    clientId: fixture.clientId,
    redirectUri,
    codeChallenge,
    refreshId: rootId,
    refreshSecretHash: "0".repeat(64),
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return { clientId: fixture.clientId, rootId };
}

async function setup(t: ReturnType<typeof convexTest>, label: string) {
  const account = await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject: `refresh-family-followup-${label}`,
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
    if (!ws || !dbAccount) throw new Error("OAuth follow-up fixture setup failed");
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
  });
}

async function cleanup(
  t: ReturnType<typeof convexTest>,
  familyExternalId: string,
  familyExpiresAt: number,
  scheduleGeneration: number,
) {
  return await t.mutation(cleanupRefreshFamily, {
    familyExternalId,
    familyExpiresAt,
    scheduleGeneration,
  });
}

async function readByExternalId(t: ReturnType<typeof convexTest>, externalId: string) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_external_id", (q: any) => q.eq("externalId", externalId))
    .unique());
}

async function readFamily(t: ReturnType<typeof convexTest>, familyExternalId: string) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_family_created", (q: any) => q.eq("familyExternalId", familyExternalId))
    .order("asc")
    .collect());
}

function clientId(label: string): string {
  return `oauth_client_${label.padEnd(12, "x")}`;
}

function codeId(label: string): string {
  return `oauth_code_${label.padEnd(12, "x")}`;
}

function refreshId(label: string): string {
  return `oauth_refresh_${label.padEnd(12, "x")}`;
}
