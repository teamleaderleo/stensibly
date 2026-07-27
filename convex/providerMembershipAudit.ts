import { v, type Infer } from "convex/values";
import { assertText, normalizeWorkspace, requireServiceSecret } from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";
import { accountRole } from "./schema";

const auditStatus = v.union(
  v.literal("identity_absent"),
  v.literal("identity_conflict"),
  v.literal("account_missing"),
  v.literal("account_disabled"),
  v.literal("workspace_absent"),
  v.literal("workspace_conflict"),
  v.literal("membership_absent"),
  v.literal("membership_conflict"),
  v.literal("membership_active"),
  v.literal("membership_revoked"),
  v.literal("membership_uninspectable"),
);

const projectScope = v.union(
  v.literal("all"),
  v.literal("bounded"),
  v.literal("uninspectable"),
);

const revocationState = v.union(
  v.literal("active"),
  v.literal("revoked"),
  v.literal("uninspectable"),
);

const nullableString = v.union(v.string(), v.null());
const nullableProjects = v.union(v.array(v.string()), v.null());
const membershipAuditDetail = v.object({
  role: accountRole,
  projectScope,
  projects: nullableProjects,
  projectCount: v.number(),
  revocationState,
  revokedAt: nullableString,
});

const providerMembershipAuditResult = v.object({
  version: v.literal(1),
  workspace: v.string(),
  provider: v.string(),
  status: auditStatus,
  membership: v.union(v.null(), membershipAuditDetail),
  cleanBootstrapEligible: v.boolean(),
  requiresSeparateMembershipPlan: v.boolean(),
  containsSecrets: v.literal(false),
  readOnly: v.literal(true),
  grantsMembershipChange: v.literal(false),
  grantsMembership: v.literal(false),
  grantsLogin: v.literal(false),
  grantsOAuthEnablement: v.literal(false),
});

type AccountRole = Infer<typeof accountRole>;
type AuditStatus = Infer<typeof auditStatus>;
type MembershipDetail = Infer<typeof membershipAuditDetail>;

const MAX_AUDIT_PROJECTS = 100;
const MAX_PROJECT_LENGTH = 80;
const MAX_PROVIDER_LENGTH = 40;
const MAX_SUBJECT_LENGTH = 240;
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Inspects whether one provider subject already resolves to an account membership
 * in one workspace before first-login bootstrap policy is consumed.
 *
 * The query is read-only and content-minimised. It never returns the provider
 * subject, account or identity IDs, profile fields, email, avatar, session data,
 * credentials, or provider payloads. Only an absent identity in a non-conflicting
 * workspace is eligible for clean first-login bootstrap. Every existing,
 * conflicting, disabled, missing, revoked, or uninspectable path requires a
 * separately reviewed membership plan.
 */
export const auditProviderMembership = query({
  args: {
    ...serviceArgs,
    provider: v.string(),
    subject: v.string(),
  },
  returns: providerMembershipAuditResult,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = normalizeWorkspace(args.workspace);
    const provider = normalizeProvider(args.provider);
    const subject = assertText(args.subject, "Provider subject", MAX_SUBJECT_LENGTH);

    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", workspace))
      .take(2);
    if (workspaces.length > 1) {
      return result(workspace, provider, "workspace_conflict", null);
    }
    const workspaceDocument = workspaces[0] ?? null;

    const identities = await ctx.db
      .query("accountIdentities")
      .withIndex("by_provider_subject", (q) =>
        q.eq("provider", provider).eq("subject", subject),
      )
      .take(2);

    if (identities.length === 0) {
      return result(workspace, provider, "identity_absent", null);
    }
    if (identities.length > 1) {
      return result(workspace, provider, "identity_conflict", null);
    }

    const identity = identities[0];
    if (!identity) return result(workspace, provider, "identity_conflict", null);
    const account = await ctx.db.get("accounts", identity.accountId);
    if (!account) return result(workspace, provider, "account_missing", null);
    if (account.disabledAt !== undefined) {
      return result(workspace, provider, "account_disabled", null);
    }

    if (!workspaceDocument) {
      return result(workspace, provider, "workspace_absent", null);
    }
    const memberships = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_account_workspace", (q) =>
        q.eq("accountId", account._id).eq("workspaceId", workspaceDocument._id),
      )
      .take(2);
    if (memberships.length === 0) {
      return result(workspace, provider, "membership_absent", null);
    }
    if (memberships.length > 1) {
      return result(workspace, provider, "membership_conflict", null);
    }

    const membership = memberships[0];
    if (!membership) {
      return result(workspace, provider, "membership_conflict", null);
    }
    const detail = inspectMembership(
      membership.role,
      membership.projects,
      membership.revokedAt,
    );
    if (
      detail.projectScope === "uninspectable"
      || detail.revocationState === "uninspectable"
    ) {
      return result(workspace, provider, "membership_uninspectable", detail);
    }
    return result(
      workspace,
      provider,
      detail.revocationState === "revoked"
        ? "membership_revoked"
        : "membership_active",
      detail,
    );
  },
});

function result(
  workspace: string,
  provider: string,
  status: AuditStatus,
  membership: MembershipDetail | null,
) {
  const cleanBootstrapEligible = status === "identity_absent";
  return {
    version: 1 as const,
    workspace,
    provider,
    status,
    membership,
    cleanBootstrapEligible,
    requiresSeparateMembershipPlan: !cleanBootstrapEligible,
    containsSecrets: false as const,
    readOnly: true as const,
    grantsMembershipChange: false as const,
    grantsMembership: false as const,
    grantsLogin: false as const,
    grantsOAuthEnablement: false as const,
  };
}

function inspectMembership(
  role: AccountRole,
  projects: string[] | undefined,
  revokedAtValue: number | undefined,
): MembershipDetail {
  const revokedAt = canonicalStoredTimestamp(revokedAtValue);
  const revocation = revokedAtValue === undefined
    ? { revocationState: "active" as const, revokedAt: null }
    : revokedAt === null
    ? { revocationState: "uninspectable" as const, revokedAt: null }
    : { revocationState: "revoked" as const, revokedAt };

  if (projects === undefined) {
    return {
      role,
      projectScope: "all",
      projects: null,
      projectCount: 0,
      ...revocation,
    };
  }

  if (projects.length > MAX_AUDIT_PROJECTS) {
    return {
      role,
      projectScope: "uninspectable",
      projects: null,
      projectCount: projects.length,
      ...revocation,
    };
  }

  const normalized: string[] = [];
  for (const project of projects) {
    if (typeof project !== "string") {
      return uninspectableProjectScope(role, projects.length, revocation);
    }
    const canonical = project.trim().toLowerCase();
    if (
      canonical !== project
      || canonical.length > MAX_PROJECT_LENGTH
      || !projectPattern.test(canonical)
    ) {
      return uninspectableProjectScope(role, projects.length, revocation);
    }
    normalized.push(canonical);
  }

  const canonicalProjects = [...new Set(normalized)].sort(compareCodePoints);
  if (
    canonicalProjects.length !== projects.length
    || canonicalProjects.some((project, index) => project !== projects[index])
  ) {
    return uninspectableProjectScope(role, projects.length, revocation);
  }

  return {
    role,
    projectScope: "bounded",
    projects: canonicalProjects,
    projectCount: canonicalProjects.length,
    ...revocation,
  };
}

function uninspectableProjectScope(
  role: AccountRole,
  projectCount: number,
  revocation: Pick<MembershipDetail, "revocationState" | "revokedAt">,
): MembershipDetail {
  return {
    role,
    projectScope: "uninspectable",
    projects: null,
    projectCount,
    ...revocation,
  };
}

function canonicalStoredTimestamp(value: number | undefined): string | null {
  if (
    value === undefined
    || !Number.isFinite(value)
    || value < 0
    || value > 8_640_000_000_000_000
  ) {
    return null;
  }
  try {
    return new Date(Math.floor(value)).toISOString();
  } catch {
    return null;
  }
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)
    || normalized.length > MAX_PROVIDER_LENGTH
  ) {
    throw new Error(
      `Provider must be a lowercase identifier up to ${MAX_PROVIDER_LENGTH} characters`,
    );
  }
  return normalized;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
