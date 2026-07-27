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
        await ctx.db.insert("mcpOAuthClients", clientRecord(workspaceId, legacyId, base - 10 * dayMs, {
          clientName: "Legacy client",
        }));
      });
      expect(await lookupClient(t, legacyId, base)).toMatchObject({
        clientId: legacyId,
        clientName: "Legacy client",
      });
      expect(await register(t, defaultWorkspace, legacyId, { clientName: "Legacy client" })).toMatchObject({
        clientId: legacyId,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("keys client availability by trusted lookup time without a row mutation", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-01T12:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const id = clientId("cachetime");
      await register(t, defaultWorkspace, id);
      const before = await readClient(t, id);
      expect(await lookupClient(t, id, base + dayMs - 1)).toMatchObject({ clientId: id });
      expect(await lookupClient(t, id, base + dayMs)).toBeNull();
      expect(await readClient(t, id)).toEqual(before);
    } finally {
      clock.mockRestore();
    }
  });

  test("rejects expired exact replay unless a durable reference promotes the client", async () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-08-01T18:00:00.000Z");
    vi.setSystemTime(base);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const t = convexTest(schema, modules);
      const account = await setupAccount(t, "expired-replay", defaultWorkspace);
      const expiredId = clientId("expiredplain");
      const referencedId = clientId("expiredref");
      await register(t, defaultWorkspace, expiredId);
      await register(t, defaultWorkspace, referencedId);
      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthCodes", {
          workspaceId: account.workspaceId,
          accountId: account.accountDbId,
          externalId: codeId("durableref"),
          secretHash: "d".repeat(64),
          clientExternalId: referencedId,
          redirectUri,
          codeChallenge,
          scopes: ["read"],
          resource,
          createdAt: base,
          expiresAt: base + dayMs + 60_000,
        });
      });

      const expiry = base + dayMs;
      clock.mockReturnValue(expiry);
      vi.setSystemTime(expiry);

      await expect(register(t, defaultWorkspace, expiredId)).rejects.toThrow(
        "MCP_OAUTH_CLIENT_REGISTRATION_EXPIRED",
      );
      expect(await lookupClient(t, expiredId, expiry)).toBeNull();
      await expect(createCode(t, account.accountId, expiredId, codeId("expiredfail"), expiry))
        .rejects.toThrow("OAuth client is unavailable");

      expect(await register(t, defaultWorkspace, referencedId)).toMatchObject({ clientId: referencedId });
      expect(await readClient(t, referencedId)).toMatchObject({
        lifecycleState: "used",
        firstUsedAt: expiry,
      });
      expect(await lookupClient(t, referencedId, expiry)).toMatchObject({ clientId: referencedId });

      vi.advanceTimersByTime(dayMs);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await readClient(t, expiredId)).toBeNull();
      expect(await readClient(t, referencedId)).toMatchObject({ lifecycleState: "used" });
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test("fails closed for partial or contradictory lifecycle rows while retaining true legacy rows", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-01T20:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const account = await setupAccount(t, "malformed", defaultWorkspace);
      const malformed = [
        {
          id: clientId("missingexpiry"),
          fields: {
            lifecycleState: "unused",
            cleanupScheduledAt: base + dayMs,
            cleanupScheduleGeneration: 1,
          },
        },
        {
          id: clientId("missingsched"),
          fields: {
            lifecycleState: "unused",
            unusedExpiresAt: base + dayMs,
            cleanupScheduleGeneration: 1,
          },
        },
        {
          id: clientId("missinggen"),
          fields: {
            lifecycleState: "unused",
            unusedExpiresAt: base + dayMs,
            cleanupScheduledAt: base + dayMs,
          },
        },
        {
          id: clientId("usedwithexp"),
          fields: {
            lifecycleState: "used",
            firstUsedAt: base,
            unusedExpiresAt: base + dayMs,
            cleanupScheduledAt: base + dayMs,
            cleanupScheduleGeneration: 1,
          },
        },
        {
          id: clientId("unusedfirst"),
          fields: {
            lifecycleState: "unused",
            firstUsedAt: base,
            unusedExpiresAt: base + dayMs,
            cleanupScheduledAt: base + dayMs,
            cleanupScheduleGeneration: 1,
          },
        },
      ];
      const legacyId = clientId("strictlegacy");
      await t.run(async (ctx: any) => {
        await ctx.db.insert("mcpOAuthClients", clientRecord(account.workspaceId, legacyId, base - dayMs));
        for (const entry of malformed) {
          await ctx.db.insert("mcpOAuthClients", clientRecord(
            account.workspaceId,
            entry.id,
            base - dayMs,
            entry.fields,
          ));
        }
      });

      expect(await lookupClient(t, legacyId, base)).toMatchObject({ clientId: legacyId });
      expect(await register(t, defaultWorkspace, legacyId)).toMatchObject({ clientId: legacyId });

      for (const [index, entry] of malformed.entries()) {
        expect(await lookupClient(t, entry.id, base)).toBeNull();
        await expect(register(t, defaultWorkspace, entry.id)).rejects.toThrow(
          "MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT",
        );
        await expect(createCode(
          t,
          account.accountId,
          entry.id,
          codeId(`malformed${index}`),
          base,
        )).rejects.toThrow("OAuth client is unavailable");
      }
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
      await createCode(t, account.accountId, id, codeId("used"), base);

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
          await ctx.db.insert("mcpOAuthClients", clientRecord(owner.workspaceId, id, base - 2 * dayMs + index, {
            lifecycleState: expiredCandidate ? "unused" : "used",
            unusedExpiresAt: expiredCandidate ? expiredAt : undefined,
            cleanupScheduledAt: expiredCandidate ? expiredAt : undefined,
            cleanupScheduleGeneration: expiredCandidate ? 1 : undefined,
            firstUsedAt: expiredCandidate ? undefined : base,
          }));
          if (referenced && index < 99) {
            await insertCodeReference(ctx, owner, id, codeId(`ref${index.toString().padStart(3, "0")}`), base);
          }
          if (referenced && index === 99) {
            await insertRefreshReference(ctx, owner, id, refreshId("capacityref"), base);
          }
        }
        await ctx.db.insert("mcpOAuthClients", clientRecord(other.workspaceId, otherId, base - dayMs, {
          grantTypes: ["authorization_code"],
          lifecycleState: "unused",
          unusedExpiresAt: expiredAt,
          cleanupScheduledAt: expiredAt,
          cleanupScheduleGeneration: 1,
        }));
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

  test("commits the final all-referenced capacity batch before returning limit", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-05T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const owner = await setupAccount(t, "terminal-owner", defaultWorkspace);
      const other = await setupAccount(t, "terminal-other", "terminal-other");
      const expiredAt = base - 1;
      const otherId = clientId("terminalother");

      await t.run(async (ctx: any) => {
        for (let index = 0; index < 1_000; index += 1) {
          const id = clientId(`terminal${index.toString().padStart(3, "0")}`);
          const expired = index < 100;
          await ctx.db.insert("mcpOAuthClients", clientRecord(owner.workspaceId, id, base - dayMs + index, {
            lifecycleState: expired ? "unused" : "used",
            unusedExpiresAt: expired ? expiredAt : undefined,
            cleanupScheduledAt: expired ? expiredAt : undefined,
            cleanupScheduleGeneration: expired ? 1 : undefined,
            firstUsedAt: expired ? undefined : base,
          }));
          if (expired && index < 99) {
            await insertCodeReference(ctx, owner, id, codeId(`terminal${index.toString().padStart(3, "0")}`), base);
          } else if (expired) {
            await insertRefreshReference(ctx, owner, id, refreshId("terminalref"), base);
          }
        }
        await ctx.db.insert("mcpOAuthClients", clientRecord(other.workspaceId, otherId, base - dayMs, {
          lifecycleState: "unused",
          unusedExpiresAt: expiredAt,
          cleanupScheduledAt: expiredAt,
          cleanupScheduleGeneration: 1,
        }));
      });

      expect(await scheduledFunctions(t)).toHaveLength(0);
      expect(await registrationResult(t, defaultWorkspace, clientId("terminallimit"))).toEqual({
        status: "limit",
      });

      const repaired = await Promise.all(
        Array.from({ length: 100 }, (_, index) => readClient(
          t,
          clientId(`terminal${index.toString().padStart(3, "0")}`),
        )),
      );
      expect(repaired.every((client) => client?.lifecycleState === "used")).toBe(true);
      expect(repaired.every((client) => client?.unusedExpiresAt === undefined)).toBe(true);
      expect(repaired.every((client) => client?.cleanupScheduledAt === undefined)).toBe(true);
      expect(repaired.every((client) => client?.cleanupScheduleGeneration === undefined)).toBe(true);
      expect(await lookupClient(t, clientId("terminal000"), base)).toMatchObject({
        clientId: clientId("terminal000"),
      });
      await createCode(t, owner.accountId, clientId("terminal099"), codeId("terminalauth"), base);

      const firstSnapshot = repaired.map((client) => ({
        firstUsedAt: client?.firstUsedAt,
        updatedAt: client?.updatedAt,
      }));
      expect(await registrationResult(t, defaultWorkspace, clientId("terminallimit2"))).toEqual({
        status: "limit",
      });
      const replayed = await Promise.all(
        Array.from({ length: 100 }, (_, index) => readClient(
          t,
          clientId(`terminal${index.toString().padStart(3, "0")}`),
        )),
      );
      expect(replayed.map((client) => ({
        firstUsedAt: client?.firstUsedAt,
        updatedAt: client?.updatedAt,
      }))).toEqual(firstSnapshot);
      expect(await readClient(t, otherId)).toMatchObject({ lifecycleState: "unused" });
      expect(await scheduledFunctions(t)).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  test("commits safe over-cap deletion and quarantines unreferenced malformed candidates", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-06T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const owner = await setupAccount(t, "overcap-owner", defaultWorkspace);
      const malformedId = clientId("overcapbad");
      const deletableId = clientId("overcapdelete");
      const expiredAt = base - 1;
      await t.run(async (ctx: any) => {
        for (let index = 0; index < 999; index += 1) {
          await ctx.db.insert("mcpOAuthClients", clientRecord(
            owner.workspaceId,
            clientId(`overcap${index.toString().padStart(3, "0")}`),
            base - dayMs + index,
            { lifecycleState: "used", firstUsedAt: base },
          ));
        }
        await ctx.db.insert("mcpOAuthClients", clientRecord(owner.workspaceId, malformedId, base - 2, {
          lifecycleState: "unused",
          unusedExpiresAt: expiredAt,
          cleanupScheduleGeneration: 1,
        }));
        await ctx.db.insert("mcpOAuthClients", clientRecord(owner.workspaceId, deletableId, base - 1, {
          lifecycleState: "unused",
          unusedExpiresAt: expiredAt,
          cleanupScheduledAt: expiredAt,
          cleanupScheduleGeneration: 1,
        }));
      });

      expect(await registrationResult(t, defaultWorkspace, clientId("overcapattempt"))).toEqual({
        status: "limit",
      });
      expect(await readClient(t, deletableId)).toBeNull();
      expect(await clientsInWorkspace(t, defaultWorkspace)).toHaveLength(1_000);
      const quarantined = await readClient(t, malformedId);
      expect(quarantined).toMatchObject({ lifecycleState: "unused" });
      expect(quarantined?.unusedExpiresAt).toBeUndefined();
      expect(quarantined?.cleanupScheduledAt).toBeUndefined();
      expect(quarantined?.cleanupScheduleGeneration).toBeUndefined();
      expect(await lookupClient(t, malformedId, base)).toBeNull();

      const snapshot = { updatedAt: quarantined?.updatedAt };
      expect(await registrationResult(t, defaultWorkspace, clientId("overcapretry"))).toEqual({
        status: "limit",
      });
      expect({ updatedAt: (await readClient(t, malformedId))?.updatedAt }).toEqual(snapshot);
    } finally {
      clock.mockRestore();
    }
  });
});

async function registrationResult(
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
  return await t.mutation(registerClientRef, {
    serviceSecret,
    workspace,
    clientId: id,
    clientName: overrides.clientName ?? "ChatGPT",
    redirectUris: overrides.redirectUris ?? [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: overrides.grantTypes ?? ["authorization_code", "refresh_token"],
    responseTypes: overrides.responseTypes ?? ["code"],
  }) as any;
}

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
  const result = await registrationResult(t, workspace, id, overrides);
  if (result.status === "ok") return result.client;
  if (result.status === "retryable") {
    throw new Error("MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED");
  }
  throw new Error("MCP_OAUTH_CLIENT_REGISTRATION_LIMIT_REACHED");
}

async function lookupClient(
  t: ReturnType<typeof convexTest>,
  id: string,
  now: number,
) {
  return await t.query(getClientRef, {
    serviceSecret,
    workspace: defaultWorkspace,
    clientId: id,
    now,
  }) as any;
}

async function createCode(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  clientExternalId: string,
  externalId: string,
  now: number,
) {
  return await t.mutation(createAuthorizationCodeRef, {
    serviceSecret,
    workspace: defaultWorkspace,
    accountId,
    clientId: clientExternalId,
    redirectUri,
    codeChallenge,
    scopes: ["read", "offline_access"],
    resource,
    id: externalId,
    secretHash: "a".repeat(64),
    expiresAt: now + 60_000,
  });
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

function clientRecord(
  workspaceId: any,
  externalId: string,
  createdAt: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    workspaceId,
    externalId,
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

async function insertCodeReference(
  ctx: any,
  owner: { workspaceId: any; accountDbId: any },
  clientExternalId: string,
  externalId: string,
  now: number,
) {
  await ctx.db.insert("mcpOAuthCodes", {
    workspaceId: owner.workspaceId,
    accountId: owner.accountDbId,
    externalId,
    secretHash: "b".repeat(64),
    clientExternalId,
    redirectUri,
    codeChallenge,
    scopes: ["read"],
    resource,
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

async function insertRefreshReference(
  ctx: any,
  owner: { workspaceId: any; accountDbId: any },
  clientExternalId: string,
  externalId: string,
  now: number,
) {
  await ctx.db.insert("mcpOAuthRefreshTokens", {
    workspaceId: owner.workspaceId,
    accountId: owner.accountDbId,
    externalId,
    familyExternalId: externalId,
    secretHash: "c".repeat(64),
    clientExternalId,
    scopes: ["read", "offline_access"],
    resource,
    createdAt: now,
    expiresAt: now + dayMs,
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
