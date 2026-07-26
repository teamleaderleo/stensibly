import { makeFunctionReference } from "convex/server";
import { v, type GenericId } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  findWorkspace,
  normalizeWorkspace,
  type MutationContext,
} from "./lib/domain";
import { mutation } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const tokenEndpointAuthMethod = v.literal("none");
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

const CLIENT_CLEANUP_BATCH_SIZE = 100;
const CLIENT_CAPACITY_CLEANUP_REQUIRED = "MCP_OAUTH_CLIENT_CAPACITY_CLEANUP_REQUIRED";
const CLIENT_REGISTRATION_LIMIT = "MCP_OAUTH_CLIENT_REGISTRATION_LIMIT_REACHED";
const lifecycleRegisterRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:registerClient",
);

type WorkspaceId = GenericId<"workspaces">;

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
      if (message.includes(CLIENT_REGISTRATION_LIMIT)) {
        return { status: "limit" as const };
      }
      if (!message.includes(CLIENT_CAPACITY_CLEANUP_REQUIRED)) throw error;

      const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
      if (!workspace) throw error;
      const cleanup = await prepareClientCapacity(ctx, workspace._id, Date.now());
      console.info("OAuth client capacity preparation", cleanup);
      return { status: "retryable" as const };
    }
  },
});

async function prepareClientCapacity(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  now: number,
): Promise<{ cleaned: number; blocked: number; hasMore: boolean }> {
  const candidates = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_workspace_lifecycle_expiry", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("lifecycleState", "unused")
      .lte("unusedExpiresAt", now))
    .take(CLIENT_CLEANUP_BATCH_SIZE + 1);
  let cleaned = 0;
  let blocked = 0;
  for (const client of candidates.slice(0, CLIENT_CLEANUP_BATCH_SIZE)) {
    if (await clientHasReferences(ctx, workspaceId, client.externalId)) {
      await markClientUsedConservatively(ctx, client, now);
      blocked += 1;
    } else {
      await ctx.db.delete(client._id);
      cleaned += 1;
    }
  }
  return {
    cleaned,
    blocked,
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
    firstUsedAt: client.firstUsedAt ?? now,
    unusedExpiresAt: undefined,
    cleanupScheduledAt: undefined,
    cleanupScheduleGeneration: undefined,
    updatedAt: Math.max(client.updatedAt, now),
  });
}
