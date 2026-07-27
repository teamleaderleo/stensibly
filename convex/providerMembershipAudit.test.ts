import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "provider-membership-audit-secret";
const auditRef = makeFunctionReference<"query">(
  "providerMembershipAudit:auditProviderMembership",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("provider membership audit", () => {
  test("permits clean bootstrap only when the provider identity is absent", async () => {
    const t = convexTest(schema, modules);
    const result = await audit(t, {
      provider: " GitHub ",
      subject: "provider-subject-secret-13091533",
    });

    expect(result).toEqual({
      version: 1,
      workspace: "test",
      provider: "github",
      status: "identity_absent",
      membership: null,
      cleanBootstrapEligible: true,
      requiresSeparateMembershipPlan: false,
      containsSecrets: false,
      readOnly: true,
      grantsMembershipChange: false,
      grantsMembership: false,
      grantsLogin: false,
      grantsOAuthEnablement: false,
    });
    expect(JSON.stringify(result)).not.toContain("provider-subject-secret-13091533");
  });

  test("returns one bounded active membership without provider profile data", async () => {
    const t = convexTest(schema, modules);
    await upsertGithubAccount(t, {
      subject: "13091533",
      role: "member",
      projects: ["alpha", "oauth-dogfood"],
    });

    const result = await audit(t);
    expect(result).toMatchObject({
      status: "membership_active",
      cleanBootstrapEligible: false,
      requiresSeparateMembershipPlan: true,
      readOnly: true,
      grantsMembershipChange: false,
      membership: {
        role: "member",
        projectScope: "bounded",
        projects: ["alpha", "oauth-dogfood"],
        projectCount: 2,
        revocationState: "active",
        revokedAt: null,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("teamleaderleo");
    expect(serialized).not.toContain("leo@example.com");
    expect(serialized).not.toContain("acct_");
  });

  test("distinguishes revoked membership and disabled account states", async () => {
    const revokedTest = convexTest(schema, modules);
    await upsertGithubAccount(revokedTest, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    const revokedAt = Date.parse("2026-07-27T17:45:00.000Z");
    await revokedTest.run(async (ctx: any) => {
      const membership = await membershipFor(ctx, "github", "13091533", "test");
      if (!membership) throw new Error("Test membership disappeared");
      await ctx.db.patch(membership._id, { revokedAt });
    });

    expect(await audit(revokedTest)).toMatchObject({
      status: "membership_revoked",
      membership: {
        role: "viewer",
        projects: ["oauth-dogfood"],
        revocationState: "revoked",
        revokedAt: "2026-07-27T17:45:00.000Z",
      },
      cleanBootstrapEligible: false,
      requiresSeparateMembershipPlan: true,
    });

    const disabledTest = convexTest(schema, modules);
    await upsertGithubAccount(disabledTest, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    await disabledTest.run(async (ctx: any) => {
      const identity = await identityFor(ctx, "github", "13091533");
      if (!identity) throw new Error("Test identity disappeared");
      await ctx.db.patch(identity.accountId, { disabledAt: revokedAt });
    });

    expect(await audit(disabledTest)).toMatchObject({
      status: "account_disabled",
      membership: null,
      cleanBootstrapEligible: false,
      requiresSeparateMembershipPlan: true,
    });
  });

  test("fails closed when a stored revocation timestamp is uninspectable", async () => {
    const t = convexTest(schema, modules);
    await upsertGithubAccount(t, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    await t.run(async (ctx: any) => {
      const membership = await membershipFor(ctx, "github", "13091533", "test");
      if (!membership) throw new Error("Test membership disappeared");
      await ctx.db.patch(membership._id, { revokedAt: -1 });
    });

    expect(await audit(t)).toMatchObject({
      status: "membership_uninspectable",
      membership: {
        role: "viewer",
        projects: ["oauth-dogfood"],
        revocationState: "uninspectable",
        revokedAt: null,
      },
      cleanBootstrapEligible: false,
      requiresSeparateMembershipPlan: true,
    });
  });

  test("fails closed for workspace, membership, identity, and membership conflicts", async () => {
    const workspaceMissing = convexTest(schema, modules);
    await upsertGithubAccount(workspaceMissing, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    expect(await audit(workspaceMissing, { workspace: "other" })).toMatchObject({
      status: "workspace_absent",
      cleanBootstrapEligible: false,
    });

    const membershipMissing = convexTest(schema, modules);
    await upsertGithubAccount(membershipMissing, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    await membershipMissing.run(async (ctx: any) => {
      await ctx.db.insert("workspaces", {
        externalId: "ws_other",
        slug: "other",
        name: "other",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    expect(await audit(membershipMissing, { workspace: "other" })).toMatchObject({
      status: "membership_absent",
      cleanBootstrapEligible: false,
    });

    const identityConflict = convexTest(schema, modules);
    await upsertGithubAccount(identityConflict, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    await identityConflict.run(async (ctx: any) => {
      const identity = await identityFor(ctx, "github", "13091533");
      if (!identity) throw new Error("Test identity disappeared");
      await ctx.db.insert("accountIdentities", {
        accountId: identity.accountId,
        provider: "github",
        subject: "13091533",
        emailVerified: false,
        createdAt: 2,
        updatedAt: 2,
      });
    });
    expect(await audit(identityConflict)).toMatchObject({
      status: "identity_conflict",
      membership: null,
    });

    const membershipConflict = convexTest(schema, modules);
    await upsertGithubAccount(membershipConflict, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    await membershipConflict.run(async (ctx: any) => {
      const identity = await identityFor(ctx, "github", "13091533");
      const workspace = await workspaceFor(ctx, "test");
      if (!identity || !workspace) throw new Error("Test context disappeared");
      await ctx.db.insert("workspaceMemberships", {
        workspaceId: workspace._id,
        accountId: identity.accountId,
        role: "owner",
        projects: ["other"],
        createdAt: 3,
        updatedAt: 3,
      });
    });
    expect(await audit(membershipConflict)).toMatchObject({
      status: "membership_conflict",
      membership: null,
    });
  });

  test("does not echo oversized or noncanonical project scope", async () => {
    const oversized = convexTest(schema, modules);
    await upsertGithubAccount(oversized, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    const oversizedProjects = Array.from(
      { length: 101 },
      (_, index) => `project-${String(index).padStart(3, "0")}`,
    );
    await oversized.run(async (ctx: any) => {
      const membership = await membershipFor(ctx, "github", "13091533", "test");
      if (!membership) throw new Error("Test membership disappeared");
      await ctx.db.patch(membership._id, { projects: oversizedProjects });
    });

    const oversizedResult = await audit(oversized);
    expect(oversizedResult).toMatchObject({
      status: "membership_uninspectable",
      membership: {
        role: "viewer",
        projectScope: "uninspectable",
        projects: null,
        projectCount: 101,
      },
      cleanBootstrapEligible: false,
      requiresSeparateMembershipPlan: true,
    });
    expect(JSON.stringify(oversizedResult)).not.toContain("project-100");

    const noncanonical = convexTest(schema, modules);
    await upsertGithubAccount(noncanonical, {
      subject: "13091533",
      role: "viewer",
      projects: ["oauth-dogfood"],
    });
    await noncanonical.run(async (ctx: any) => {
      const membership = await membershipFor(ctx, "github", "13091533", "test");
      if (!membership) throw new Error("Test membership disappeared");
      await ctx.db.patch(membership._id, { projects: ["Zeta", "alpha"] });
    });
    expect(await audit(noncanonical)).toMatchObject({
      status: "membership_uninspectable",
      membership: {
        projectScope: "uninspectable",
        projects: null,
        projectCount: 2,
      },
    });
  });

  test("requires service authentication and bounded provider identity input", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(auditRef, {
      serviceSecret: "wrong-secret",
      workspace: "test",
      provider: "github",
      subject: "13091533",
    })).rejects.toThrow("Unauthorized");

    await expect(audit(t, { provider: "github.com" })).rejects.toThrow(
      "Provider must be a lowercase identifier",
    );
    await expect(audit(t, { subject: " ".repeat(2) })).rejects.toThrow(
      "Provider subject must be between 1 and 240 characters",
    );
  });
});

async function audit(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    workspace: string;
    provider: string;
    subject: string;
  }> = {},
) {
  return await t.query(auditRef, {
    serviceSecret,
    workspace: overrides.workspace ?? "test",
    provider: overrides.provider ?? "github",
    subject: overrides.subject ?? "13091533",
  }) as any;
}

async function upsertGithubAccount(
  t: ReturnType<typeof convexTest>,
  input: {
    subject: string;
    role: "owner" | "admin" | "member" | "viewer";
    projects?: string[];
  },
) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace: "test",
    provider: "github",
    subject: input.subject,
    username: "teamleaderleo",
    displayName: "Leo",
    email: "leo@example.com",
    emailVerified: true,
    bootstrapRole: input.role,
    projects: input.projects,
  }) as any;
}

async function identityFor(ctx: any, provider: string, subject: string) {
  return await ctx.db
    .query("accountIdentities")
    .withIndex("by_provider_subject", (q: any) =>
      q.eq("provider", provider).eq("subject", subject),
    )
    .first();
}

async function workspaceFor(ctx: any, workspace: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q: any) => q.eq("slug", workspace))
    .first();
}

async function membershipFor(
  ctx: any,
  provider: string,
  subject: string,
  workspaceSlug: string,
) {
  const identity = await identityFor(ctx, provider, subject);
  const workspace = await workspaceFor(ctx, workspaceSlug);
  if (!identity || !workspace) return null;
  return await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_account_workspace", (q: any) =>
      q.eq("accountId", identity.accountId).eq("workspaceId", workspace._id),
    )
    .first();
}
