import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-family-followup-secret";
const defaultWorkspace = "test";
const resource = "https://api.stensibly.com/mcp";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const codeChallenge = "a".repeat(43);

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
      expect(await rotate(t, defaultWorkspace, {
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
      expect(await rotate(t, defaultWorkspace, {
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

  test("runs the workspace-scoped rootless cleanup chain through early retry and bounded deletion", async () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-05-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const t = convexTest(schema, modules);
      const owner = await setup(t, "rootless-owner", defaultWorkspace);
      const other = await setup(t, "rootless-other", "other");
      const familyExternalId = refreshId("sharedmissingroot");
      const familyExpiresAt = base + 60_000;
      const consumedId = refreshId("rootlessold");
      const leafId = refreshId("rootlessleaf");

      await insertRootlessFamily(t, owner, {
        familyExternalId,
        consumedId,
        leafId,
        familyExpiresAt,
        historyCount: 101,
        label: "ownerhistory",
        createdAt: base,
      });
      await insertRootlessFamily(t, other, {
        familyExternalId,
        consumedId: refreshId("otherold"),
        leafId: refreshId("otherleaf"),
        familyExpiresAt,
        historyCount: 1,
        label: "otherhistory",
        createdAt: base,
      });

      for (let replay = 0; replay < 2; replay += 1) {
        expect(await rotate(t, defaultWorkspace, {
          clientId: owner.clientId,
          id: consumedId,
          secretHash: "2".repeat(64),
          nextId: refreshId(`rootlessreplay${replay}`),
          nextSecretHash: "4".repeat(64),
          nextExpiresAt: familyExpiresAt,
        })).toEqual({ status: "replayed" });
      }

      const enrolledOwner = await readFamily(t, owner.workspaceId, familyExternalId);
      const untouchedOther = await readFamily(t, other.workspaceId, familyExternalId);
      expect(enrolledOwner).toHaveLength(103);
      expect(enrolledOwner[0]).toMatchObject({
        externalId: consumedId,
        familyExpiresAt,
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration: -1,
      });
      expect(enrolledOwner.at(-1)).toMatchObject({ externalId: leafId });
      expect(enrolledOwner.at(-1)?.revokedAt).toBeDefined();
      expect(untouchedOther).toHaveLength(3);
      expect(untouchedOther.at(-1)?.revokedAt).toBeUndefined();

      let jobs = await scheduledFunctions(t);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toEqual({ kind: "pending" });
      expect(scheduledArgs(jobs[0])).toMatchObject({
        workspaceId: owner.workspaceId,
        familyExternalId,
        familyExpiresAt,
        scheduleGeneration: -1,
      });

      clock.mockReturnValue(familyExpiresAt - 1);
      vi.advanceTimersByTime(60_000);
      await t.finishInProgressScheduledFunctions();
      expect(await readByExternalId(t, consumedId)).toMatchObject({
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration: -2,
      });

      jobs = await scheduledFunctions(t);
      expect(jobs).toHaveLength(2);
      expect(jobs.filter((job: any) => job.state.kind === "success")).toHaveLength(1);
      const successor = jobs.find((job: any) => job.state.kind === "pending");
      expect(scheduledArgs(successor)).toMatchObject({
        workspaceId: owner.workspaceId,
        familyExternalId,
        familyExpiresAt,
        scheduleGeneration: -2,
      });

      clock.mockReturnValue(familyExpiresAt);
      vi.advanceTimersByTime(1);
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(await readFamily(t, owner.workspaceId, familyExternalId)).toHaveLength(0);
      expect(await readFamily(t, other.workspaceId, familyExternalId)).toHaveLength(3);
      jobs = await scheduledFunctions(t);
      expect(jobs).toHaveLength(3);
      expect(jobs.every((job: any) => job.state.kind === "success")).toBe(true);
      expect(jobs.every((job: any) => (
        scheduledArgs(job).workspaceId === owner.workspaceId
        && scheduledArgs(job).familyExternalId === familyExternalId
      ))).toBe(true);
      expect(jobs.filter((job: any) => scheduledArgs(job).continuation === true)).toHaveLength(1);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test("missing family deadlines revoke and clean immediately without crossing workspaces", async () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-06-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const t = convexTest(schema, modules);
      const owner = await setup(t, "missing-owner", defaultWorkspace);
      const other = await setup(t, "missing-other", "other-missing");
      const familyExternalId = refreshId("missingdeadline");
      const consumedId = refreshId("missingdeadlineold");
      const leafId = refreshId("missingdeadlineleaf");

      await insertMalformedFamily(t, owner, {
        familyExternalId,
        consumedId,
        leafId,
        createdAt: base,
        coordinatorExpiresAt: 0,
        leafExpiresAt: 0,
      });
      await insertRootlessFamily(t, other, {
        familyExternalId,
        consumedId: refreshId("othermissingold"),
        leafId: refreshId("othermissingleaf"),
        familyExpiresAt: base + 60_000,
        historyCount: 0,
        label: "othermissinghistory",
        createdAt: base,
      });

      expect(await rotate(t, defaultWorkspace, {
        clientId: owner.clientId,
        id: consumedId,
        secretHash: "7".repeat(64),
        nextId: refreshId("missingdeadlinenext"),
        nextSecretHash: "8".repeat(64),
        nextExpiresAt: base + 60_000,
      })).toEqual({ status: "replayed" });
      expect(await readByExternalId(t, leafId)).toMatchObject({ revokedAt: base });

      const pending = await scheduledFunctions(t);
      expect(pending).toHaveLength(1);
      expect(scheduledArgs(pending[0])).toMatchObject({
        workspaceId: owner.workspaceId,
        familyExternalId,
        familyExpiresAt: base,
        scheduleGeneration: -1,
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await readFamily(t, owner.workspaceId, familyExternalId)).toHaveLength(0);
      expect(await readFamily(t, other.workspaceId, familyExternalId)).toHaveLength(2);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test("inconsistent family deadlines fail closed instead of selecting or extending one", async () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-07-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const t = convexTest(schema, modules);
      const fixture = await setup(t, "inconsistent", defaultWorkspace);
      const familyExternalId = refreshId("inconsistentdeadline");
      const consumedId = refreshId("inconsistentold");
      const leafId = refreshId("inconsistentleaf");

      await insertMalformedFamily(t, fixture, {
        familyExternalId,
        consumedId,
        leafId,
        createdAt: base,
        coordinatorExpiresAt: base + 60_000,
        coordinatorFamilyExpiresAt: base + 60_000,
        leafExpiresAt: base + 120_000,
        leafFamilyExpiresAt: base + 120_000,
      });

      expect(await rotate(t, defaultWorkspace, {
        clientId: fixture.clientId,
        id: consumedId,
        secretHash: "7".repeat(64),
        nextId: refreshId("inconsistentnext"),
        nextSecretHash: "8".repeat(64),
        nextExpiresAt: base + 60_000,
      })).toEqual({ status: "replayed" });

      expect(await readByExternalId(t, consumedId)).toMatchObject({
        familyExpiresAt: base,
        cleanupScheduledAt: base,
        cleanupScheduleGeneration: -1,
      });
      expect(await readByExternalId(t, leafId)).toMatchObject({ revokedAt: base });
      expect(scheduledArgs((await scheduledFunctions(t))[0])).toMatchObject({
        familyExpiresAt: base,
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await readFamily(t, fixture.workspaceId, familyExternalId)).toHaveLength(0);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });
});

async function createFamily(t: ReturnType<typeof convexTest>, label: string) {
  const fixture = await setup(t, label, defaultWorkspace);
  const authorizationCodeId = codeId(label);
  const rootId = refreshId(`${label}root`);
  await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
    serviceSecret,
    workspace: defaultWorkspace,
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
    workspace: defaultWorkspace,
    id: authorizationCodeId,
    secretHash: "a".repeat(64),
    clientId: fixture.clientId,
    redirectUri,
    codeChallenge,
    refreshId: rootId,
    refreshSecretHash: "0".repeat(64),
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return { ...fixture, rootId };
}

async function setup(
  t: ReturnType<typeof convexTest>,
  label: string,
  workspaceSlug: string,
) {
  const account = await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace: workspaceSlug,
    provider: "github",
    subject: `refresh-family-followup-${workspaceSlug}-${label}`,
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: "member",
    projects: ["scrapbook"],
  }) as any;
  const client = await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace: workspaceSlug,
    clientId: clientId(`${workspaceSlug}-${label}`),
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  }) as any;
  return await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspaceSlug)).unique();
    const dbAccount = await ctx.db.query("accounts")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", account.account.id)).unique();
    if (!ws || !dbAccount) throw new Error("OAuth follow-up fixture setup failed");
    return {
      accountId: account.account.id as string,
      accountDbId: dbAccount._id,
      clientId: client.clientId as string,
      workspaceId: ws._id,
      workspaceSlug,
    };
  });
}

async function insertRootlessFamily(
  t: ReturnType<typeof convexTest>,
  fixture: any,
  input: {
    familyExternalId: string;
    consumedId: string;
    leafId: string;
    familyExpiresAt: number;
    historyCount: number;
    label: string;
    createdAt: number;
  },
) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("mcpOAuthRefreshTokens", {
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountDbId,
      externalId: input.consumedId,
      familyExternalId: input.familyExternalId,
      familyExpiresAt: input.familyExpiresAt,
      secretHash: "2".repeat(64),
      clientExternalId: fixture.clientId,
      scopes: ["read", "offline_access"],
      resource,
      createdAt: input.createdAt,
      expiresAt: input.familyExpiresAt,
      consumedAt: input.createdAt + 1,
      rotatedToExternalId: input.leafId,
    });
    for (let index = 0; index < input.historyCount; index += 1) {
      const createdAt = input.createdAt + 2 + index;
      await ctx.db.insert("mcpOAuthRefreshTokens", {
        workspaceId: fixture.workspaceId,
        accountId: fixture.accountDbId,
        externalId: refreshId(`${input.label}${index.toString().padStart(3, "0")}`),
        familyExternalId: input.familyExternalId,
        familyExpiresAt: input.familyExpiresAt,
        secretHash: "6".repeat(64),
        clientExternalId: fixture.clientId,
        scopes: ["read", "offline_access"],
        resource,
        createdAt,
        expiresAt: input.familyExpiresAt,
        consumedAt: createdAt + 1,
      });
    }
    await ctx.db.insert("mcpOAuthRefreshTokens", {
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountDbId,
      externalId: input.leafId,
      familyExternalId: input.familyExternalId,
      familyExpiresAt: input.familyExpiresAt,
      secretHash: "3".repeat(64),
      clientExternalId: fixture.clientId,
      scopes: ["read", "offline_access"],
      resource,
      createdAt: input.createdAt + 1_000,
      expiresAt: input.familyExpiresAt,
    });
  });
}

async function insertMalformedFamily(
  t: ReturnType<typeof convexTest>,
  fixture: any,
  input: {
    familyExternalId: string;
    consumedId: string;
    leafId: string;
    createdAt: number;
    coordinatorExpiresAt: number;
    coordinatorFamilyExpiresAt?: number;
    leafExpiresAt: number;
    leafFamilyExpiresAt?: number;
  },
) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("mcpOAuthRefreshTokens", {
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountDbId,
      externalId: input.consumedId,
      familyExternalId: input.familyExternalId,
      ...(input.coordinatorFamilyExpiresAt === undefined
        ? {}
        : { familyExpiresAt: input.coordinatorFamilyExpiresAt }),
      secretHash: "7".repeat(64),
      clientExternalId: fixture.clientId,
      scopes: ["read", "offline_access"],
      resource,
      createdAt: input.createdAt,
      expiresAt: input.coordinatorExpiresAt,
      consumedAt: input.createdAt + 1,
      rotatedToExternalId: input.leafId,
    });
    await ctx.db.insert("mcpOAuthRefreshTokens", {
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountDbId,
      externalId: input.leafId,
      familyExternalId: input.familyExternalId,
      ...(input.leafFamilyExpiresAt === undefined
        ? {}
        : { familyExpiresAt: input.leafFamilyExpiresAt }),
      secretHash: "9".repeat(64),
      clientExternalId: fixture.clientId,
      scopes: ["read", "offline_access"],
      resource,
      createdAt: input.createdAt + 2,
      expiresAt: input.leafExpiresAt,
    });
  });
}

async function rotate(
  t: ReturnType<typeof convexTest>,
  workspaceSlug: string,
  input: Record<string, unknown>,
) {
  return await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
    serviceSecret,
    workspace: workspaceSlug,
    ...input,
  }) as any;
}

async function readByExternalId(t: ReturnType<typeof convexTest>, externalId: string) {
  return await t.run(async (ctx: any) => await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_external_id", (q: any) => q.eq("externalId", externalId))
    .unique());
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
  return Array.isArray(job?.args) ? job.args[0] : job?.args;
}

function clientId(label: string): string {
  const normalized = label.replace(/[^A-Za-z0-9_-]/g, "x");
  return `oauth_client_${normalized.padEnd(12, "x")}`;
}

function codeId(label: string): string {
  return `oauth_code_${label.padEnd(12, "x")}`;
}

function refreshId(label: string): string {
  return `oauth_refresh_${label.padEnd(12, "x")}`;
}
