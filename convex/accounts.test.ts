import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "account-test-secret";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex hosted accounts", () => {
  test("reuses provider subjects without email merging or membership escalation", async () => {
    const t = convexTest(schema, modules);
    const first = await upsertGithubAccount(t, {
      subject: "1001",
      username: "leo",
      displayName: "Leo",
      email: "LEO@example.com",
      role: "viewer",
      projects: ["scrapbook"],
    });
    expect(first).toMatchObject({
      account: {
        displayName: "Leo",
        primaryEmail: "leo@example.com",
      },
      identity: {
        provider: "github",
        subject: "1001",
        username: "leo",
        emailVerified: true,
      },
      membership: {
        workspace: "test",
        role: "viewer",
        projects: ["scrapbook"],
        revokedAt: null,
      },
    });

    const repeated = await upsertGithubAccount(t, {
      subject: "1001",
      username: "teamleaderleo",
      displayName: "Leo Updated",
      email: undefined,
      emailVerified: true,
      role: "owner",
      projects: ["another-project"],
    });
    expect(repeated.account.id).toBe(first.account.id);
    expect(repeated.account).toMatchObject({
      displayName: "Leo Updated",
      primaryEmail: "leo@example.com",
    });
    expect(repeated.identity).toMatchObject({
      username: "teamleaderleo",
      email: null,
      emailVerified: false,
    });
    expect(repeated.membership).toMatchObject({
      role: "viewer",
      projects: ["scrapbook"],
    });

    const sameEmailDifferentSubject = await upsertGithubAccount(t, {
      subject: "2002",
      username: "another-leo",
      displayName: "Another Leo",
      email: "leo@example.com",
    });
    expect(sameEmailDifferentSubject.account.id).not.toBe(first.account.id);
  });

  test("creates, authenticates, rotates, lists, and account-bounds browser sessions", async () => {
    const t = convexTest(schema, modules);
    const accountContext = await upsertGithubAccount(t, {
      subject: "1001",
      username: "leo",
      displayName: "Leo",
      email: "leo@example.com",
      role: "member",
      projects: ["scrapbook"],
    });
    const otherAccount = await upsertGithubAccount(t, {
      subject: "2002",
      username: "other",
      displayName: "Other",
      email: "other@example.com",
      role: "viewer",
    });
    const firstHash = "a".repeat(64);
    const nextHash = "b".repeat(64);

    const created = await createBrowserSession(t, accountContext.account.id, {
      id: "ses_1234567890abcdef",
      secretHash: firstHash,
      userAgent: "Stensibly test browser",
    });
    expect(created).toMatchObject({
      id: "ses_1234567890abcdef",
      userAgent: "Stensibly test browser",
      revokedAt: null,
    });
    expect(JSON.stringify(created)).not.toContain(firstHash);

    const authenticated = await authenticateBrowserSession(t, created.id, firstHash);
    expect(authenticated).toMatchObject({
      account: { id: accountContext.account.id, displayName: "Leo" },
      membership: { role: "member", projects: ["scrapbook"] },
      principal: {
        type: "account",
        accountId: accountContext.account.id,
        workspace: "test",
        role: "member",
        scopes: ["read", "write"],
        projects: ["scrapbook"],
      },
      capabilities: { read: true, write: true, admin: false },
    });

    expect(await authenticateBrowserSession(t, created.id, "invalid-hash")).toBeNull();
    expect(await authenticateBrowserSession(t, created.id, "c".repeat(64))).toBeNull();

    const rotated = await t.mutation(convexApi.accounts.rotateSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: firstHash,
      nextSecretHash: nextHash,
      expiresAt: Date.now() + 120_000,
    }) as any;
    expect(rotated.id).toBe(created.id);
    expect(await authenticateBrowserSession(t, created.id, firstHash)).toBeNull();

    const touched = await t.mutation(convexApi.accounts.touchSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: nextHash,
    }) as any;
    expect(touched.id).toBe(created.id);

    const sessions = await t.query(convexApi.accounts.listSessions, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
    }) as any[];
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(nextHash);

    const updatedAccount = await t.mutation(convexApi.accounts.setDefaultActor, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
      actorId: "leo",
    }) as any;
    expect(updatedAccount.defaultActorId).toBe("leo");

    const crossAccountRevocation = await t.mutation(convexApi.accounts.revokeSession, {
      serviceSecret,
      workspace: "test",
      accountId: otherAccount.account.id,
      id: created.id,
    });
    expect(crossAccountRevocation).toBeNull();
    expect(await authenticateBrowserSession(t, created.id, nextHash)).not.toBeNull();

    const revoked = await t.mutation(convexApi.accounts.revokeSession, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
      id: created.id,
    }) as any;
    expect(revoked.revokedAt).not.toBeNull();
    expect(await authenticateBrowserSession(t, created.id, nextHash)).toBeNull();
  });

  test("fails closed for missing memberships, disabled accounts, revoked memberships, and expiry", async () => {
    const t = convexTest(schema, modules);
    const accountContext = await upsertGithubAccount(t, {
      subject: "1001",
      username: "leo",
      displayName: "Leo",
      email: "leo@example.com",
      role: "member",
    });
    const secretHash = "d".repeat(64);

    await expect(createBrowserSession(t, accountContext.account.id, {
      id: "ses_wrong_workspace",
      secretHash,
      workspace: "other",
    })).rejects.toThrow("Account membership is unavailable");

    const created = await createBrowserSession(t, accountContext.account.id, {
      id: "ses_fail_closed",
      secretHash,
    });

    await t.run(async (ctx) => {
      const account = await ctx.db
        .query("accounts")
        .withIndex("by_external_id", (q) => q.eq("externalId", accountContext.account.id))
        .unique();
      if (!account) throw new Error("Test account disappeared");
      await ctx.db.patch(account._id, { disabledAt: Date.now() });
    });

    expect(await authenticateBrowserSession(t, created.id, secretHash)).toBeNull();
    expect(await t.mutation(convexApi.accounts.touchSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash,
    })).toBeNull();
    expect(await t.mutation(convexApi.accounts.rotateSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash,
      nextSecretHash: "e".repeat(64),
      expiresAt: Date.now() + 60_000,
    })).toBeNull();
    expect(await t.query(convexApi.accounts.listSessions, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
    })).toEqual([]);

    await t.run(async (ctx) => {
      const account = await ctx.db
        .query("accounts")
        .withIndex("by_external_id", (q) => q.eq("externalId", accountContext.account.id))
        .unique();
      if (!account) throw new Error("Test account disappeared");
      await ctx.db.patch(account._id, { disabledAt: undefined });
      const workspace = await ctx.db
        .query("workspaces")
        .withIndex("by_slug", (q) => q.eq("slug", "test"))
        .unique();
      if (!workspace) throw new Error("Test workspace disappeared");
      const membership = await ctx.db
        .query("workspaceMemberships")
        .withIndex("by_account_workspace", (q) =>
          q.eq("accountId", account._id).eq("workspaceId", workspace._id),
        )
        .unique();
      if (!membership) throw new Error("Test membership disappeared");
      await ctx.db.patch(membership._id, { revokedAt: Date.now() });
    });

    expect(await authenticateBrowserSession(t, created.id, secretHash)).toBeNull();
    await expect(t.mutation(convexApi.accounts.setDefaultActor, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
      actorId: "leo",
    })).rejects.toThrow("Account membership is unavailable");
    await expect(upsertGithubAccount(t, {
      subject: "1001",
      username: "leo",
      displayName: "Leo",
      email: "leo@example.com",
    })).rejects.toThrow("Workspace membership is revoked");

    const expiringAccount = await upsertGithubAccount(t, {
      subject: "3003",
      username: "expired",
      displayName: "Expired",
      email: "expired@example.com",
      role: "viewer",
    });
    const expiringSession = await createBrowserSession(t, expiringAccount.account.id, {
      id: "ses_expired",
      secretHash: "f".repeat(64),
    });
    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("browserSessions")
        .withIndex("by_external_id", (q) => q.eq("externalId", expiringSession.id))
        .unique();
      if (!session) throw new Error("Test session disappeared");
      await ctx.db.patch(session._id, { expiresAt: Date.now() - 1 });
    });
    expect(await authenticateBrowserSession(t, expiringSession.id, "f".repeat(64))).toBeNull();
  });
});

async function upsertGithubAccount(
  t: ReturnType<typeof convexTest>,
  input: {
    subject: string;
    username: string;
    displayName: string;
    email?: string;
    emailVerified?: boolean;
    role?: "owner" | "admin" | "member" | "viewer";
    projects?: string[];
    workspace?: string;
  },
) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace: input.workspace ?? "test",
    provider: "github",
    subject: input.subject,
    username: input.username,
    displayName: input.displayName,
    email: input.email,
    emailVerified: input.emailVerified ?? true,
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    bootstrapRole: input.role ?? "owner",
    projects: input.projects,
  }) as any;
}

async function createBrowserSession(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  input: {
    id: string;
    secretHash: string;
    userAgent?: string;
    workspace?: string;
  },
) {
  return await t.mutation(convexApi.accounts.createSession, {
    serviceSecret,
    workspace: input.workspace ?? "test",
    accountId,
    id: input.id,
    secretHash: input.secretHash,
    expiresAt: Date.now() + 60_000,
    userAgent: input.userAgent,
  }) as any;
}

async function authenticateBrowserSession(
  t: ReturnType<typeof convexTest>,
  id: string,
  secretHash: string,
) {
  return await t.query(convexApi.accounts.authenticateSession, {
    serviceSecret,
    workspace: "test",
    id,
    secretHash,
  }) as any;
}
