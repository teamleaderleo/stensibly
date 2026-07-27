import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  classifyOAuthClientLifecycle,
} from "./mcpOAuthClientRegistration";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-client-lifecycle-repair-secret";
const defaultWorkspace = "test";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const resource = "https://api.stensibly.com/mcp";
const codeChallenge = "a".repeat(43);
const dayMs = 24 * 60 * 60 * 1000;

const registerClientRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientRegistration:registerClient",
);
const getClientRef = makeFunctionReference<"query">(
  "mcpOAuthClientRegistration:getClient",
);
const createAuthorizationCodeRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientRegistration:createAuthorizationCode",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth client lifecycle repair boundary", () => {
  test("commits final reference repairs before returning the terminal client limit", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-10T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const owner = await setupAccount(t, "owner", defaultWorkspace);
      const other = await setupAccount(t, "other", "other");
      const referencedId = clientId("referenced");
      const otherId = clientId("other-expired");

      await t.run(async (ctx: any) => {
        for (let index = 0; index < 1_000; index += 1) {
          const id = index === 0
            ? referencedId
            : clientId(`full-${index.toString().padStart(4, "0")}`);
          await ctx.db.insert("mcpOAuthClients", {
            workspaceId: owner.workspaceId,
            externalId: id,
            ...clientMetadata,
            lifecycleState: index === 0 ? "unused" : "used",
            unusedExpiresAt: index === 0 ? base - 1 : undefined,
            cleanupScheduledAt: index === 0 ? base - 1 : undefined,
            cleanupScheduleGeneration: index === 0 ? 1 : undefined,
            firstUsedAt: index === 0 ? undefined : base - dayMs,
            createdAt: base - 2 * dayMs + index,
            updatedAt: base - 2 * dayMs + index,
          });
        }
        await ctx.db.insert("mcpOAuthCodes", {
          workspaceId: owner.workspaceId,
          accountId: owner.accountDbId,
          externalId: codeId("reference"),
          secretHash: "b".repeat(64),
          clientExternalId: referencedId,
          redirectUri,
          codeChallenge,
          scopes: ["read"],
          resource,
          createdAt: base - 10,
          expiresAt: base + 60_000,
        });
        await ctx.db.insert("mcpOAuthClients", {
          workspaceId: other.workspaceId,
          externalId: otherId,
          ...clientMetadata,
          lifecycleState: "unused",
          unusedExpiresAt: base - 1,
          cleanupScheduledAt: base - 1,
          cleanupScheduleGeneration: 1,
          createdAt: base - dayMs,
          updatedAt: base - dayMs,
        });
      });

      expect(await scheduledFunctions(t)).toHaveLength(0);
      const first = await register(t, clientId("attempt-one"));
      expect(first).toEqual({ status: "limit" });
      const repaired = await readClient(t, referencedId);
      expect(repaired).toMatchObject({
        lifecycleState: "used",
        firstUsedAt: base,
        updatedAt: base,
      });
      expect(repaired).not.toHaveProperty("unusedExpiresAt");
      expect(repaired).not.toHaveProperty("cleanupScheduledAt");
      expect(repaired).not.toHaveProperty("cleanupScheduleGeneration");
      expect(await readClient(t, otherId)).toMatchObject({
        lifecycleState: "unused",
        unusedExpiresAt: base - 1,
      });

      const second = await register(t, clientId("attempt-two"));
      expect(second).toEqual({ status: "limit" });
      expect(await readClient(t, referencedId)).toMatchObject({ updatedAt: base });
      expect(await scheduledFunctions(t)).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  test("uses the trusted read time as a cache key and fails closed for malformed rows", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-11T00:00:00.000Z");
    const account = await setupAccount(t, "reader", defaultWorkspace);
    const validId = clientId("valid-unused");
    const legacyId = clientId("valid-legacy");
    const malformedId = clientId("malformed");

    await t.run(async (ctx: any) => {
      await ctx.db.insert("mcpOAuthClients", {
        workspaceId: account.workspaceId,
        externalId: validId,
        ...clientMetadata,
        lifecycleState: "unused",
        unusedExpiresAt: base + 1_000,
        cleanupScheduledAt: base + 1_000,
        cleanupScheduleGeneration: 1,
        createdAt: base,
        updatedAt: base,
      });
      await ctx.db.insert("mcpOAuthClients", {
        workspaceId: account.workspaceId,
        externalId: legacyId,
        ...clientMetadata,
        createdAt: base,
        updatedAt: base,
      });
      await ctx.db.insert("mcpOAuthClients", {
        workspaceId: account.workspaceId,
        externalId: malformedId,
        ...clientMetadata,
        lifecycleState: "unused",
        cleanupScheduledAt: base + 1_000,
        cleanupScheduleGeneration: 1,
        createdAt: base,
        updatedAt: base,
      });
    });

    expect(await getClient(t, validId, base)).toMatchObject({ clientId: validId });
    expect(await getClient(t, validId, base + 1_001)).toBeNull();
    expect(await readClient(t, validId)).toMatchObject({
      lifecycleState: "unused",
      unusedExpiresAt: base + 1_000,
    });
    expect(await getClient(t, legacyId, base + 10 * dayMs)).toMatchObject({
      clientId: legacyId,
    });
    expect(await getClient(t, malformedId, base)).toBeNull();
    expect(await register(t, malformedId)).toEqual({ status: "conflict" });

    await expect(t.mutation(createAuthorizationCodeRef, {
      serviceSecret,
      workspace: defaultWorkspace,
      accountId: account.accountId,
      clientId: malformedId,
      redirectUri,
      codeChallenge,
      scopes: ["read"],
      resource,
      id: codeId("malformed"),
      secretHash: "c".repeat(64),
      expiresAt: base + 60_000,
    })).rejects.toThrow("OAuth client is unavailable");

    expect(classifyOAuthClientLifecycle({})).toEqual({ kind: "legacy" });
    expect(classifyOAuthClientLifecycle({
      lifecycleState: "unused",
      unusedExpiresAt: base + dayMs,
    })).toEqual({ kind: "malformed" });
    expect(classifyOAuthClientLifecycle({
      lifecycleState: "used",
      firstUsedAt: base,
      unusedExpiresAt: base + dayMs,
    })).toEqual({ kind: "malformed" });
  });

  test("promotes an expired referenced replay and conflicts on an expired unreferenced replay", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-12T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const account = await setupAccount(t, "replay", defaultWorkspace);
      const referencedId = clientId("expired-ref");
      const unreferencedId = clientId("expired-empty");
      await t.run(async (ctx: any) => {
        for (const id of [referencedId, unreferencedId]) {
          await ctx.db.insert("mcpOAuthClients", {
            workspaceId: account.workspaceId,
            externalId: id,
            ...clientMetadata,
            lifecycleState: "unused",
            unusedExpiresAt: base - 1,
            cleanupScheduledAt: base - 1,
            cleanupScheduleGeneration: 7,
            createdAt: base - dayMs,
            updatedAt: base - dayMs,
          });
        }
        await ctx.db.insert("mcpOAuthCodes", {
          workspaceId: account.workspaceId,
          accountId: account.accountDbId,
          externalId: codeId("expired-ref"),
          secretHash: "d".repeat(64),
          clientExternalId: referencedId,
          redirectUri,
          codeChallenge,
          scopes: ["read"],
          resource,
          createdAt: base - 10,
          expiresAt: base + 60_000,
        });
      });

      const replay = await register(t, referencedId);
      expect(replay).toMatchObject({ status: "ok", client: { clientId: referencedId } });
      expect(await readClient(t, referencedId)).toMatchObject({
        lifecycleState: "used",
        firstUsedAt: base,
      });
      expect(await getClient(t, referencedId, base + dayMs)).toMatchObject({
        clientId: referencedId,
      });
      expect(await register(t, unreferencedId)).toEqual({ status: "conflict" });
      expect(await getClient(t, unreferencedId, base)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

const clientMetadata = {
  clientName: "ChatGPT",
  redirectUris: [redirectUri],
  tokenEndpointAuthMethod: "none" as const,
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
};

async function register(t: ReturnType<typeof convexTest>, id: string) {
  return await t.mutation(registerClientRef, {
    serviceSecret,
    workspace: defaultWorkspace,
    clientId: id,
    ...clientMetadata,
  }) as any;
}

async function getClient(t: ReturnType<typeof convexTest>, id: string, now: number) {
  return await t.query(getClientRef, {
    serviceSecret,
    workspace: defaultWorkspace,
    clientId: id,
    now,
  }) as any;
}

async function setupAccount(
  t: ReturnType<typeof convexTest>,
  label: string,
  workspace: string,
) {
  const account = await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject: `oauth-client-repair-${workspace}-${label}`,
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: "member",
    projects: ["scrapbook"],
  }) as any;
  return await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    const dbAccount = await ctx.db.query("accounts")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", account.account.id)).unique();
    if (!ws || !dbAccount) throw new Error("OAuth lifecycle repair fixture setup failed");
    return {
      workspaceId: ws._id,
      accountId: account.account.id as string,
      accountDbId: dbAccount._id,
    };
  });
}

async function readClient(t: ReturnType<typeof convexTest>, id: string) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_external_id", (q: any) => q.eq("externalId", id))
    .unique());
}

async function scheduledFunctions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: any) => await ctx.db.system
    .query("_scheduled_functions")
    .collect());
}

function clientId(label: string): string {
  const suffix = label.replace(/[^A-Za-z0-9_-]/g, "-").padEnd(12, "x");
  return `oauth_client_${suffix}`;
}

function codeId(label: string): string {
  const suffix = label.replace(/[^A-Za-z0-9_-]/g, "-").padEnd(12, "x");
  return `oauth_code_${suffix}`;
}
