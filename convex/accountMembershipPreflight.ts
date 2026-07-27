import { v } from "convex/values";
import { accountRole } from "./schema";
import {
  assertText,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const MAX_PROJECTS = 32;
const MAX_PROJECTS_BYTES = 2048;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const UNSAFE_SUBJECT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const nullableProjects = v.union(v.array(v.string()), v.null());
const nullableTimestamp = v.union(v.number(), v.null());

const membershipState = v.union(
  v.literal("workspace_absent"),
  v.literal("identity_absent"),
  v.literal("account_unavailable"),
  v.literal("membership_absent"),
  v.literal("membership_malformed"),
  v.literal("active"),
  v.literal("revoked"),
);

const membershipPolicy = v.object({
  role: accountRole,
  projects: nullableProjects,
  createdAt: v.number(),
  updatedAt: v.number(),
  revokedAt: nullableTimestamp,
});

const preflightResult = v.object({
  version: v.literal(1),
  workspace: v.string(),
  provider: v.string(),
  subject: v.string(),
  state: membershipState,
  workspaceFound: v.boolean(),
  identityFound: v.boolean(),
  accountAvailable: v.boolean(),
  accountDisabled: v.boolean(),
  membership: v.union(membershipPolicy, v.null()),
  containsSecrets: v.literal(false),
  readOnly: v.literal(true),
  grantsMembershipChange: v.literal(false),
});

type State =
  | "workspace_absent"
  | "identity_absent"
  | "account_unavailable"
  | "membership_absent"
  | "membership_malformed"
  | "active"
  | "revoked";

/**
 * Inspects whether one provider subject already has a membership in one workspace.
 *
 * This is a service-authenticated point-read used before first-login bootstrap
 * configuration. It creates no account, identity, membership, session, OAuth
 * state, or scheduled work, and omits account/profile/session/provider metadata.
 */
export const inspect = query({
  args: {
    ...serviceArgs,
    provider: v.string(),
    subject: v.string(),
  },
  returns: preflightResult,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const provider = normalizeProvider(args.provider);
    const subject = normalizeSubject(args.subject);

    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) {
      return result({
        workspace: workspaceSlug,
        provider,
        subject,
        state: "workspace_absent",
        workspaceFound: false,
      });
    }

    const identity = await ctx.db
      .query("accountIdentities")
      .withIndex("by_provider_subject", (q) =>
        q.eq("provider", provider).eq("subject", subject),
      )
      .unique();
    if (!identity) {
      return result({
        workspace: workspaceSlug,
        provider,
        subject,
        state: "identity_absent",
        workspaceFound: true,
      });
    }

    const account = await ctx.db.get("accounts", identity.accountId);
    if (!account || account.disabledAt !== undefined) {
      return result({
        workspace: workspaceSlug,
        provider,
        subject,
        state: "account_unavailable",
        workspaceFound: true,
        identityFound: true,
        accountDisabled: account?.disabledAt !== undefined,
      });
    }

    const membership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_account_workspace", (q) =>
        q.eq("accountId", account._id).eq("workspaceId", workspace._id),
      )
      .unique();
    if (!membership) {
      return result({
        workspace: workspaceSlug,
        provider,
        subject,
        state: "membership_absent",
        workspaceFound: true,
        identityFound: true,
        accountAvailable: true,
      });
    }

    const projects = canonicalMembershipProjects(membership.projects);
    if (projects === undefined) {
      return result({
        workspace: workspaceSlug,
        provider,
        subject,
        state: "membership_malformed",
        workspaceFound: true,
        identityFound: true,
        accountAvailable: true,
      });
    }

    return result({
      workspace: workspaceSlug,
      provider,
      subject,
      state: membership.revokedAt === undefined ? "active" : "revoked",
      workspaceFound: true,
      identityFound: true,
      accountAvailable: true,
      membership: {
        role: membership.role,
        projects,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
        revokedAt: membership.revokedAt ?? null,
      },
    });
  },
});

function result(input: {
  workspace: string;
  provider: string;
  subject: string;
  state: State;
  workspaceFound: boolean;
  identityFound?: boolean;
  accountAvailable?: boolean;
  accountDisabled?: boolean;
  membership?: {
    role: "owner" | "admin" | "member" | "viewer";
    projects: string[] | null;
    createdAt: number;
    updatedAt: number;
    revokedAt: number | null;
  } | null;
}) {
  return {
    version: 1 as const,
    workspace: input.workspace,
    provider: input.provider,
    subject: input.subject,
    state: input.state,
    workspaceFound: input.workspaceFound,
    identityFound: input.identityFound ?? false,
    accountAvailable: input.accountAvailable ?? false,
    accountDisabled: input.accountDisabled ?? false,
    membership: input.membership ?? null,
    containsSecrets: false as const,
    readOnly: true as const,
    grantsMembershipChange: false as const,
  };
}

function canonicalMembershipProjects(value: string[] | undefined): string[] | null | undefined {
  if (value === undefined) return null;
  if (value.length > MAX_PROJECTS) return undefined;
  const seen = new Set<string>();
  let bytes = Math.max(0, value.length - 1);
  for (const project of value) {
    if (!PROJECT_PATTERN.test(project) || seen.has(project)) return undefined;
    bytes += new TextEncoder().encode(project).byteLength;
    if (bytes > MAX_PROJECTS_BYTES) return undefined;
    seen.add(project);
  }
  return [...seen].sort(compareCodePoints);
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized) || normalized.length > 40) {
    throw new Error("Provider must be a lowercase identifier up to 40 characters");
  }
  return normalized;
}

function normalizeSubject(value: string): string {
  const normalized = assertText(value, "Provider subject", 240);
  if (UNSAFE_SUBJECT_PATTERN.test(normalized)) {
    throw new Error("Provider subject contains unsupported control characters");
  }
  return normalized;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
