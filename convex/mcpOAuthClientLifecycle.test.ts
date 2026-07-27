import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-client-lifecycle-secret";
const defaultWorkspace = "test";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const resource = "https://api.stensibly.com/mcp";
const codeChallenge = "a".repeat(43);
const dayMs = 24 * 60 * 60 * 1000;
const registerClientRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientRegistration:registerClient",
);
const getClientRef = makeFunctionReference<"query">(
  "mcpOAuthClientLifecycle:getClient",
);
const createAuthorizationCodeRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:createAuthorizationCode",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth dynamic-client lifecycle", () => {
  test("replays exact normalised metadata, rejects changed reuse, and preserves legacy clients", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const id = clientId("idempotent");
      const first = await register(t, defaultWorkspace, id, {
        redirectUris: [redirectUri, redirectUri],
        grantTypes: ["refresh_token", "authorization_code"],
      });
      const second = await register(t, defaultWorkspace, id, {
        redirectUris: [redirectUri],
        grantTypes: ["authorization_code", "refresh_token"],
      });
      expect(second).toEqual(first);

      const rows = await clientsInWorkspace(t, defaultWorkspace);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        externalId: id,
        lifecycleState: "unused",
        unusedExpiresAt: base + dayMs,
        cleanupScheduledAt: base + dayMs,
        cleanupScheduleGeneration: 1,
        createdAt: base,
      });
      expect(await scheduledFunctions(t)).toHaveLength(1);

      const changed = register(t, defaultWorkspace, id, { clientName: "Changed client" });
      await expect(changed).rejects.toThrow("MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT");

      const workspaceId = rows[0].workspaceId;
      const legacyId = clientId("legacy");
      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthClients", {
          workspaceId,
          externalId: legacyId,
          clientName: "Legacy client",
          redirectUris: [redirectUri],
          tokenEndpointAuthMethod: "none",
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          createdAt: base - 10 * dayMs,
          updatedAt: base - 10 * dayMs,
        });
      });
      expect(await t.query(getClientRef, {
        serviceSecret,
        workspace: defaultWorkspace,
        clientId: legacyId,
      })).toMatchObject({ clientId: legacyId, clientName: "Legacy client" });
    } finally {
      clock.mockRestore();
    }
  });

  test("runs the actual scheduled cleanup through an early successor and deletion", async () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-08-02T00:00:00.000Z");
    vi.setSystemTime(base);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const t = convexTest(schema, modules);
      const id = clientId("scheduled");
      await register(t, defaultWorkspace, id);
      const expiry = base + dayMs;

      let jobs = await scheduledFunctions(t);
      expect(jobs).toHaveLength(1);
      expect(scheduledArgs(jobs[0])).toMatchObject({
        clientExternalId: id,
        unusedExpiresAt: expiry,
        scheduleGeneration: 1,
      });

      clock.mockReturnValue(expiry - 1);
      vi.advanceTimersByTime(dayMs);
      await t.finishInProgressScheduledFunctions();
      expect(await readClient(t, id)).toMatchObject({
        cleanupScheduledAt: expiry,
        cleanupScheduleGeneration: 2,
      });
      jobs = await scheduledFunctions(t);
      expect(jobs).toHaveLength(2);
      expect(jobs.filter((job: any) => job.state.kind === "success")).toHaveLength(1);
      expect(scheduledArgs(jobs.find((job: any) => job.state.kind === "pending"))).toMatchObject({
        clientExternalId: id,
        scheduleGeneration: 2,
      });

      clock.mockReturnValue(expiry);
      vi.advanceTimersByTime(1);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await readClient(t, id)).toBeNull();
      jobs = await scheduledFunctions(t);
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job: any) => job.state.kind === "success")).toBe(true);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test("authorization use permanently blocks unused-client cleanup", async () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-08-03T00:00:00.000Z");
    vi.setSystemTime(base);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const t = convexTest(schema, modules);
      const account = await setupAccount(t, "used", defaultWorkspace);
      const id = clientId("used");
      await register(t, defaultWorkspace, id);
      await t.mutation(createAuthorizationCodeRef, {
        serviceSecret,
        workspace: defaultWorkspace,
        accountId: account.accountId,
        clientId: id,
        redirectUri,
        codeChallenge,
        scopes: ["read", "offline_access"],
        resource,
        id: codeId("used"),
        secretHash: "a".repeat(64),
        expiresAt: base + 60_000,
      });

      expect(await readClient(t, id)).toMatchObject({
        lifecycleState: "used",
        firstUsedAt: base,
      });
      expect(await readClient(t, id)).not.toHaveProperty("unusedExpiresAt");

      clock.mockReturnValue(base + dayMs);
      vi.advanceTimersByTime(dayMs);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await readClient(t, id)).toMatchObject({ lifecycleState: "used" });
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test("bounds ceiling recovery, protects code and refresh references, and isolates workspaces", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-04T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const owner = await setupAccount(t, "capacity-owner", defaultWorkspace);
      const other = await setupAccount(t, "capacity-other", "other");
      const expiredAt = base - 1;
      const deletableId = clientId("capacity100");
      const otherId = clientId("otherexpired");

      await t.run(async (ctx: any) => {
        for (let index = 0; index < 1_000; index += 1) {
          const id = clientId(`capacity${index.toString().padStart(3, "0")}`);
          const referenced = index < 100;
          const expiredCandidate = index <= 100;
          await ctx.db.insert("mcpOAuthClients", {
            workspaceId: owner.workspaceId,
            externalId: id,
            clientName: "Capacity client",
            redirectUris: [redirectUri],
            tokenEndpointAuthMethod: "none",
            grantTypes: ["authorization_code", "refresh_token"],
            responseTypes: ["code"],
            lifecycleState: expiredCandidate ? "unused" : "used",
            unusedExpiresAt: expiredCandidate ? expiredAt : undefined,
            cleanupScheduledAt: expiredCandidate ? expiredAt : undefined,
            cleanupScheduleGeneration: expiredCandidate ? 1 : undefined,
            firstUsedAt: expiredCandidate ? undefined : base,
            createdAt: base - 2 * dayMs + index,
            updatedAt: base - 2 * dayMs + index,
          });
          if (referenced && index < 99) {
            await ctx.db.insert("mcpOAuthCodes", {
              workspaceId: owner.workspaceId,
              accountId: owner.accountDbId,
              externalId: codeId(`ref${index.toString().padStart(3, "0")}`),
              secretHash: "b".repeat(64),
              clientExternalId: id,
              redirectUri,
              codeChallenge,
              scopes: ["read"],
              resource,
              createdAt: base,
              expiresAt: base + 60_000,
            });
          }
          if (referenced && index === 99) {
            await ctx.db.insert("mcpOAuthRefreshTokens", {
              workspaceId: owner.workspaceId,
              accountId: owner.accountDbId,
              externalId: refreshId("capacityref"),
              familyExternalId: refreshId("capacityref"),
              secretHash: "c".repeat(64),
              clientExternalId: id,
              scopes: ["read", "offline_access"],
              resource,
              createdAt: base,
              expiresAt: base + dayMs,
            });
          }
        }
        await ctx.db.insert("mcpOAuthClients", {
          workspaceId: other.workspaceId,
          externalId: otherId,
          clientName: "Other workspace client",
          redirectUris: [redirectUri],
          tokenEndpointAuthMethod: "none",
          grantTypes: ["authorization_code"],
          responseTypes: ["code"],
          lifecycleState: "unused",
          unusedExpiresAt: expiredAt,
          cleanupScheduledAt: expiredAt,
          cleanupScheduleGeneration: 1,
          createdAt: base - dayMs,
          updatedAt: base - dayMs,
        });
      });

      const attemptedId = clientId("retryable");
      let failure: unknown;
      try {
        await register(t, defaultWorkspace, attemptedId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED");
      expect((failure as Error).message).not.toContain(attemptedId);
      expect((failure as Error).message).not.toContain(redirectUri);
      expect(await readClient(t, deletableId)).not.toBeNull();
      expect(await readClient(t, otherId)).not.toBeNull();
      expect(await readClient(t, clientId("capacity000"))).toMatchObject({ lifecycleState: "used" });
      expect(await readClient(t, clientId("capacity099"))).toMatchObject({ lifecycleState: "used" });

      const created = await register(t, defaultWorkspace, attemptedId);
      expect(created.clientId).toBe(attemptedId);
      expect(await readClient(t, deletableId)).toBeNull();
      expect(await readClient(t, otherId)).not.toBeNull();
      expect(await clientsInWorkspace(t, defaultWorkspace)).toHaveLength(1_000);
    } finally {
      clock.mockRestore();
    }
  });
});

async function register(
  t: ReturnType<typeof convexTest>,
  workspace: string,
  id: string,
  overrides: {
    clientName?: string;
    redirectUris?: string[];
    grantTypes?: string[];
    responseTypes?: string[];
  } = {},
) {
  const result = await t.mutation(registerClientRef, {
    serviceSecret,
    workspace,
    clientId: id,
    clientName: overrides.clientName ?? "ChatGPT",
    redirectUris: overrides.redirectUris ?? [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: overrides.grantTypes ?? ["authorization_code", "refresh_token"],
    responseTypes: overrides.responseTypes ?? ["code"],
  }) as any;
  if (result.status === "ok") return result.client;
  if (result.status === "retryable") {
    throw new Error("MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED");
  }
  throw new Error("MCP_OAUTH_CLIENT_REGISTRATION_LIMIT_REACHED");
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
    subject: `oauth-client-lifecycle-${workspace}-${label}`,
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
    if (!ws || !dbAccount) throw new Error("OAuth lifecycle fixture setup failed");
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

async function clientsInWorkspace(t: ReturnType<typeof convexTest>, workspace: string) {
  return await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    if (!ws) return [];
    return await ctx.db.query("mcpOAuthClients")
      .withIndex("by_workspace_created", (q: any) => q.eq("workspaceId", ws._id))
      .collect();
  });
}

async function scheduledFunctions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: any) => await ctx.db.system
    .query("_scheduled_functions")
    .collect());
}

function scheduledArgs(job: any): any {
  return Array.isArray(job.args) ? job.args[0] : job.args;
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
