import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-client-boundary-secret";
const workspace = "test";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const resource = "https://api.stensibly.com/mcp";
const codeChallenge = "a".repeat(43);
const registerRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycleBoundary:registerClient",
);
const createCodeRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycleBoundary:createAuthorizationCode",
);
const getClientRef = makeFunctionReference<"query">(
  "mcpOAuthClientLifecycle:getClient",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth lifecycle repair boundary", () => {
  test("commits reference-backed repair while changed registration metadata conflicts", async () => {
    const t = convexTest(schema, modules);
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const account = await setupAccount(t, "registration");
      const referencedId = clientId("changedref");
      const unreferencedId = clientId("changedplain");
      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthClients", expiredClient(account.workspaceId, referencedId, now));
        await ctx.db.insert("mcpOAuthClients", expiredClient(account.workspaceId, unreferencedId, now));
        await insertCodeReference(ctx, account, referencedId, codeId("changedref"), now);
      });

      expect(await t.mutation(registerRef, registrationArgs(referencedId, "Changed client"))).toEqual({
        status: "conflict",
      });
      const repaired = await readClient(t, referencedId);
      expect(repaired).toMatchObject({ lifecycleState: "used", firstUsedAt: now });
      expect(repaired?.unusedExpiresAt).toBeUndefined();
      expect(await lookupClient(t, referencedId, now)).toMatchObject({ clientId: referencedId });

      expect(await t.mutation(registerRef, registrationArgs(unreferencedId, "Changed client"))).toEqual({
        status: "conflict",
      });
      expect(await readClient(t, unreferencedId)).toMatchObject({
        lifecycleState: "unused",
        unusedExpiresAt: now - 1,
      });
      expect(await lookupClient(t, unreferencedId, now)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  test("commits reference-backed repair while a new authorization attempt fails", async () => {
    const t = convexTest(schema, modules);
    const now = Date.parse("2026-08-08T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const account = await setupAccount(t, "authorization");
      const referencedId = clientId("authref");
      const unreferencedId = clientId("authplain");
      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthClients", expiredClient(account.workspaceId, referencedId, now));
        await ctx.db.insert("mcpOAuthClients", expiredClient(account.workspaceId, unreferencedId, now));
        await insertCodeReference(ctx, account, referencedId, codeId("authrefexisting"), now);
      });

      expect(await t.mutation(createCodeRef, authorizationArgs(
        account.accountId,
        referencedId,
        codeId("authreffail"),
        now,
      ))).toEqual({ status: "invalid" });
      expect(await readClient(t, referencedId)).toMatchObject({
        lifecycleState: "used",
        firstUsedAt: now,
      });
      expect(await lookupClient(t, referencedId, now)).toMatchObject({ clientId: referencedId });
      expect(await readCode(t, codeId("authreffail"))).toBeNull();

      expect(await t.mutation(createCodeRef, authorizationArgs(
        account.accountId,
        unreferencedId,
        codeId("authplainfail"),
        now,
      ))).toEqual({ status: "invalid" });
      expect(await readClient(t, unreferencedId)).toMatchObject({
        lifecycleState: "unused",
        unusedExpiresAt: now - 1,
      });
      expect(await lookupClient(t, unreferencedId, now)).toBeNull();
      expect(await readCode(t, codeId("authplainfail"))).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

function registrationArgs(id: string, clientName: string) {
  return {
    serviceSecret,
    workspace,
    clientId: id,
    clientName,
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none" as const,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  };
}

function authorizationArgs(accountId: string, id: string, newCodeId: string, now: number) {
  return {
    serviceSecret,
    workspace,
    accountId,
    clientId: id,
    redirectUri: "https://example.com/not-registered",
    codeChallenge,
    scopes: ["read", "offline_access"] as const,
    resource,
    id: newCodeId,
    secretHash: "b".repeat(64),
    expiresAt: now + 60_000,
  };
}

async function setupAccount(t: ReturnType<typeof convexTest>, label: string) {
  const result = await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject: `oauth-boundary-${label}`,
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: "member",
    projects: ["scrapbook"],
  }) as any;
  return await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    const account = await ctx.db.query("accounts")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", result.account.id)).unique();
    if (!ws || !account) throw new Error("OAuth boundary fixture setup failed");
    return {
      workspaceId: ws._id,
      accountId: result.account.id as string,
      accountDbId: account._id,
    };
  });
}

function expiredClient(workspaceId: any, id: string, now: number) {
  return {
    workspaceId,
    externalId: id,
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none" as const,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    lifecycleState: "unused" as const,
    unusedExpiresAt: now - 1,
    cleanupScheduledAt: now - 1,
    cleanupScheduleGeneration: 1,
    createdAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
  };
}

async function insertCodeReference(
  ctx: any,
  account: { workspaceId: any; accountDbId: any },
  clientExternalId: string,
  externalId: string,
  now: number,
) {
  await ctx.db.insert("mcpOAuthCodes", {
    workspaceId: account.workspaceId,
    accountId: account.accountDbId,
    externalId,
    secretHash: "c".repeat(64),
    clientExternalId,
    redirectUri,
    codeChallenge,
    scopes: ["read"],
    resource,
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
  });
}

async function readClient(t: ReturnType<typeof convexTest>, id: string) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_external_id", (q: any) => q.eq("externalId", id))
    .unique());
}

async function lookupClient(t: ReturnType<typeof convexTest>, id: string, now: number) {
  return await t.query(getClientRef, {
    serviceSecret,
    workspace,
    clientId: id,
    now,
  }) as any;
}

async function readCode(t: ReturnType<typeof convexTest>, id: string) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthCodes")
    .withIndex("by_external_id", (q: any) => q.eq("externalId", id))
    .unique());
}

function clientId(label: string): string {
  return `oauth_client_${label.padEnd(12, "x")}`;
}

function codeId(label: string): string {
  return `oauth_code_${label.padEnd(12, "x")}`;
}
