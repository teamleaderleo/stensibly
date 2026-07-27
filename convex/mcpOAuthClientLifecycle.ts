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
const registrationResultValidator = v.union(
  v.object({ status: v.literal("ok"), client: publicClientValidator }),
  v.object({ status: v.literal("retryable") }),
  v.object({ status: v.literal("limit") }),
);
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
const clientCleanupValidator = v.object({
  status: v.union(
    v.literal("missing"),
    v.literal("retained"),
    v.literal("cleaned"),
  ),
  cleanedClients: v.number(),
  blockedClients: v.number(),
  hasMore: v.boolean(),
});
const clientReconcileValidator = v.object({
  status: v.union(
    v.literal("missing"),
    v.literal("unchanged"),
    v.literal("repaired"),
  ),
});

type AccountRole = Infer<typeof accountRole>;
type OAuthScope = Infer<typeof oauthScope>;
type AccountId = GenericId<"accounts">;
type WorkspaceId = GenericId<"workspaces">;

type NormalizedClientMetadata = {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: string[];
};

type ClientLifecycle =
  | { kind: "legacy" }
  | { kind: "unused"; unusedExpiresAt: number; scheduleGeneration: number }
  | { kind: "used"; firstUsedAt: number }
  | { kind: "malformed" };

const MAX_CLIENT_REDIRECT_URIS = 20;
const MAX_CLIENTS_PER_WORKSPACE = 1_000;
const MAX_CODE_LIFETIME_MS = 10 * 60 * 1000;
const UNUSED_CLIENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CLIENT_CLEANUP_BATCH_SIZE = 100;
const CLIENT_REGISTRATION_CONFLICT = "MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT";
const CLIENT_REGISTRATION_EXPIRED = "MCP_OAUTH_CLIENT_REGISTRATION_EXPIRED";
const cleanupUnusedClientRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:cleanupUnusedClientScheduled",
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
  returns: registrationResultValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await ensureWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Failed to create workspace");
    const clientId = assertCredentialId(args.clientId, "client");
    const metadata = normalizeClientMetadata(args);
    const now = Date.now();
    const existing = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (existing) {
      if (
        existing.workspaceId !== workspace._id
        || !clientMetadataMatches(existing, metadata)
      ) {
        throw new Error(CLIENT_REGISTRATION_CONFLICT);
      }
      const lifecycle = classifyClientLifecycle(existing);
      if (lifecycle.kind === "malformed") {
        throw new Error(CLIENT_REGISTRATION_CONFLICT);
      }
      if (lifecycle.kind === "unused" && lifecycle.unusedExpiresAt <= now) {
        if (await clientHasReferences(ctx, workspace._id, existing.externalId)) {
          await markClientUsedConservatively(ctx, existing, now);
          return { status: "ok" as const, client: publicClient(existing) };
        }
        throw new Error(CLIENT_REGISTRATION_EXPIRED);
      }
      return { status: "ok" as const, client: publicClient(existing) };
    }

    const cleanup = await cleanupExpiredUnusedClients(ctx, workspace._id, now);
    const clients = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_CLIENTS_PER_WORKSPACE);
    if (clients.length >= MAX_CLIENTS_PER_WORKSPACE) {
      return cleanup.hasMore
        ? { status: "retryable" as const }
        : { status: "limit" as const };
    }

    const unusedExpiresAt = now + UNUSED_CLIENT_LIFETIME_MS;
    if (!Number.isSafeInteger(unusedExpiresAt)) throw new Error("OAuth client expiry is invalid");
    const cleanupScheduleGeneration = 1;
    const id = await ctx.db.insert("mcpOAuthClients", {
      workspaceId: workspace._id,
      externalId: clientId,
      ...metadata,
      lifecycleState: "unused",
      unusedExpiresAt,
      cleanupScheduledAt: unusedExpiresAt,
      cleanupScheduleGeneration,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(unusedExpiresAt, cleanupUnusedClientRef, {
      workspaceId: workspace._id,
      clientExternalId: clientId,
      unusedExpiresAt,
      scheduleGeneration: cleanupScheduleGeneration,
    });
    const client = await ctx.db.get("mcpOAuthClients", id);
    if (!client) throw new Error("Created OAuth client disappeared");
    return { status: "ok" as const, client: publicClient(client) };
  },
});

export const getClient = query({
  args: { ...serviceArgs, clientId: v.string(), now: v.number() },
  returns: v.union(publicClientValidator, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const clientId = readCredentialId(args.clientId, "client");
    if (!clientId) return null;
    const now = assertTrustedNow(args.now);
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (!client || client.workspaceId !== workspace._id || !clientAvailableAt(client, now)) {
      return null;
    }
    return publicClient(client);
  },
});

export const reconcileClientLifecycle = mutation({
  args: { ...serviceArgs, clientId: v.string() },
  returns: clientReconcileValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return { status: "missing" as const };
    const clientId = readCredentialId(args.clientId, "client");
    if (!clientId) return { status: "missing" as const };
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (!client || client.workspaceId !== workspace._id) {
      return { status: "missing" as const };
    }
    if (classifyClientLifecycle(client).kind === "used") {
      return { status: "unchanged" as const };
    }
    if (!await clientHasReferences(ctx, workspace._id, client.externalId)) {
      return { status: "unchanged" as const };
    }
    await markClientUsedConservatively(ctx, client, Date.now());
    return { status: "repaired" as const };
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
    const now = Date.now();
    const client = await requireClient(ctx, workspace._id, args.clientId, now);
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
    const code = {
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
    };

    await deleteExpiredCodes(ctx, now);
    const lifecycle = classifyClientLifecycle(client);
    if (lifecycle.kind !== "used") {
      await markClientUsedConservatively(ctx, client, now);
    }
    await ctx.db.insert("mcpOAuthCodes", code);
    return grant(client.externalId, args.resource, scopes, principal);
  },
});

export const cleanupUnusedClientScheduled = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    clientExternalId: v.string(),
    unusedExpiresAt: v.number(),
    scheduleGeneration: v.number(),
  },
  returns: clientCleanupValidator,
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.clientExternalId))
      .unique();
    if (!client || client.workspaceId !== args.workspaceId) {
      return clientCleanupResult("missing", 0, 0, false);
    }
    const rawScheduleMatches =
      client.lifecycleState === "unused"
      && client.unusedExpiresAt === args.unusedExpiresAt
      && client.cleanupScheduledAt === args.unusedExpiresAt
      && client.cleanupScheduleGeneration === args.scheduleGeneration
      && positiveGeneration(args.scheduleGeneration);
    if (!rawScheduleMatches) {
      return clientCleanupResult("retained", 0, 0, false);
    }

    const now = Date.now();
    const lifecycle = classifyClientLifecycle(client);
    if (lifecycle.kind === "malformed") {
      if (await clientHasReferences(ctx, args.workspaceId, args.clientExternalId)) {
        await markClientUsedConservatively(ctx, client, now);
      } else {
        await quarantineMalformedClient(ctx, client, now);
      }
      return clientCleanupResult("retained", 0, 1, false);
    }
    if (lifecycle.kind !== "unused") {
      return clientCleanupResult("retained", 0, 0, false);
    }
    if (args.unusedExpiresAt > now) {
      const nextGeneration = nextScheduleGeneration(args.scheduleGeneration);
      await ctx.db.patch(client._id, { cleanupScheduleGeneration: nextGeneration });
      await ctx.scheduler.runAt(args.unusedExpiresAt, cleanupUnusedClientRef, {
        workspaceId: args.workspaceId,
        clientExternalId: args.clientExternalId,
        unusedExpiresAt: args.unusedExpiresAt,
        scheduleGeneration: nextGeneration,
      });
      return clientCleanupResult("retained", 0, 0, false);
    }

    if (await clientHasReferences(ctx, args.workspaceId, args.clientExternalId)) {
      await markClientUsedConservatively(ctx, client, now);
      return clientCleanupResult("retained", 0, 1, false);
    }
    await ctx.db.delete(client._id);
    return clientCleanupResult("cleaned", 1, 0, false);
  },
});

async function cleanupExpiredUnusedClients(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  now: number,
): Promise<{ cleaned: number; blocked: number; hasMore: boolean }> {
  const candidates = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_workspace_lifecycle_expiry", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("lifecycleState", "unused")
      .gt("unusedExpiresAt", undefined)
      .lte("unusedExpiresAt", now))
    .take(CLIENT_CLEANUP_BATCH_SIZE + 1);
  let cleaned = 0;
  let blocked = 0;
  for (const client of candidates.slice(0, CLIENT_CLEANUP_BATCH_SIZE)) {
    const lifecycle = classifyClientLifecycle(client);
    if (await clientHasReferences(ctx, workspaceId, client.externalId)) {
      await markClientUsedConservatively(ctx, client, now);
      blocked += 1;
    } else if (lifecycle.kind === "unused" && lifecycle.unusedExpiresAt <= now) {
      await ctx.db.delete(client._id);
      cleaned += 1;
    } else {
      await quarantineMalformedClient(ctx, client, now);
      blocked += 1;
    }
  }
  const result = {
    cleaned,
    blocked,
    hasMore: candidates.length > CLIENT_CLEANUP_BATCH_SIZE,
  };
  console.info("OAuth client capacity cleanup", result);
  return result;
}

async function clientHasReferences(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  clientExternalId: string,
): Promise<boolean> {
  const code = await ctx.db
    .query("mcpOAuthCodes")
    .withIndex("by_workspace_client_created", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("clientExternalId", clientExternalId))
    .first();
  if (code) return true;
  const refresh = await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_workspace_client_created", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("clientExternalId", clientExternalId))
    .first();
  return refresh !== null;
}

async function markClientUsedConservatively(
  ctx: MutationContext,
  client: Doc<"mcpOAuthClients">,
  now: number,
): Promise<void> {
  await ctx.db.patch(client._id, {
    lifecycleState: "used",
    firstUsedAt: safeTimestamp(client.firstUsedAt) ? client.firstUsedAt : now,
    unusedExpiresAt: undefined,
    cleanupScheduledAt: undefined,
    cleanupScheduleGeneration: undefined,
    updatedAt: safeTimestamp(client.updatedAt) ? Math.max(client.updatedAt, now) : now,
  });
}

async function quarantineMalformedClient(
  ctx: MutationContext,
  client: Doc<"mcpOAuthClients">,
  now: number,
): Promise<void> {
  await ctx.db.patch(client._id, {
    unusedExpiresAt: undefined,
    cleanupScheduledAt: undefined,
    cleanupScheduleGeneration: undefined,
    updatedAt: safeTimestamp(client.updatedAt) ? Math.max(client.updatedAt, now) : now,
  });
}

function classifyClientLifecycle(client: Doc<"mcpOAuthClients">): ClientLifecycle {
  const allAbsent = client.lifecycleState === undefined
    && client.unusedExpiresAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined
    && client.firstUsedAt === undefined;
  if (allAbsent) return { kind: "legacy" };

  if (
    client.lifecycleState === "unused"
    && safeTimestamp(client.unusedExpiresAt)
    && client.cleanupScheduledAt === client.unusedExpiresAt
    && positiveGeneration(client.cleanupScheduleGeneration)
    && client.firstUsedAt === undefined
  ) {
    return {
      kind: "unused",
      unusedExpiresAt: client.unusedExpiresAt,
      scheduleGeneration: client.cleanupScheduleGeneration,
    };
  }

  if (
    client.lifecycleState === "used"
    && safeTimestamp(client.firstUsedAt)
    && client.unusedExpiresAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined
  ) {
    return { kind: "used", firstUsedAt: client.firstUsedAt };
  }

  return { kind: "malformed" };
}

function clientAvailableAt(client: Doc<"mcpOAuthClients">, now: number): boolean {
  const lifecycle = classifyClientLifecycle(client);
  return lifecycle.kind === "legacy"
    || lifecycle.kind === "used"
    || (lifecycle.kind === "unused" && lifecycle.unusedExpiresAt > now);
}

function normalizeClientMetadata(input: {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: string[];
}): NormalizedClientMetadata {
  return {
    clientName: assertText(input.clientName, "OAuth client name", 160),
    redirectUris: normalizeRedirectUris(input.redirectUris),
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    grantTypes: normalizeGrantTypes(input.grantTypes),
    responseTypes: normalizeExactSet(input.responseTypes, ["code"], "response types"),
  };
}

function clientMetadataMatches(
  client: Doc<"mcpOAuthClients">,
  metadata: NormalizedClientMetadata,
): boolean {
  return client.clientName === metadata.clientName
    && equalStrings(client.redirectUris, metadata.redirectUris)
    && client.tokenEndpointAuthMethod === metadata.tokenEndpointAuthMethod
    && equalStrings(client.grantTypes, metadata.grantTypes)
    && equalStrings(client.responseTypes, metadata.responseTypes);
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nextScheduleGeneration(value: number): number {
  return positiveGeneration(value) && value < Number.MAX_SAFE_INTEGER
    ? value + 1
    : 1;
}

function positiveGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertTrustedNow(value: number): number {
  if (!safeTimestamp(value)) throw new Error("OAuth client lookup time is invalid");
  return value;
}

async function requireClient(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  value: string,
  now: number,
) {
  const clientId = assertCredentialId(value, "client");
  const client = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
    .unique();
  if (!client || client.workspaceId !== workspaceId || !clientAvailableAt(client, now)) {
    throw new Error("OAuth client is unavailable");
  }
  return client;
}

async function requireAccountPrincipal(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  if (!unique.includes("read") || !accountScopes.includes("read")) return null;
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

function assertCredentialId(value: string, kind: "client" | "code"): string {
  const normalized = readCredentialId(value, kind);
  if (!normalized) throw new Error(`OAuth ${kind} id is invalid`);
  return normalized;
}

function readCredentialId(value: string, kind: "client" | "code"): string | null {
  const normalized = value.trim();
  return new RegExp(`^oauth_${kind}_[A-Za-z0-9_-]{12,96}$`).test(normalized) ? normalized : null;
}

function assertHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("OAuth credential hash must be a SHA-256 hex digest");
  }
  return normalized;
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

function clientCleanupResult(
  status: "missing" | "retained" | "cleaned",
  cleanedClients: number,
  blockedClients: number,
  hasMore: boolean,
) {
  const result = { status, cleanedClients, blockedClients, hasMore };
  console.info("OAuth client scheduled cleanup", result);
  return result;
}
