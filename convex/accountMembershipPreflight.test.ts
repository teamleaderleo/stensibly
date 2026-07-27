import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "membership-preflight-service-secret";
const workspace = "default";
const subject = "13091533";
const inspectRef = makeFunctionReference<"query">(
  "accountMembershipPreflight:inspect",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted account membership preflight", () => {
  test("distinguishes missing workspace and missing identity", async () => {
    const missingWorkspace = await inspect(convexTest(schema, modules));
    expect(missingWorkspace).toEqual({
      version: 1,
      workspace,
      provider: "github",
      subject,
      state: "workspace_absent",
      workspaceFound: false,
      identityFound: false,
      accountAvailable: false,
      accountDisabled: false,
      membership: null,
      containsSecrets: false,
      readOnly: true,
      grantsMembershipChange: false,
    });

    const t = convexTest(schema, modules);
    await insertWorkspace(t, workspace, 1);
    expect(await inspect(t)).toMatchObject({
      state: "identity_absent",
      workspaceFound: true,
      identityFound: false,
      membership: null,
    });
  });

  test("returns only active project-scoped policy fields", async () => {
    const t = convexTest(schema, modules);
    const now = 1_000;
    const workspaceId = await insertWorkspace(t, workspace, now);
    const accountId = await insertIdentity(t, now, {
      displayName: "Secret Display Name",
      primaryEmail: "secret@example.com",
      avatarUrl: "https://example.com/secret-avatar.png",
    });
    await t.run(async (ctx: any) => {
      await ctx.db.insert("workspaceMemberships", {
        workspaceId,
        accountId,
        role: "viewer",
        projects: ["zeta", "oauth-dogfood", "alpha"],
        createdAt: now + 1,
        updatedAt: now + 2,
      });
      await ctx.db.insert("browserSessions", {
        accountId,
        externalId: "session_secret_id",
        secretHash: "a".repeat(64),
        userAgent: "Secret browser",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 100_000,
      });
    });

    const result = await inspect(t, { provider: " GitHub " });
    expect(result).toEqual({
      version: 1,
      workspace,
      provider: "github",
      subject,
      state: "active",
      workspaceFound: true,
      identityFound: true,
      accountAvailable: true,
      accountDisabled: false,
      membership: {
        role: "viewer",
        projects: ["alpha", "oauth-dogfood", "zeta"],
        createdAt: now + 1,
        updatedAt: now + 2,
        revokedAt: null,
      },
      containsSecrets: false,
      readOnly: true,
      grantsMembershipChange: false,
    });

    const serialized = JSON.stringify(result);
    for (const excluded of [
      "Secret Display Name",
      "secret@example.com",
      "secret-avatar",
      "session_secret_id",
      "Secret browser",
      "secretHash",
      "accountId",
    ]) {
      expect(serialized).not.toContain(excluded);
    }
  });

  test("preserves workspace-wide, revoked, and disabled states", async () => {
    const workspaceWide = convexTest(schema, modules);
    const workspaceId = await insertWorkspace(workspaceWide, workspace, 2_000);
    const accountId = await insertIdentity(workspaceWide, 2_000);
    await workspaceWide.run(async (ctx: any) => {
      await ctx.db.insert("workspaceMemberships", {
        workspaceId,
        accountId,
        role: "member",
        createdAt: 2_001,
        updatedAt: 2_002,
      });
    });
    expect(await inspect(workspaceWide)).toMatchObject({
      state: "active",
      membership: { role: "member", projects: null, revokedAt: null },
    });

    const revoked = convexTest(schema, modules);
    const revokedWorkspaceId = await insertWorkspace(revoked, workspace, 3_000);
    const revokedAccountId = await insertIdentity(revoked, 3_000);
    await revoked.run(async (ctx: any) => {
      await ctx.db.insert("workspaceMemberships", {
        workspaceId: revokedWorkspaceId,
        accountId: revokedAccountId,
        role: "viewer",
        projects: ["oauth-dogfood"],
        createdAt: 3_001,
        updatedAt: 3_002,
        revokedAt: 3_003,
      });
    });
    expect(await inspect(revoked)).toMatchObject({
      state: "revoked",
      accountAvailable: true,
      membership: {
        role: "viewer",
        projects: ["oauth-dogfood"],
        revokedAt: 3_003,
      },
    });

    const disabled = convexTest(schema, modules);
    await insertWorkspace(disabled, workspace, 4_000);
    await insertIdentity(disabled, 4_000, { disabledAt: 4_001 });
    expect(await inspect(disabled)).toMatchObject({
      state: "account_unavailable",
      identityFound: true,
      accountAvailable: false,
      accountDisabled: true,
      membership: null,
    });
  });

  test("does not confuse another workspace membership with the target workspace", async () => {
    const t = convexTest(schema, modules);
    await insertWorkspace(t, workspace, 5_000);
    const otherWorkspaceId = await insertWorkspace(t, "other-workspace", 5_000);
    const accountId = await insertIdentity(t, 5_000);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("workspaceMemberships", {
        workspaceId: otherWorkspaceId,
        accountId,
        role: "owner",
        createdAt: 5_001,
        updatedAt: 5_001,
      });
    });

    expect(await inspect(t)).toMatchObject({
      state: "membership_absent",
      workspaceFound: true,
      identityFound: true,
      accountAvailable: true,
      membership: null,
    });
  });

  test("rejects malformed input and the wrong service secret", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(inspectRef, {
      serviceSecret: "wrong-secret",
      workspace,
      provider: "github",
      subject,
    })).rejects.toThrow();
    await expect(inspect(t, { provider: "git/hub" })).rejects.toThrow(
      "Provider must be a lowercase identifier",
    );
    await expect(inspect(t, { subject: "bad\u0000subject" })).rejects.toThrow();
    await expect(inspect(t, { workspace: "Bad Workspace" })).rejects.toThrow();
  });

  test("replays deterministically without changing database state", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await insertWorkspace(t, workspace, 6_000);
    const accountId = await insertIdentity(t, 6_000);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("workspaceMemberships", {
        workspaceId,
        accountId,
        role: "viewer",
        projects: ["oauth-dogfood"],
        createdAt: 6_001,
        updatedAt: 6_001,
      });
    });

    const before = await tableCounts(t);
    const first = await inspect(t);
    const second = await inspect(t);
    expect(second).toEqual(first);
    expect(await tableCounts(t)).toEqual(before);
    expect(Object.keys(first).sort()).toEqual([
      "accountAvailable",
      "accountDisabled",
      "containsSecrets",
      "grantsMembershipChange",
      "identityFound",
      "membership",
      "provider",
      "readOnly",
      "state",
      "subject",
      "version",
      "workspace",
      "workspaceFound",
    ]);
  });
});

async function inspect(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    workspace: string;
    provider: string;
    subject: string;
  }> = {},
) {
  return await t.query(inspectRef, {
    serviceSecret,
    workspace: overrides.workspace ?? workspace,
    provider: overrides.provider ?? "github",
    subject: overrides.subject ?? subject,
  });
}

async function insertWorkspace(
  t: ReturnType<typeof convexTest>,
  slug: string,
  now: number,
) {
  return await t.run(async (ctx: any) => await ctx.db.insert("workspaces", {
    externalId: `workspace_${slug}`,
    slug,
    name: `Workspace ${slug}`,
    createdAt: now,
    updatedAt: now,
  }));
}

async function insertIdentity(
  t: ReturnType<typeof convexTest>,
  now: number,
  accountFields: Record<string, unknown> = {},
) {
  return await t.run(async (ctx: any) => {
    const accountId = await ctx.db.insert("accounts", {
      externalId: `acct_${now}`,
      displayName: "Preflight account",
      createdAt: now,
      updatedAt: now,
      ...accountFields,
    });
    await ctx.db.insert("accountIdentities", {
      accountId,
      provider: "github",
      subject,
      username: "private-user",
      email: "private@example.com",
      emailVerified: true,
      avatarUrl: "https://example.com/private.png",
      createdAt: now,
      updatedAt: now,
    });
    return accountId;
  });
}

async function tableCounts(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: any) => ({
    workspaces: (await ctx.db.query("workspaces").collect()).length,
    accounts: (await ctx.db.query("accounts").collect()).length,
    identities: (await ctx.db.query("accountIdentities").collect()).length,
    memberships: (await ctx.db.query("workspaceMemberships").collect()).length,
    sessions: (await ctx.db.query("browserSessions").collect()).length,
    oauthStates: (await ctx.db.query("oauthStates").collect()).length,
  }));
}
