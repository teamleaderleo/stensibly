import { v } from "convex/values";
import {
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const evidenceValidator = v.object({
  version: v.literal(1),
  accountId: v.string(),
  project: v.string(),
  connectedAt: v.union(v.string(), v.null()),
  firstReadAt: v.union(v.string(), v.null()),
  containsSecrets: v.literal(false),
});

export const recordConnection = mutation({
  args: {
    ...serviceArgs,
    accountId: v.string(),
    clientId: v.string(),
    resource: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("MCP setup workspace is unavailable");
    const accountId = exactAccountId(args.accountId);
    const clientId = exactClientId(args.clientId);
    const resource = exactMcpResource(args.resource);

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_external_id", (q) => q.eq("externalId", accountId))
      .unique();
    if (!account || account.disabledAt !== undefined) {
      throw new Error("MCP setup account is unavailable");
    }
    const membership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_account_workspace", (q) =>
        q.eq("accountId", account._id).eq("workspaceId", workspace._id),
      )
      .unique();
    if (!membership || membership.revokedAt !== undefined) {
      throw new Error("MCP setup account membership is unavailable");
    }
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_external_id", (q) => q.eq("externalId", clientId))
      .unique();
    if (!client || client.workspaceId !== workspace._id) {
      throw new Error("MCP setup OAuth client is unavailable");
    }

    const existing = await ctx.db
      .query("mcpSetupConnections")
      .withIndex("by_workspace_account", (q) =>
        q.eq("workspaceId", workspace._id).eq("accountId", account._id),
      )
      .unique();
    if (existing) return null;

    const connectedAt = currentObservationTime();
    await ctx.db.insert("mcpSetupConnections", {
      workspaceId: workspace._id,
      accountId: account._id,
      clientExternalId: clientId,
      resource,
      connectedAt,
    });
    return null;
  },
});

export const recordFirstRead = mutation({
  args: {
    ...serviceArgs,
    accountId: v.string(),
    project: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("MCP setup workspace is unavailable");
    const accountId = exactAccountId(args.accountId);
    const project = exactProject(args.project);

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_external_id", (q) => q.eq("externalId", accountId))
      .unique();
    if (!account || account.disabledAt !== undefined) {
      throw new Error("MCP setup account is unavailable");
    }
    const membership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_account_workspace", (q) =>
        q.eq("accountId", account._id).eq("workspaceId", workspace._id),
      )
      .unique();
    if (!membership || membership.revokedAt !== undefined) {
      throw new Error("MCP setup account membership is unavailable");
    }
    if (membership.projects !== undefined && !membership.projects.includes(project)) {
      throw new Error("MCP setup project access is unavailable");
    }
    const projectRow = await findProject(ctx, workspace._id, project);
    if (!projectRow) throw new Error("MCP setup project is unavailable");

    const connection = await ctx.db
      .query("mcpSetupConnections")
      .withIndex("by_workspace_account", (q) =>
        q.eq("workspaceId", workspace._id).eq("accountId", account._id),
      )
      .unique();
    if (!connection) throw new Error("MCP setup connection evidence is unavailable");

    const existing = await ctx.db
      .query("mcpSetupFirstReads")
      .withIndex("by_workspace_account_project", (q) =>
        q
          .eq("workspaceId", workspace._id)
          .eq("accountId", account._id)
          .eq("projectId", projectRow._id),
      )
      .unique();
    if (existing) return null;

    const firstReadAt = currentObservationTime();
    if (firstReadAt < connection.connectedAt) {
      throw new Error("MCP setup first-read time predates connection evidence");
    }
    await ctx.db.insert("mcpSetupFirstReads", {
      workspaceId: workspace._id,
      accountId: account._id,
      projectId: projectRow._id,
      firstReadAt,
    });
    return null;
  },
});

export const getEvidence = query({
  args: {
    ...serviceArgs,
    accountId: v.string(),
    project: v.string(),
  },
  returns: evidenceValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    const accountId = exactAccountId(args.accountId);
    const project = exactProject(args.project);
    if (!workspace) return emptyEvidence(accountId, project);

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_external_id", (q) => q.eq("externalId", accountId))
      .unique();
    if (!account || account.disabledAt !== undefined) {
      return emptyEvidence(accountId, project);
    }
    const membership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_account_workspace", (q) =>
        q.eq("accountId", account._id).eq("workspaceId", workspace._id),
      )
      .unique();
    if (!membership || membership.revokedAt !== undefined) {
      return emptyEvidence(accountId, project);
    }
    if (membership.projects !== undefined && !membership.projects.includes(project)) {
      return emptyEvidence(accountId, project);
    }
    const projectRow = await findProject(ctx, workspace._id, project);
    if (!projectRow) return emptyEvidence(accountId, project);

    const connection = await ctx.db
      .query("mcpSetupConnections")
      .withIndex("by_workspace_account", (q) =>
        q.eq("workspaceId", workspace._id).eq("accountId", account._id),
      )
      .unique();
    if (!connection) return emptyEvidence(accountId, project);

    const firstRead = await ctx.db
      .query("mcpSetupFirstReads")
      .withIndex("by_workspace_account_project", (q) =>
        q
          .eq("workspaceId", workspace._id)
          .eq("accountId", account._id)
          .eq("projectId", projectRow._id),
      )
      .unique();
    if (firstRead && firstRead.firstReadAt < connection.connectedAt) {
      throw new Error("Stored MCP setup first-read evidence is invalid");
    }
    return {
      version: 1 as const,
      accountId,
      project,
      connectedAt: isoTimestamp(connection.connectedAt),
      firstReadAt: firstRead ? isoTimestamp(firstRead.firstReadAt) : null,
      containsSecrets: false as const,
    };
  },
});

function emptyEvidence(accountId: string, project: string) {
  return {
    version: 1 as const,
    accountId,
    project,
    connectedAt: null,
    firstReadAt: null,
    containsSecrets: false as const,
  };
}

function exactAccountId(value: string): string {
  if (
    value !== value.trim()
    || value.length > 160
    || !/^acct_[A-Za-z0-9_-]+$/u.test(value)
  ) throw new Error("MCP setup account identity is invalid");
  return value;
}

function exactClientId(value: string): string {
  if (
    value !== value.trim()
    || value.length > 160
    || !/^oauth_client_[A-Za-z0-9_-]{12,96}$/u.test(value)
  ) throw new Error("MCP setup OAuth client identity is invalid");
  return value;
}

function exactProject(value: string): string {
  if (
    value !== value.trim()
    || value.length > 80
    || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)
  ) throw new Error("MCP setup project identity is invalid");
  return value;
}

function exactMcpResource(value: string): string {
  if (value !== value.trim() || value.length > 2048) {
    throw new Error("MCP setup resource is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MCP setup resource is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/mcp"
    || parsed.toString() !== value
  ) {
    throw new Error("MCP setup resource is invalid");
  }
  return value;
}

function currentObservationTime(): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("MCP setup observation time is invalid");
  }
  return now;
}

function isoTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Stored MCP setup observation time is invalid");
  }
  return new Date(value).toISOString();
}
