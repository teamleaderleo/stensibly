import { makeFunctionReference } from "convex/server";
import { v, type GenericId } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type MutationContext,
} from "./lib/domain";
import { mutation } from "./lib/server";
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
  v.object({ status: v.literal("expired") }),
);
const authorizationResultValidator = v.union(
  v.object({ status: v.literal("ok"), grant: grantValidator }),
  v.object({ status: v.literal("invalid") }),
);

const CLIENT_REGISTRATION_CONFLICT = "MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT";
const CLIENT_REGISTRATION_EXPIRED = "MCP_OAUTH_CLIENT_REGISTRATION_EXPIRED";
const lifecycleRegisterRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:registerClient",
);
const lifecycleCreateAuthorizationCodeRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:createAuthorizationCode",
);

type WorkspaceId = GenericId<"workspaces">;
type LifecycleKind = "legacy" | "unused" | "used" | "malformed";

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
    await repairReferencedClient(ctx, args.workspace, args.clientId, Date.now());
    try {
      return await ctx.runMutation(lifecycleRegisterRef, args) as
        | { status: "ok"; client: {
            clientId: string;
            clientName: string;
            redirectUris: string[];
            tokenEndpointAuthMethod: "none";
            grantTypes: string[];
            responseTypes: string[];
            createdAt: string;
          } }
        | { status: "retryable" }
        | { status: "limit" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes(CLIENT_REGISTRATION_CONFLICT)) {
        return { status: "conflict" as const };
      }
      if (message.includes(CLIENT_REGISTRATION_EXPIRED)) {
        return { status: "expired" as const };
      }
      throw error;
    }
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
  returns: authorizationResultValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    await repairReferencedClient(ctx, args.workspace, args.clientId, Date.now());
    try {
      const grant = await ctx.runMutation(lifecycleCreateAuthorizationCodeRef, args) as {
        clientId: string;
        resource: string;
        scopes: ("read" | "write" | "offline_access")[];
        principal: {
          accountId: string;
          name: string;
          workspace: string;
          role: "owner" | "admin" | "member" | "viewer";
          scopes: ("read" | "write" | "admin")[];
          projects: string[] | null;
        };
      };
      return { status: "ok" as const, grant };
    } catch {
      return { status: "invalid" as const };
    }
  },
});

async function repairReferencedClient(
  ctx: MutationContext,
  workspaceValue: string | undefined,
  clientIdValue: string,
  now: number,
): Promise<void> {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceValue));
  if (!workspace) return;
  const clientId = readClientId(clientIdValue);
  if (!clientId) return;
  const client = await ctx.db
    .query("mcpOAuthClients")
    .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
    .unique();
  if (!client || client.workspaceId !== workspace._id) return;
  const lifecycle = classifyLifecycle(client);
  if (lifecycle === "legacy" || lifecycle === "used") return;
  if (!(await clientHasReferences(ctx, workspace._id, client.externalId))) return;
  await markClientUsedConservatively(ctx, client, now);
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

function classifyLifecycle(client: Doc<"mcpOAuthClients">): LifecycleKind {
  const allAbsent = client.lifecycleState === undefined
    && client.unusedExpiresAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined
    && client.firstUsedAt === undefined;
  if (allAbsent) return "legacy";
  if (
    client.lifecycleState === "unused"
    && safeTimestamp(client.unusedExpiresAt)
    && client.cleanupScheduledAt === client.unusedExpiresAt
    && positiveGeneration(client.cleanupScheduleGeneration)
    && client.firstUsedAt === undefined
  ) return "unused";
  if (
    client.lifecycleState === "used"
    && safeTimestamp(client.firstUsedAt)
    && client.unusedExpiresAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined
  ) return "used";
  return "malformed";
}

function readClientId(value: string): string | null {
  const normalized = value.trim();
  return /^oauth_client_[A-Za-z0-9_-]{12,96}$/.test(normalized) ? normalized : null;
}

function positiveGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
