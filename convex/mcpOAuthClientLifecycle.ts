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
const clientRegistrationValidator = v.union(
  v.object({
    status: v.literal("ok"),
    client: publicClientValidator,
    replayed: v.boolean(),
    cleanedClients: v.number(),
  }),
  v.object({
    status: v.literal("capacity_cleanup_required"),
    cleanedClients: v.number(),
    retainedClients: v.number(),
    hasMore: v.boolean(),
  }),
  v.object({
    status: v.literal("limit_reached"),
    cleanedClients: v.number(),
    retainedClients: v.number(),
  }),
  v.object({ status: v.literal("conflict") }),
);
const clientCleanupValidator = v.object({
  status: v.union(
    v.literal("missing"),
    v.literal("retained"),
    v.literal("cleaned"),
  ),
  cleanedClients: v.number(),
  retainedClients: v.number(),
  rescheduled: v.boolean(),
});

type WorkspaceId = GenericId<"workspaces">;
type OAuthScope = Infer<typeof oauthScope>;

const MAX_CLIENT_REDIRECT_URIS = 20;
const MAX_CLIENTS_PER_WORKSPACE = 1_000;
const UNUSED_CLIENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CLIENT_CLEANUP_BATCH_SIZE = 25;
const cleanupUnusedClientRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:cleanupUnusedClientScheduled",
);
const createAuthorizationCodeRef = makeFunctionReference<"mutation">(
  "mcpOAuth:createAuthorizationCode",
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
  returns: clientRegistrationValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await ensureWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Failed to create workspace");

    const normalized = normalizeClientInput(args);
    const existing = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", normalized.externalId))
      .unique();
    if (existing) {
      if (
        existing.workspaceId !== workspace._id
        || !sameClientMetadata(existing, normalized)
      ) {
        return { status: "conflict" as const };
      }
      return {
        status: "ok" as const,
        client: publicClient(existing),
        replayed: true,
        cleanedClients: 0,
      };
    }

    const now = Date.now();
    const cleanup = await cleanupExpiredUnusedClients(
      ctx,
      workspace._id,
      now,
      CLIENT_CLEANUP_BATCH_SIZE,
    );
    const clients = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_CLIENTS_PER_WORKSPACE);
    if (clients.length >= MAX_CLIENTS_PER_WORKSPACE) {
      const result = cleanup.hasMore
        ? {
            status: "capacity_cleanup_required" as const,
            cleanedClients: cleanup.cleanedClients,
            retainedClients: cleanup.retainedClients,
            hasMore: true,
          }
        : {
            status: "limit_reached" as const,
            cleanedClients: cleanup.cleanedClients,
            retainedClients: cleanup.retainedClients,
          };
      logClientLifecycle(result);
      return result;
    }

    const unusedExpiresAt = now + UNUSED_CLIENT_LIFETIME_MS;
    const cleanupScheduleGeneration = 1;
    const id = await ctx.db.insert("mcpOAuthClients", {
      workspaceId: workspace._id,
      externalId: normalized.externalId,
      clientName: normalized.clientName,
      redirectUris: normalized.redirectUris,
      tokenEndpointAuthMethod: normalized.tokenEndpointAuthMethod,
      grantTypes: normalized.grantTypes,
      responseTypes: normalized.responseTypes,
      lifecycleStatus: "unused",
      unusedExpiresAt,
      cleanupScheduleGeneration,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(unusedExpiresAt, cleanupUnusedClientRef, {
      workspaceId: workspace._id,
      clientExternalId: normalized.externalId,
      unusedExpiresAt,
      scheduleGeneration: cleanupScheduleGeneration,
    });
    const client = await ctx.db.get("mcpOAuthClients", id);
    if (!client) throw new Error("Created OAuth client disappeared");
    return {
      status: "ok" as const,
      client: publicClient(client),
      replayed: false,
      cleanedClients: cleanup.cleanedClients,
    };
  },
});

export const getClient = query({
  args: { ...serviceArgs, clientId: v.string() },
  returns: v.union(publicClientValidator, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const clientId = readCredentialId(args.clientId);
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
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Workspace is unavailable");
    const client = await requireClient(ctx, workspace._id, args.clientId);
    assertRegisteredRedirect(client, args.redirectUri);
    if (client.lifecycleStatus === "unused") {
      await ctx.db.patch(client._id, {
        lifecycleStatus: "used",
        usedAt: Date.now(),
        unusedExpiresAt: undefined,
        cleanupScheduleGeneration: nextGeneration(client.cleanupScheduleGeneration),
      });
    }
    const result: Infer<typeof grantValidator> = await ctx.runMutation(
      createAuthorizationCodeRef,
      args,
    ) as Infer<typeof grantValidator>;
    return result;
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
    if (
      client.lifecycleStatus !== "unused"
      || client.unusedExpiresAt !== args.unusedExpiresAt
      || client.cleanupScheduleGeneration !== args.scheduleGeneration
    ) {
      return clientCleanupResult("retained", 0, 1, false);
    }

    const now = Date.now();
    if (args.unusedExpiresAt > now) {
      const scheduleGeneration = nextGeneration(args.scheduleGeneration);
      await ctx.db.patch(client._id, { cleanupScheduleGeneration: scheduleGeneration });
      await ctx.scheduler.runAt(args.unusedExpiresAt, cleanupUnusedClientRef, {
        workspaceId: args.workspaceId,
        clientExternalId: args.clientExternalId,
        unusedExpiresAt: args.unusedExpiresAt,
        scheduleGeneration,
      });
      return clientCleanupResult("retained", 0, 1, true);
    }

    if (await hasClientReferences(ctx, args.workspaceId, client.externalId)) {
      await markClientUsed(ctx, client, now);
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
  limit: number,
): Promise<{ cleanedClients: number; retainedClients: number; hasMore: boolean }> {
  const candidates = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_workspace_lifecycle_expiry", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("lifecycleStatus", "unused")
      .lte("unusedExpiresAt", now))
    .take(limit + 1);
  let cleanedClients = 0;
  let retainedClients = 0;
  for (const client of candidates.slice(0, limit)) {
    if (await hasClientReferences(ctx, workspaceId, client.externalId)) {
      await markClientUsed(ctx, client, now);
      retainedClients += 1;
    } else {
      await ctx.db.delete(client._id);
      cleanedClients += 1;
    }
  }
  return {
    cleanedClients,
    retainedClients,
    hasMore: candidates.length > limit,
  };
}

async function hasClientReferences(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  clientExternalId: string,
): Promise<boolean> {
  const codes = await ctx.db
    .query("mcpOAuthCodes")
    .withIndex("by_workspace_client_created", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("clientExternalId", clientExternalId))
    .take(1);
  if (codes.length > 0) return true;
  const refreshTokens = await ctx.db
    .query("mcpOAuthRefreshTokens")
    .withIndex("by_workspace_client_created", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("clientExternalId", clientExternalId))
    .take(1);
  return refreshTokens.length > 0;
}

async function markClientUsed(
  ctx: MutationContext,
  client: Doc<"mcpOAuthClients">,
  now: number,
): Promise<void> {
  await ctx.db.patch(client._id, {
    lifecycleStatus: "used",
    usedAt: client.usedAt ?? now,
    unusedExpiresAt: undefined,
    cleanupScheduleGeneration: nextGeneration(client.cleanupScheduleGeneration),
  });
}

async function requireClient(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  value: string,
): Promise<Doc<"mcpOAuthClients">> {
  const clientId = assertCredentialId(value);
  const client = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
    .unique();
  if (!client || client.workspaceId !== workspaceId) throw new Error("OAuth client is unavailable");
  return client;
}

function normalizeClientInput(args: {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: string[];
}) {
  return {
    externalId: assertCredentialId(args.clientId),
    clientName: assertText(args.clientName, "OAuth client name", 160),
    redirectUris: normalizeRedirectUris(args.redirectUris),
    tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
    grantTypes: normalizeGrantTypes(args.grantTypes),
    responseTypes: normalizeExactSet(args.responseTypes, ["code"], "response types"),
  };
}

function sameClientMetadata(
  client: Doc<"mcpOAuthClients">,
  normalized: ReturnType<typeof normalizeClientInput>,
): boolean {
  return client.clientName === normalized.clientName
    && client.tokenEndpointAuthMethod === normalized.tokenEndpointAuthMethod
    && sameStrings(client.redirectUris, normalized.redirectUris)
    && sameStrings(client.grantTypes, normalized.grantTypes)
    && sameStrings(client.responseTypes, normalized.responseTypes);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function assertCredentialId(value: string): string {
  const normalized = readCredentialId(value);
  if (!normalized) throw new Error("OAuth client id is invalid");
  return normalized;
}

function readCredentialId(value: string): string | null {
  const normalized = value.trim();
  return /^oauth_client_[A-Za-z0-9_-]{12,96}$/.test(normalized) ? normalized : null;
}

function nextGeneration(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 && (value ?? 0) < Number.MAX_SAFE_INTEGER
    ? (value ?? 0) + 1
    : 1;
}

function clientCleanupResult(
  status: "missing" | "retained" | "cleaned",
  cleanedClients: number,
  retainedClients: number,
  rescheduled: boolean,
) {
  const result = { status, cleanedClients, retainedClients, rescheduled };
  logClientLifecycle(result);
  return result;
}

function logClientLifecycle(result: Record<string, unknown>): void {
  console.info("OAuth client lifecycle", result);
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
