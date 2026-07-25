import { v, type GenericId } from "convex/values";
import {
  assertOptionalText,
  assertText,
  ensureWorkspace,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type MutationContext,
  type QueryContext,
  type WorkspaceId,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const accountRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("viewer"),
);

type AccountRole = "owner" | "admin" | "member" | "viewer";
type AccountScope = "read" | "write" | "admin";
type AccountId = GenericId<"accounts">;

const MAX_SESSION_SECONDS = 60 * 60 * 24 * 90;

export const upsertProviderIdentity = mutation({
  args: {
    ...serviceArgs,
    provider: v.string(),
    subject: v.string(),
    username: v.optional(v.string()),
    displayName: v.string(),
    email: v.optional(v.string()),
    emailVerified: v.boolean(),
    avatarUrl: v.optional(v.string()),
    bootstrapRole: accountRole,
    projects: v.optional(v.array(v.string())),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await ensureWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Failed to create workspace");

    const provider = normalizeProvider(args.provider);
    const subject = assertText(args.subject, "Provider subject", 240);
    const displayName = assertText(args.displayName, "Display name", 160);
    const username = assertOptionalText(args.username, "Provider username", 160);
    const email = normalizeEmail(args.email);
    const emailVerified = email !== undefined && args.emailVerified;
    const avatarUrl = normalizeUrl(args.avatarUrl, "Avatar URL");
    const projects = normalizeProjects(args.projects);
    const now = Date.now();

    const existingIdentity = await ctx.db
      .query("accountIdentities")
      .withIndex("by_provider_subject", (q) =>
        q.eq("provider", provider).eq("subject", subject),
      )
      .unique();

    if (existingIdentity) {
      const account = await ctx.db.get("accounts", existingIdentity.accountId);
      if (!account || account.disabledAt !== undefined) {
        throw new Error("Account is unavailable");
      }

      const identityPatch = {
        username,
        email,
        emailVerified,
        avatarUrl,
        updatedAt: now,
      };
      await ctx.db.patch(existingIdentity._id, identityPatch);

      const accountPatch: {
        displayName: string;
        updatedAt: number;
        primaryEmail?: string;
        avatarUrl?: string;
      } = { displayName, updatedAt: now };
      if (emailVerified && email !== undefined) accountPatch.primaryEmail = email;
      if (avatarUrl !== undefined) accountPatch.avatarUrl = avatarUrl;
      await ctx.db.patch(account._id, accountPatch);

      const membership = await ensureActiveMembership(ctx, {
        workspaceId: workspace._id,
        accountId: account._id,
        role: args.bootstrapRole,
        projects,
        now,
      });
      return publicAccountContext(
        { ...account, ...accountPatch },
        { ...existingIdentity, ...identityPatch },
        membership,
        workspace.slug,
      );
    }

    const accountId = await ctx.db.insert("accounts", {
      externalId: "pending",
      displayName,
      primaryEmail: emailVerified ? email : undefined,
      avatarUrl,
      createdAt: now,
      updatedAt: now,
    });
    const accountExternalId = `acct_${accountId}`;
    await ctx.db.patch(accountId, { externalId: accountExternalId });

    const identityId = await ctx.db.insert("accountIdentities", {
      accountId,
      provider,
      subject,
      username,
      email,
      emailVerified,
      avatarUrl,
      createdAt: now,
      updatedAt: now,
    });

    const membership = await ensureActiveMembership(ctx, {
      workspaceId: workspace._id,
      accountId,
      role: args.bootstrapRole,
      projects,
      now,
    });
    const account = await ctx.db.get("accounts", accountId);
    const identity = await ctx.db.get("accountIdentities", identityId);
    if (!account || !identity) throw new Error("Created account disappeared");
    return publicAccountContext(account, identity, membership, workspace.slug);
  },
});

export const createSession = mutation({
  args: {
    ...serviceArgs,
    accountId: v.string(),
    id: v.string(),
    secretHash: v.string(),
    expiresAt: v.number(),
    userAgent: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const accountContext = await findActiveAccountMembership(ctx, args.workspace, args.accountId);
    if (!accountContext) throw new Error("Account membership is unavailable");

    const externalId = assertText(args.id, "Session id", 120);
    const existing = await ctx.db
      .query("browserSessions")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (existing) throw new Error(`Session ${externalId} already exists`);

    const now = Date.now();
    const expiresAt = assertSessionExpiry(args.expiresAt, now);
    const sessionId = await ctx.db.insert("browserSessions", {
      accountId: accountContext.account._id,
      externalId,
      secretHash: assertHash(args.secretHash),
      userAgent: assertOptionalText(args.userAgent, "User agent", 500),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    });
    const session = await ctx.db.get("browserSessions", sessionId);
    if (!session) throw new Error("Created session disappeared");
    return publicSession(session);
  },
});

export const authenticateSession = query({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const sessionContext = await findActiveSessionContext(
      ctx,
      args.workspace,
      args.id,
      args.secretHash,
    );
    if (!sessionContext) return null;

    const scopes = scopesForRole(sessionContext.membership.role);
    return {
      session: publicSession(sessionContext.session),
      account: publicAccount(sessionContext.account),
      membership: publicMembership(sessionContext.membership, sessionContext.workspace.slug),
      principal: {
        type: "account",
        accountId: sessionContext.account.externalId,
        name: sessionContext.account.displayName,
        workspace: sessionContext.workspace.slug,
        role: sessionContext.membership.role,
        scopes,
        projects: sessionContext.membership.projects ?? null,
      },
      capabilities: {
        read: scopes.includes("read"),
        write: scopes.includes("write"),
        admin: scopes.includes("admin"),
      },
    };
  },
});

export const touchSession = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const sessionContext = await findActiveSessionContext(
      ctx,
      args.workspace,
      args.id,
      args.secretHash,
    );
    if (!sessionContext) return null;
    const lastSeenAt = Date.now();
    await ctx.db.patch(sessionContext.session._id, { lastSeenAt });
    return publicSession({ ...sessionContext.session, lastSeenAt });
  },
});

export const rotateSession = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
    nextSecretHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const sessionContext = await findActiveSessionContext(
      ctx,
      args.workspace,
      args.id,
      args.secretHash,
    );
    if (!sessionContext) return null;
    const now = Date.now();
    const patch = {
      secretHash: assertHash(args.nextSecretHash),
      expiresAt: assertSessionExpiry(args.expiresAt, now),
      lastSeenAt: now,
    };
    await ctx.db.patch(sessionContext.session._id, patch);
    return publicSession({ ...sessionContext.session, ...patch });
  },
});

export const revokeSession = mutation({
  args: {
    ...serviceArgs,
    accountId: v.string(),
    id: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const accountContext = await findActiveAccountMembership(ctx, args.workspace, args.accountId);
    if (!accountContext) return null;
    const externalId = readCredentialId(args.id);
    if (!externalId) return null;

    const session = await ctx.db
      .query("browserSessions")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (!session || session.accountId !== accountContext.account._id) return null;

    const revokedAt = session.revokedAt ?? Date.now();
    if (session.revokedAt === undefined) await ctx.db.patch(session._id, { revokedAt });
    return publicSession({ ...session, revokedAt });
  },
});

export const listSessions = query({
  args: {
    ...serviceArgs,
    accountId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const accountContext = await findActiveAccountMembership(ctx, args.workspace, args.accountId);
    if (!accountContext) return [];
    const sessions = await ctx.db
      .query("browserSessions")
      .withIndex("by_account_created", (q) => q.eq("accountId", accountContext.account._id))
      .order("desc")
      .collect();
    return sessions.map(publicSession);
  },
});

export const setDefaultActor = mutation({
  args: {
    ...serviceArgs,
    accountId: v.string(),
    actorId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const accountContext = await findActiveAccountMembership(ctx, args.workspace, args.accountId);
    if (!accountContext) throw new Error("Account membership is unavailable");
    const defaultActorExternalId = assertOptionalText(args.actorId, "Actor id", 120);
    const updatedAt = Date.now();
    await ctx.db.patch(accountContext.account._id, { defaultActorExternalId, updatedAt });
    return publicAccount({ ...accountContext.account, defaultActorExternalId, updatedAt });
  },
});

async function ensureActiveMembership(
  ctx: MutationContext,
  input: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
    role: AccountRole;
    projects: string[] | undefined;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_account_workspace", (q) =>
      q.eq("accountId", input.accountId).eq("workspaceId", input.workspaceId),
    )
    .unique();
  if (existing) {
    if (existing.revokedAt !== undefined) throw new Error("Workspace membership is revoked");
    return existing;
  }
  const id = await ctx.db.insert("workspaceMemberships", {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    role: input.role,
    projects: input.projects,
    createdAt: input.now,
    updatedAt: input.now,
  });
  const membership = await ctx.db.get("workspaceMemberships", id);
  if (!membership) throw new Error("Created membership disappeared");
  return membership;
}

async function findAccount(ctx: QueryContext, externalId: string) {
  return await ctx.db
    .query("accounts")
    .withIndex("by_external_id", (q) =>
      q.eq("externalId", assertText(externalId, "Account id", 120)),
    )
    .unique();
}

async function findActiveAccountMembership(
  ctx: QueryContext,
  workspaceValue: string | undefined,
  accountExternalId: string,
) {
  const account = await findAccount(ctx, accountExternalId);
  if (!account || account.disabledAt !== undefined) return null;
  return await findActiveMembershipForAccount(ctx, workspaceValue, account._id);
}

async function findActiveMembershipForAccount(
  ctx: QueryContext,
  workspaceValue: string | undefined,
  accountId: AccountId,
) {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceValue));
  if (!workspace) return null;
  const account = await ctx.db.get("accounts", accountId);
  if (!account || account.disabledAt !== undefined) return null;
  const membership = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_account_workspace", (q) =>
      q.eq("accountId", account._id).eq("workspaceId", workspace._id),
    )
    .unique();
  if (!membership || membership.revokedAt !== undefined) return null;
  return { account, membership, workspace };
}

async function findActiveSessionContext(
  ctx: QueryContext,
  workspaceValue: string | undefined,
  id: string,
  secretHashValue: string,
) {
  const externalId = readCredentialId(id);
  const secretHash = readHash(secretHashValue);
  if (!externalId || !secretHash) return null;
  const session = await ctx.db
    .query("browserSessions")
    .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
    .unique();
  if (
    !session ||
    session.revokedAt !== undefined ||
    session.expiresAt <= Date.now() ||
    session.secretHash !== secretHash
  ) {
    return null;
  }
  const accountContext = await findActiveMembershipForAccount(
    ctx,
    workspaceValue,
    session.accountId,
  );
  if (!accountContext) return null;
  return { ...accountContext, session };
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized) || normalized.length > 40) {
    throw new Error("Provider must be a lowercase identifier up to 40 characters");
  }
  return normalized;
}

function normalizeEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Email address is invalid");
  }
  return normalized;
}

function normalizeUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = assertText(value, label, 2048);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return parsed.toString();
}

function normalizeProjects(projects: string[] | undefined): string[] | undefined {
  if (projects === undefined) return undefined;
  return [...new Set(projects.map((project) => {
    const normalized = project.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(normalized) || normalized.length > 80) {
      throw new Error("Project must be a lowercase slug up to 80 characters");
    }
    return normalized;
  }))].sort();
}

function readCredentialId(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) return null;
  return normalized;
}

function assertHash(value: string): string {
  const normalized = readHash(value);
  if (!normalized) throw new Error("Session secret hash must be a SHA-256 hex digest");
  return normalized;
}

function readHash(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function assertSessionExpiry(value: number, now: number): number {
  if (!Number.isFinite(value) || value <= now || value > now + MAX_SESSION_SECONDS * 1000) {
    throw new Error("Session expiry must be in the future and no more than 90 days away");
  }
  return Math.floor(value);
}

function scopesForRole(role: AccountRole): AccountScope[] {
  if (role === "owner" || role === "admin") return ["read", "write", "admin"];
  if (role === "member") return ["read", "write"];
  return ["read"];
}

function publicAccount(account: any) {
  return {
    id: account.externalId,
    displayName: account.displayName,
    primaryEmail: account.primaryEmail ?? null,
    avatarUrl: account.avatarUrl ?? null,
    defaultActorId: account.defaultActorExternalId ?? null,
    createdAt: new Date(account.createdAt).toISOString(),
    updatedAt: new Date(account.updatedAt).toISOString(),
    disabledAt: account.disabledAt === undefined ? null : new Date(account.disabledAt).toISOString(),
  };
}

function publicIdentity(identity: any) {
  return {
    provider: identity.provider,
    subject: identity.subject,
    username: identity.username ?? null,
    email: identity.email ?? null,
    emailVerified: identity.emailVerified,
    avatarUrl: identity.avatarUrl ?? null,
    createdAt: new Date(identity.createdAt).toISOString(),
    updatedAt: new Date(identity.updatedAt).toISOString(),
  };
}

function publicMembership(membership: any, workspace: string) {
  return {
    workspace,
    role: membership.role,
    projects: membership.projects ?? null,
    createdAt: new Date(membership.createdAt).toISOString(),
    updatedAt: new Date(membership.updatedAt).toISOString(),
    revokedAt: membership.revokedAt === undefined ? null : new Date(membership.revokedAt).toISOString(),
  };
}

function publicSession(session: any) {
  return {
    id: session.externalId,
    userAgent: session.userAgent ?? null,
    createdAt: new Date(session.createdAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    revokedAt: session.revokedAt === undefined ? null : new Date(session.revokedAt).toISOString(),
  };
}

function publicAccountContext(account: any, identity: any, membership: any, workspace: string) {
  return {
    account: publicAccount(account),
    identity: publicIdentity(identity),
    membership: publicMembership(membership, workspace),
  };
}
