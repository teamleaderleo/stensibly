import { makeFunctionReference } from "convex/server";
import { v, type GenericId } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type MutationContext,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
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
const registrationResultValidator = v.union(
  v.object({ status: v.literal("ok"), client: publicClientValidator }),
  v.object({ status: v.literal("retryable") }),
  v.object({ status: v.literal("limit") }),
  v.object({ status: v.literal("conflict") }),
);

const CLIENT_CLEANUP_BATCH_SIZE = 100;
const MAX_CLIENTS_PER_WORKSPACE = 1_000;
const CLIENT_CAPACITY_CLEANUP_REQUIRED = "MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED";
const CLIENT_REGISTRATION_LIMIT = "MCP_OAUTH_CLIENT_REGISTRATION_LIMIT_REACHED";
const CLIENT_REGISTRATION_CONFLICT = "MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT";
const lifecycleRegisterRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:registerClient",
);
const lifecycleCreateAuthorizationCodeRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:createAuthorizationCode",
);

type WorkspaceId = GenericId<"workspaces">;

type ClientLifecycleShape = {
  lifecycleState?: "unused" | "used";
  unusedExpiresAt?: number;
  firstUsedAt?: number;
  cleanupScheduledAt?: number;
  cleanupScheduleGeneration?: number;
};

export type OAuthClientLifecycle =
  | { kind: "legacy" }
  | { kind: "unused"; unusedExpiresAt: number; scheduleGeneration: number }
  | { kind: "used"; firstUsedAt: number }
  | { kind: "malformed" };

export function classifyOAuthClientLifecycle(
  client: ClientLifecycleShape,
): OAuthClientLifecycle {
  const allAbsent =
    client.lifecycleState === undefined
    && client.unusedExpiresAt === undefined
    && client.firstUsedAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined;
  if (allAbsent) return { kind: "legacy" };

  if (
    client.lifecycleState === "unused"
    && client.firstUsedAt === undefined
    && positiveSafeInteger(client.unusedExpiresAt)
    && client.cleanupScheduledAt === client.unusedExpiresAt
    && positiveSafeInteger(client.cleanupScheduleGeneration)
  ) {
    return {
      kind: "unused",
      unusedExpiresAt: client.unusedExpiresAt,
      scheduleGeneration: client.cleanupScheduleGeneration,
    };
  }

  if (
    client.lifecycleState === "used"
    && positiveSafeInteger(client.firstUsedAt)
    && client.unusedExpiresAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined
  ) {
    return { kind: "used", firstUsedAt: client.firstUsedAt };
  }

  return { kind: "malformed" };
}

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
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    const clientId = readClientId(args.clientId);
    const now = Date.now();

    if (clientId) {
      const existing = await ctx.db
        .query("mcpOAuthClients")
        .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
        .unique();
      if (existing) {
        if (!workspace || existing.workspaceId !== workspace._id) {
          return { status: "conflict" as const };
        }
        const lifecycle = classifyOAuthClientLifecycle(existing);
        if (lifecycle.kind === "malformed") {
          return { status: "conflict" as const };
        }
        if (lifecycle.kind === "unused" && lifecycle.unusedExpiresAt <= now) {
          if (!(await clientHasReferences(ctx, workspace._id, existing.externalId))) {
            return { status: "conflict" as const };
          }
          await markClientUsedConservatively(ctx, existing, now);
        }
      }
    }

    try {
      const client: {
        clientId: string;
        clientName: string;
        redirectUris: string[];
        tokenEndpointAuthMethod: "none";
        grantTypes: string[];
        responseTypes: string[];
        createdAt: string;
      } = await ctx.runMutation(lifecycleRegisterRef, args);
      return { status: "ok" as const, client };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes(CLIENT_REGISTRATION_CONFLICT)) {
        throw error;
      }
      const capacityFailure =
        message.includes(CLIENT_REGISTRATION_LIMIT)
        || message.includes(CLIENT_CAPACITY_CLEANUP_REQUIRED);
      if (!capacityFailure) throw error;
      if (!workspace) throw error;

      const cleanup = await prepareClientCapacity(ctx, workspace._id, now);
      const clients = await ctx.db
        .query("mcpOAuthClients")
        .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspace._id))
        .take(MAX_CLIENTS_PER_WORKSPACE);
      const retryable = cleanup.hasMore || clients.length < MAX_CLIENTS_PER_WORKSPACE;
      console.info("OAuth client capacity preparation", {
        ...cleanup,
        status: retryable ? "retryable" : "limit",
      });
      return retryable
        ? { status: "retryable" as const }
        : { status: "limit" as const };
    }
  },
});

export const getClient = query({
  args: { ...serviceArgs, clientId: v.string(), now: v.number() },
  returns: v.union(publicClientValidator, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const now = trustedNow(args.now);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const clientId = readClientId(args.clientId);
    if (!clientId) return null;
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (!client || client.workspaceId !== workspace._id) return null;

    const lifecycle = classifyOAuthClientLifecycle(client);
    if (lifecycle.kind === "malformed") return null;
    if (lifecycle.kind === "unused" && lifecycle.unusedExpiresAt <= now) return null;
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
    const clientId = readClientId(args.clientId);
    if (!workspace || !clientId) throw new Error("OAuth client is unavailable");
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (!client || client.workspaceId !== workspace._id) {
      throw new Error("OAuth client is unavailable");
    }

    const now = Date.now();
    const lifecycle = classifyOAuthClientLifecycle(client);
    if (lifecycle.kind === "malformed") {
      throw new Error("OAuth client is unavailable");
    }
    if (lifecycle.kind === "unused" && lifecycle.unusedExpiresAt <= now) {
      if (!(await clientHasReferences(ctx, workspace._id, client.externalId))) {
        throw new Error("OAuth client is unavailable");
      }
      await markClientUsedConservatively(ctx, client, now);
    }

    return await ctx.runMutation(lifecycleCreateAuthorizationCodeRef, args);
  },
});

async function prepareClientCapacity(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  now: number,
): Promise<{ cleaned: number; blocked: number; repaired: number; hasMore: boolean }> {
  const candidates = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_workspace_lifecycle_expiry", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("lifecycleState", "unused")
      .lte("unusedExpiresAt", now))
    .take(CLIENT_CLEANUP_BATCH_SIZE + 1);
  let cleaned = 0;
  let blocked = 0;
  let repaired = 0;
  for (const client of candidates.slice(0, CLIENT_CLEANUP_BATCH_SIZE)) {
    if (await clientHasReferences(ctx, workspaceId, client.externalId)) {
      await markClientUsedConservatively(ctx, client, now);
      repaired += 1;
      continue;
    }
    const lifecycle = classifyOAuthClientLifecycle(client);
    if (lifecycle.kind !== "unused" || lifecycle.unusedExpiresAt > now) {
      blocked += 1;
      continue;
    }
    await ctx.db.delete(client._id);
    cleaned += 1;
  }
  return {
    cleaned,
    blocked,
    repaired,
    hasMore: candidates.length > CLIENT_CLEANUP_BATCH_SIZE,
  };
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
    firstUsedAt: positiveSafeInteger(client.firstUsedAt) ? client.firstUsedAt : now,
    unusedExpiresAt: undefined,
    cleanupScheduledAt: undefined,
    cleanupScheduleGeneration: undefined,
    updatedAt: Math.max(client.updatedAt, now),
  });
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

function readClientId(value: string): string | null {
  const normalized = value.trim();
  return /^oauth_client_[A-Za-z0-9_-]{12,96}$/.test(normalized) ? normalized : null;
}

function trustedNow(value: number): number {
  if (!positiveSafeInteger(value)) throw new Error("OAuth client read time is invalid");
  return value;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
