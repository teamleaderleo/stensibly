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
const dayMs = 24 * 60 * 60 * 1000;
const maxFamilyLifetimeMs = 90 * dayMs;
const acceptedFamilyLifetimeMs = 30 * dayMs;

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth refresh-family lifetime", () => {
  test("keeps the accepted root deadline through a long chain and deduplicates replay cleanup", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const { clientId, rootId, workspaceId } = await createFamily(t, "longchain");
      const familyExpiresAt = base + acceptedFamilyLifetimeMs;
      let currentId = rootId;
      let currentHash = hashFor(0);

      for (let index = 1; index <= 125; index += 1) {
        const now = base + index * 4 * 60 * 60 * 1000;
        clock.mockReturnValue(now);
        const nextId = refreshId(`chain${index.toString().padStart(8, "0")}`);
        const nextHash = hashFor(index);
        expect(await rotate(t, {
          clientId,
          id: currentId,
          secretHash: currentHash,
          nextId,
          nextSecretHash: nextHash,
          nextExpiresAt: now + maxFamilyLifetimeMs,
        })).toMatchObject({ status: "ok" });
        currentId = nextId;
        currentHash = nextHash;
      }

      const family = await readFamily(t, workspaceId, rootId);
      expect(family).toHaveLength(126);
      expect(family.every((token: any) => token.familyExpiresAt === familyExpiresAt)).toBe(true);
      expect(family.every((token: any) => token.expiresAt === familyExpiresAt)).toBe(true);
      expect(family[0]).toMatchObject({
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration: -1,
      });

      const issuanceJobs = await scheduledFunctions(t);
      expect(issuanceJobs).toHaveLength(1);
      expect(scheduledArgs(issuanceJobs[0])).toMatchObject({
        workspaceId,
        familyExternalId: rootId,
        familyExpiresAt,
        scheduleGeneration: -1,
      });

      clock.mockReturnValue(base + 25 * dayMs);
      for (let replay = 0; replay < 3; replay += 1) {
        expect(await rotate(t, {
          clientId,
          id: rootId,
          secretHash: hashFor(0),
          nextId: refreshId(`replay${replay.toString().padStart(6, "0")}`),
          nextSecretHash: "e".repeat(64),
          nextExpiresAt: Date.now() + dayMs,
        })).toEqual({ status: "replayed" });
      }

      const replayedFamily = await readFamily(t, workspaceId, rootId);
      expect(replayedFamily).toHaveLength(126);
      expect(replayedFamily.at(-1)?.externalId).toBe(currentId);
      expect(replayedFamily.at(-1)?.revokedAt).toBeDefined();
      expect(replayedFamily[0]).toMatchObject({
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration: -1,
      });
      expect(await scheduledFunctions(t)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("re-enrols one workspace-bound job from a legacy cleanup marker", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-02-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const fixture = await setup(t, "legacymarker");
      const rootId = refreshId("legacymarkerroot");
      const leafId = refreshId("legacymarkerleaf");
      const familyExpiresAt = base + acceptedFamilyLifetimeMs;
      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: fixture.workspaceId,
          accountId: fixture.accountDbId,
          externalId: rootId,
          familyExternalId: rootId,
          familyExpiresAt,
          cleanupScheduledAt: familyExpiresAt,
          cleanupScheduleGeneration: 7,
          secretHash: hashFor(0),
          clientExternalId: fixture.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base,
          expiresAt: familyExpiresAt,
          consumedAt: base + 1,
          rotatedToExternalId: leafId,
        });
        await ctx.db.insert("mcpOAuthRefreshTokens", {
          workspaceId: fixture.workspaceId,
          accountId: fixture.accountDbId,
          externalId: leafId,
          familyExternalId: rootId,
          familyExpiresAt,
          secretHash: hashFor(1),
          clientExternalId: fixture.clientId,
          scopes: ["read", "offline_access"],
          resource,
          createdAt: base + 2,
          expiresAt: familyExpiresAt,
        });
      });

      expect(await scheduledFunctions(t)).toHaveLength(0);
      for (let replay = 0; replay < 2; replay += 1) {
        expect(await rotate(t, {
          clientId: fixture.clientId,
          id: rootId,
          secretHash: hashFor(0),
          nextId: refreshId(`legacyreplay${replay.toString().padStart(4, "0")}`),
          nextSecretHash: "f".repeat(64),
          nextExpiresAt: base + dayMs,
        })).toEqual({ status: "replayed" });
      }

      const family = await readFamily(t, fixture.workspaceId, rootId);
      expect(family).toHaveLength(2);
      expect(family[0]).toMatchObject({
        externalId: rootId,
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration: -8,
      });
      expect(family[1]).toMatchObject({ externalId: leafId, revokedAt: base });

      const jobs = await scheduledFunctions(t);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toEqual({ kind: "pending" });
      expect(scheduledArgs(jobs[0])).toMatchObject({
        workspaceId: fixture.workspaceId,
        familyExternalId: rootId,
        familyExpiresAt,
        scheduleGeneration: -8,
      });
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
    refreshSecretHash: hashFor(0),
    refreshExpiresAt: Date.now() + acceptedFamilyLifetimeMs,
  });
  return { ...fixture, rootId };
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

async function readFamily(
  t: ReturnType<typeof convexTest>,
  workspaceId: any,
  familyExternalId: string,
) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_workspace_family_created", (q: any) => q
      .eq("workspaceId", workspaceId)
      .eq("familyExternalId", familyExternalId))
    .order("asc")
    .collect());
}

async function scheduledFunctions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: any) => await ctx.db.system
    .query("_scheduled_functions")
    .collect());
}

function scheduledArgs(job: any): any {
  return Array.isArray(job.args) ? job.args[0] : job.args;
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
