import { makeFunctionReference } from "convex/server";
import { v, type GenericId, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  assertText,
  ensureWorkspace,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type MutationContext,
  type QueryContext,
} from "./lib/domain";
import { internalMutation, mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";
import { accountRole } from "./schema";

const oauthScope = v.union(
  v.literal("read"),
  v.literal("write"),
  v.literal("offline_access"),
);
const tokenEndpointAuthMethod = v.literal("none");
const nullableProjects = v.union(v.array(v.string()), v.null());
const publicClientValidator = v.object({
  clientId: v.string(),
  clientName: v.string(),
  redirectUris: v.array(v.string()),
  tokenEndpointAuthMethod,
  grantTypes: v.array(v.string()),
  responseTypes: v.array(v.string()),
  createdAt: v.string(),
});
const grantValidator = v.object({
  clientId: v.string(),
  resource: v.string(),
  scopes: v.array(oauthScope),
  principal: v.object({
    accountId: v.string(),
    name: v.string(),
    workspace: v.string(),
    role: accountRole,
    scopes: v.array(v.union(v.literal("read"), v.literal("write"), v.literal("admin"))),
    projects: nullableProjects,
  }),
});
const refreshExchangeValidator = v.union(
  v.object({ status: v.literal("ok"), grant: grantValidator }),
  v.object({ status: v.literal("invalid") }),
  v.object({ status: v.literal("replayed") }),
);
const refreshCleanupValidator = v.object({
  status: v.union(
    v.literal("missing"),
    v.literal("retained"),
    v.literal("cleaned"),
  ),
  retainedRows: v.number(),
  cleanedRows: v.number(),
  hasMore: v.boolean(),
});

type AccountRole = Infer<typeof accountRole>;
type OAuthScope = Infer<typeof oauthScope>;
type AccountId = GenericId<"accounts">;

const MAX_CLIENT_REDIRECT_URIS = 20;
const MAX_CLIENTS_PER_WORKSPACE = 1_000;
const MAX_CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_REFRESH_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_CLEANUP_BATCH_SIZE = 100;
const cleanupRefreshFamilyRef = makeFunctionReference<"mutation">(
  "mcpOAuth:cleanupRefreshFamilyScheduled",
);

export const registerClient = mutation({
  args: {
    ...serviceArgs,
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod,
    grantTypes: v.array(v.string()),
    responseTypes: v.array(v.string()),
  },
  returns: publicClientValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await ensureWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Failed to create workspace");
    const clientId = assertCredentialId(args.clientId, "client");
    const existing = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (existing) throw new Error(`OAuth client ${clientId} already exists`);
    const clients = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_CLIENTS_PER_WORKSPACE);
    if (clients.length >= MAX_CLIENTS_PER_WORKSPACE) {
      throw new Error("OAuth client registration limit reached for this workspace");
    }
    const now = Date.now();
    const id = await ctx.db.insert("mcpOAuthClients", {
      workspaceId: workspace._id,
      externalId: clientId,
      clientName: assertText(args.clientName, "OAuth client name", 160),
      redirectUris: normalizeRedirectUris(args.redirectUris),
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      grantTypes: normalizeGrantTypes(args.grantTypes),
      responseTypes: normalizeExactSet(args.responseTypes, ["code"], "response types"),
      createdAt: now,
      updatedAt: now,
    });
    const client = await ctx.db.get("mcpOAuthClients", id);
    if (!client) throw new Error("Created OAuth client disappeared");
    return publicClient(client);
  },
});

export const getClient = query({
  args: { ...serviceArgs, clientId: v.string() },
  returns: v.union(publicClientValidator, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const clientId = readCredentialId(args.clientId, "client");
    if (!clientId) return null;
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (!client || client.workspaceId !== workspace._id) return null;
    return publicClient(client);
  },
});

export const createAuthorizationCode = mutation({
  args: {
    ...serviceArgs,
    accountId: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    scopes: v.array(oauthScope),
    resource: v.string(),
    id: v.string(),
    secretHash: v.string(),
    expiresAt: v.number(),
  },
  returns: grantValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Workspace is unavailable");
    const client = await requireClient(ctx, workspace._id, args.clientId);
    const redirectUri = assertRegisteredRedirect(client, args.redirectUri);
    const principal = await requireAccountPrincipal(ctx, workspace._id, workspaceSlug, args.accountId);
    const scopes = requireAuthorisedScopes(args.scopes, principal.scopes);
    if (scopes.includes("offline_access") && !client.grantTypes.includes("refresh_token")) {
      throw new Error("OAuth client is not registered for refresh tokens");
    }
    const externalId = assertCredentialId(args.id, "code");
    const existing = await ctx.db
      .query("mcpOAuthCodes")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (existing) throw new Error(`OAuth code ${externalId} already exists`);
    const now = Date.now();
    await deleteExpiredCodes(ctx, now);
    await ctx.db.insert("mcpOAuthCodes", {
      workspaceId: workspace._id,
      accountId: principal.accountDbId,
      externalId,
      secretHash: assertHash(args.secretHash),
      clientExternalId: client.externalId,
      redirectUri,
      codeChallenge: assertCodeChallenge(args.codeChallenge),
      scopes,
      resource: assertResource(args.resource),
      createdAt: now,
      expiresAt: assertExpiry(args.expiresAt, now, MAX_CODE_LIFETIME_MS, "Authorization code"),
    });
    return grant(client.externalId, args.resource, scopes, principal);
  },
});

export const exchangeAuthorizationCode = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    refreshId: v.string(),
    refreshSecretHash: v.string(),
    refreshExpiresAt: v.number(),
  },
  returns: v.union(grantValidator, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return null;
    const externalId = readCredentialId(args.id, "code");
    const secretHash = readHash(args.secretHash);
    if (!externalId || !secretHash) return null;
    const code = await ctx.db
      .query("mcpOAuthCodes")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    const now = Date.now();
    if (!code || code.workspaceId !== workspace._id || code.expiresAt <= now) {
      if (code && code.expiresAt <= now) await ctx.db.delete(code._id);
      return null;
    }
    if (
      code.secretHash !== secretHash
      || code.clientExternalId !== args.clientId.trim()
      || code.redirectUri !== normalizeRedirectUri(args.redirectUri)
      || code.codeChallenge !== assertCodeChallenge(args.codeChallenge)
    ) {
      await ctx.db.delete(code._id);
      return null;
    }
    const principal = await readAccountPrincipal(ctx, workspace._id, workspaceSlug, code.accountId);
    if (!principal) {
      await ctx.db.delete(code._id);
      return null;
    }
    const allowedScopes = authorisedScopes(code.scopes, principal.scopes);
    if (!allowedScopes) {
      await ctx.db.delete(code._id);
      return null;
    }

    if (allowedScopes.includes("offline_access")) {
      const refreshId = assertCredentialId(args.refreshId, "refresh");
      const existingRefresh = await ctx.db
        .query("mcpOAuthRefreshTokens")
        .withIndex("by_external_id", (q) => q.eq("externalId", refreshId))
        .unique();
      if (existingRefresh) throw new Error(`OAuth refresh token ${refreshId} already exists`);
      const refreshExpiresAt = assertExpiry(
        args.refreshExpiresAt,
        now,
        MAX_REFRESH_LIFETIME_MS,
        "Refresh token",
      );
      const familyExpiresAt = refreshExpiresAt;
      const cleanupScheduleGeneration = 1;
      await ctx.db.insert("mcpOAuthRefreshTokens", {
        workspaceId: workspace._id,
        accountId: code.accountId,
        externalId: refreshId,
        familyExternalId: refreshId,
        familyExpiresAt,
        cleanupScheduledAt: familyExpiresAt,
        cleanupScheduleGeneration,
        secretHash: assertHash(args.refreshSecretHash),
        clientExternalId: code.clientExternalId,
        scopes: allowedScopes,
        resource: code.resource,
        createdAt: now,
        expiresAt: familyExpiresAt,
      });
      await ctx.scheduler.runAt(familyExpiresAt, cleanupRefreshFamilyRef, {
        familyExternalId: refreshId,
        familyExpiresAt,
        scheduleGeneration: cleanupScheduleGeneration,
      });
    }

    await ctx.db.delete(code._id);
    return grant(code.clientExternalId, code.resource, allowedScopes, principal);
  },
});

export const rotateRefreshToken = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
    clientId: v.string(),
    nextId: v.string(),
    nextSecretHash: v.string(),
    nextExpiresAt: v.number(),
  },
  returns: refreshExchangeValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return { status: "invalid" as const };
    const externalId = readCredentialId(args.id, "refresh");
    const secretHash = readHash(args.secretHash);
    if (!externalId || !secretHash) return { status: "invalid" as const };
    const refresh = await ctx.db
      .query("mcpOAuthRefreshTokens")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    const now = Date.now();
    if (!refresh || refresh.workspaceId !== workspace._id || refresh.secretHash !== secretHash) {
      return { status: "invalid" as const };
    }
    const family = await readRefreshFamily(ctx, refresh);
    const familyExpiresAt = family.familyExpiresAt;
    if (family.root) {
      await ensureRefreshFamilyCleanupScheduled(ctx, family.root, familyExpiresAt);
    }
    if (refresh.consumedAt !== undefined || refresh.revokedAt !== undefined) {
      await revokeRefreshFamily(ctx, refresh.familyExternalId, now);
      return { status: "replayed" as const };
    }
    if (
      refresh.expiresAt <= now
      || familyExpiresAt <= now
      || refresh.clientExternalId !== args.clientId.trim()
    ) {
      if (refresh.revokedAt === undefined) await ctx.db.patch(refresh._id, { revokedAt: now });
      return { status: "invalid" as const };
    }
    const principal = await readAccountPrincipal(ctx, workspace._id, workspaceSlug, refresh.accountId);
    if (!principal) {
      await revokeRefreshFamily(ctx, refresh.familyExternalId, now);
      return { status: "invalid" as const };
    }
    const scopes = authorisedScopes(refresh.scopes, principal.scopes);
    if (!scopes) {
      await revokeRefreshFamily(ctx, refresh.familyExternalId, now);
      return { status: "invalid" as const };
    }
    const nextId = assertCredentialId(args.nextId, "refresh");
    const existingNext = await ctx.db
      .query("mcpOAuthRefreshTokens")
      .withIndex("by_external_id", (q) => q.eq("externalId", nextId))
      .unique();
    if (existingNext) throw new Error(`OAuth refresh token ${nextId} already exists`);
    const requestedNextExpiry = assertExpiry(
      args.nextExpiresAt,
      now,
      MAX_REFRESH_LIFETIME_MS,
      "Refresh token",
    );
    await ctx.db.patch(refresh._id, { consumedAt: now, rotatedToExternalId: nextId });
    await ctx.db.insert("mcpOAuthRefreshTokens", {
      workspaceId: workspace._id,
      accountId: refresh.accountId,
      externalId: nextId,
      familyExternalId: refresh.familyExternalId,
      familyExpiresAt,
      secretHash: assertHash(args.nextSecretHash),
      clientExternalId: refresh.clientExternalId,
      scopes,
      resource: refresh.resource,
      createdAt: now,
      expiresAt: Math.min(requestedNextExpiry, familyExpiresAt),
    });
    return {
      status: "ok" as const,
      grant: grant(refresh.clientExternalId, refresh.resource, scopes, principal),
    };
  },
});

export const cleanupRefreshFamilyScheduled = internalMutation({
  args: {
    familyExternalId: v.string(),
    familyExpiresAt: v.number(),
    scheduleGeneration: v.number(),
  },
  returns: refreshCleanupValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const oldestRows = await ctx.db
      .query("mcpOAuthRefreshTokens")
      .withIndex("by_family_created", (q) => q.eq("familyExternalId", args.familyExternalId))
      .order("asc")
      .take(REFRESH_CLEANUP_BATCH_SIZE + 1);
    if (!oldestRows.length) {
      return cleanupResult("missing", 0, 0, false);
    }

    const root = await ctx.db
      .query("mcpOAuthRefreshTokens")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.familyExternalId))
      .unique();
    const validRoot = root
      && root.workspaceId === oldestRows[0].workspaceId
      && root.familyExternalId === args.familyExternalId
      ? root
      : null;
    const canonicalFamilyExpiresAt = validRoot
      ? refreshTokenFamilyExpiry(validRoot)
      : minimumFamilyExpiry(
        args.familyExpiresAt,
        refreshTokenFamilyExpiry(oldestRows[0]),
      );

    let rootForScheduling = validRoot;
    if (
      validRoot
      && validRoot.cleanupScheduledAt === args.familyExpiresAt
      && validRoot.cleanupScheduleGeneration === args.scheduleGeneration
    ) {
      await ctx.db.patch(validRoot._id, { cleanupScheduledAt: undefined });
      rootForScheduling = { ...validRoot, cleanupScheduledAt: undefined };
    }

    if (canonicalFamilyExpiresAt > now) {
      if (rootForScheduling) {
        await ensureRefreshFamilyCleanupScheduled(
          ctx,
          rootForScheduling,
          canonicalFamilyExpiresAt,
        );
      }
      return cleanupResult(
        "retained",
        Math.min(oldestRows.length, REFRESH_CLEANUP_BATCH_SIZE),
        0,
        oldestRows.length > REFRESH_CLEANUP_BATCH_SIZE,
      );
    }

    const rowsToDelete = oldestRows.slice(0, REFRESH_CLEANUP_BATCH_SIZE);
    for (const token of rowsToDelete) await ctx.db.delete(token._id);
    const hasMore = oldestRows.length > REFRESH_CLEANUP_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, cleanupRefreshFamilyRef, {
        familyExternalId: args.familyExternalId,
        familyExpiresAt: canonicalFamilyExpiresAt,
        scheduleGeneration: args.scheduleGeneration,
      });
    }
    return cleanupResult("cleaned", 0, rowsToDelete.length, hasMore);
  },
});

async function requireClient(ctx: QueryContext, workspaceId: GenericId<"workspaces">, value: string) {
  const clientId = assertCredentialId(value, "client");
  const client = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
    .unique();
  if (!client || client.workspaceId !== workspaceId) throw new Error("OAuth client is unavailable");
  return client;
}

async function requireAccountPrincipal(
  ctx: QueryContext,
  workspaceId: GenericId<"workspaces">,
  workspace: string,
  accountExternalId: string,
) {
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_external_id", (q) => q.eq("externalId", accountExternalId.trim()))
    .unique();
  if (!account) throw new Error("Account is unavailable");
  const principal = await readAccountPrincipal(ctx, workspaceId, workspace, account._id);
  if (!principal) throw new Error("Account membership is unavailable");
  return principal;
}

async function readAccountPrincipal(
  ctx: QueryContext,
  workspaceId: GenericId<"workspaces">,
  workspace: string,
  accountId: AccountId,
) {
  const account = await ctx.db.get("accounts", accountId);
  if (!account || account.disabledAt !== undefined) return null;
  const membership = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_account_workspace", (q) => q.eq("accountId", accountId).eq("workspaceId", workspaceId))
    .unique();
  if (!membership || membership.revokedAt !== undefined) return null;
  return {
    accountDbId: account._id,
    accountId: account.externalId,
    name: account.displayName,
    workspace,
    role: membership.role,
    scopes: scopesForRole(membership.role),
    projects: membership.projects ?? null,
  };
}

function grant(
  clientId: string,
  resource: string,
  scopes: OAuthScope[],
  principal: Awaited<ReturnType<typeof requireAccountPrincipal>>,
) {
  return {
    clientId,
    resource: assertResource(resource),
    scopes,
    principal: {
      accountId: principal.accountId,
      name: principal.name,
      workspace: principal.workspace,
      role: principal.role,
      scopes: principal.scopes,
      projects: principal.projects,
    },
  };
}

function requireAuthorisedScopes(
  requested: OAuthScope[],
  accountScopes: readonly string[],
): OAuthScope[] {
  const scopes = authorisedScopes(requested, accountScopes);
  if (!scopes) throw new Error("Account cannot grant the requested OAuth scopes");
  return scopes;
}

function authorisedScopes(
  requested: OAuthScope[],
  accountScopes: readonly string[],
): OAuthScope[] | null {
  const unique = [...new Set(requested)];
  if (!unique.includes("read")) return null;
  if (!accountScopes.includes("read")) return null;
  if (unique.includes("write") && !accountScopes.includes("write")) return null;
  return (["read", "write", "offline_access"] as const).filter((scope) => unique.includes(scope));
}

function scopesForRole(role: AccountRole): ("read" | "write" | "admin")[] {
  if (role === "owner" || role === "admin") return ["read", "write", "admin"];
  if (role === "member") return ["read", "write"];
  return ["read"];
}

function normalizeRedirectUris(values: string[]): string[] {
  if (!values.length || values.length > MAX_CLIENT_REDIRECT_URIS) {
    throw new Error(`OAuth client requires 1-${MAX_CLIENT_REDIRECT_URIS} redirect URIs`);
  }
  return [...new Set(values.map(normalizeRedirectUri))].sort();
}

function normalizeRedirectUri(value: string): string {
  const normalized = assertText(value, "OAuth redirect URI", 2048);
  const parsed = new URL(normalized);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("OAuth redirect URI cannot contain credentials or a fragment");
  }
  const local = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !local) throw new Error("OAuth redirect URI must use HTTPS");
  return parsed.toString();
}

function assertRegisteredRedirect(client: Doc<"mcpOAuthClients">, value: string): string {
  const redirectUri = normalizeRedirectUri(value);
  if (!client.redirectUris.includes(redirectUri)) throw new Error("OAuth redirect URI is not registered");
  return redirectUri;
}

function normalizeGrantTypes(values: string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (
    !normalized.includes("authorization_code")
    || normalized.some((value) => value !== "authorization_code" && value !== "refresh_token")
  ) {
    throw new Error("OAuth grant types are unsupported");
  }
  return ["authorization_code", "refresh_token"].filter((value) => normalized.includes(value));
}

function normalizeExactSet(values: string[], expected: string[], label: string): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  const wanted = [...expected].sort();
  if (normalized.length !== wanted.length || normalized.some((value, index) => value !== wanted[index])) {
    throw new Error(`OAuth ${label} are unsupported`);
  }
  return normalized;
}

function assertCredentialId(value: string, kind: "client" | "code" | "refresh"): string {
  const normalized = readCredentialId(value, kind);
  if (!normalized) throw new Error(`OAuth ${kind} id is invalid`);
  return normalized;
}

function readCredentialId(value: string, kind: "client" | "code" | "refresh"): string | null {
  const prefix = kind === "client" ? "client" : kind === "code" ? "code" : "refresh";
  const normalized = value.trim();
  return new RegExp(`^oauth_${prefix}_[A-Za-z0-9_-]{12,96}$`).test(normalized) ? normalized : null;
}

function assertHash(value: string): string {
  const normalized = readHash(value);
  if (!normalized) throw new Error("OAuth credential hash must be a SHA-256 hex digest");
  return normalized;
}

function readHash(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function assertCodeChallenge(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) throw new Error("OAuth PKCE challenge is invalid");
  return normalized;
}

function assertResource(value: string): string {
  const normalized = assertText(value, "OAuth resource", 2048);
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("OAuth resource must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error("OAuth resource is invalid");
  return parsed.toString();
}

function assertExpiry(value: number, now: number, maximumLifetime: number, label: string): number {
  if (!Number.isFinite(value) || value <= now || value > now + maximumLifetime) {
    throw new Error(`${label} expiry is invalid`);
  }
  return Math.floor(value);
}

async function deleteExpiredCodes(ctx: MutationContext, now: number): Promise<void> {
  const expired = await ctx.db
    .query("mcpOAuthCodes")
    .withIndex("by_expiry", (q) => q.lte("expiresAt", now))
    .take(100);
  for (const code of expired) await ctx.db.delete(code._id);
}

async function readRefreshFamily(
  ctx: MutationContext,
  token: Doc<"mcpOAuthRefreshTokens">,
): Promise<{
  root: Doc<"mcpOAuthRefreshTokens"> | null;
  familyExpiresAt: number;
}> {
  const root = await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_external_id", (q) => q.eq("externalId", token.familyExternalId))
    .unique();
  if (
    root
    && root.workspaceId === token.workspaceId
    && root.familyExternalId === token.familyExternalId
  ) {
    return { root, familyExpiresAt: refreshTokenFamilyExpiry(root) };
  }
  const oldest = await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_family_created", (q) => q.eq("familyExternalId", token.familyExternalId))
    .order("asc")
    .first();
  const fallback = oldest && oldest.workspaceId === token.workspaceId ? oldest : token;
  return { root: null, familyExpiresAt: refreshTokenFamilyExpiry(fallback) };
}

function refreshTokenFamilyExpiry(token: Doc<"mcpOAuthRefreshTokens">): number {
  return minimumFamilyExpiry(
    token.familyExpiresAt,
    token.expiresAt,
    boundedFamilyExpiry(token.createdAt),
  );
}

function boundedFamilyExpiry(createdAt: number): number {
  if (!Number.isFinite(createdAt) || createdAt < 0) return 0;
  const expiresAt = Math.floor(createdAt) + MAX_REFRESH_LIFETIME_MS;
  return Number.isSafeInteger(expiresAt) ? expiresAt : 0;
}

function minimumFamilyExpiry(...values: (number | undefined)[]): number {
  const valid = values
    .filter((value): value is number => (
      typeof value === "number"
      && Number.isFinite(value)
      && Number.isSafeInteger(value)
      && value > 0
    ))
    .map((value) => Math.floor(value));
  return valid.length ? Math.min(...valid) : 0;
}

async function ensureRefreshFamilyCleanupScheduled(
  ctx: MutationContext,
  root: Doc<"mcpOAuthRefreshTokens">,
  familyExpiresAt: number,
): Promise<void> {
  if (
    root.externalId !== root.familyExternalId
    || !Number.isSafeInteger(familyExpiresAt)
    || familyExpiresAt <= 0
  ) {
    return;
  }
  const currentGeneration = Number.isSafeInteger(root.cleanupScheduleGeneration)
    && (root.cleanupScheduleGeneration ?? 0) > 0
    ? root.cleanupScheduleGeneration ?? 0
    : 0;
  if (
    root.familyExpiresAt === familyExpiresAt
    && root.cleanupScheduledAt === familyExpiresAt
    && currentGeneration > 0
  ) {
    return;
  }
  if (currentGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("OAuth refresh cleanup generation is exhausted");
  }
  const scheduleGeneration = currentGeneration + 1;
  await ctx.db.patch(root._id, {
    familyExpiresAt,
    cleanupScheduledAt: familyExpiresAt,
    cleanupScheduleGeneration: scheduleGeneration,
  });
  await ctx.scheduler.runAt(Math.max(Date.now(), familyExpiresAt), cleanupRefreshFamilyRef, {
    familyExternalId: root.familyExternalId,
    familyExpiresAt,
    scheduleGeneration,
  });
}

async function revokeRefreshFamily(
  ctx: MutationContext,
  familyExternalId: string,
  now: number,
): Promise<void> {
  const newest = await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_family_created", (q) => q.eq("familyExternalId", familyExternalId))
    .order("desc")
    .first();
  if (
    newest
    && newest.consumedAt === undefined
    && newest.revokedAt === undefined
  ) {
    await ctx.db.patch(newest._id, { revokedAt: now });
  }
}

function cleanupResult(
  status: "missing" | "retained" | "cleaned",
  retainedRows: number,
  cleanedRows: number,
  hasMore: boolean,
) {
  const result = { status, retainedRows, cleanedRows, hasMore };
  console.info("OAuth refresh cleanup", result);
  return result;
}

function publicClient(client: Doc<"mcpOAuthClients">) {
  return {
    clientId: client.externalId,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    createdAt: new Date(client.createdAt).toISOString(),
  };
}
