import { v } from "convex/values";
import {
  assertSlug,
  assertText,
  ensureWorkspace,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const tokenScope = v.union(v.literal("read"), v.literal("write"), v.literal("admin"));

export const register = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    name: v.string(),
    secretHash: v.string(),
    scopes: v.array(tokenScope),
    projects: v.optional(v.array(v.string())),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await ensureWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Failed to create workspace");
    const externalId = assertText(args.id, "Token id", 80);
    const existing = await ctx.db
      .query("apiTokens")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (existing) throw new Error(`Token ${externalId} already exists`);
    const scopes = normalizeScopes(args.scopes);
    const projects = normalizeProjects(args.projects);
    const now = Date.now();
    const id = await ctx.db.insert("apiTokens", {
      workspaceId: workspace._id,
      externalId,
      name: assertText(args.name, "Token name", 160),
      secretHash: assertHash(args.secretHash),
      scopes,
      projects,
      createdAt: now,
    });
    const token = await ctx.db.get("apiTokens", id);
    if (!token) throw new Error("Registered token disappeared");
    return publicToken(token);
  },
});

export const authenticate = query({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const token = await ctx.db
      .query("apiTokens")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.id))
      .unique();
    if (
      !token ||
      token.workspaceId !== workspace._id ||
      token.revokedAt !== undefined ||
      token.secretHash !== assertHash(args.secretHash)
    ) {
      return null;
    }
    return {
      tokenId: token.externalId,
      name: token.name,
      scopes: token.scopes,
      projects: token.projects ?? null,
    };
  },
});

export const list = query({
  args: { ...serviceArgs },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const tokens = await ctx.db
      .query("apiTokens")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspace._id))
      .order("desc")
      .collect();
    return tokens.map(publicToken);
  },
});

export const revoke = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Token ${args.id} does not exist`);
    const token = await ctx.db
      .query("apiTokens")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.id))
      .unique();
    if (!token || token.workspaceId !== workspace._id) {
      throw new Error(`Token ${args.id} does not exist`);
    }
    if (token.revokedAt === undefined) {
      await ctx.db.patch(token._id, { revokedAt: Date.now() });
    }
    const updated = await ctx.db.get("apiTokens", token._id);
    return publicToken(updated ?? token);
  },
});

function normalizeScopes(scopes: Array<"read" | "write" | "admin">) {
  const unique = new Set(scopes);
  if (unique.size === 0) throw new Error("Token requires at least one scope");
  return (["read", "write", "admin"] as const).filter((scope) => unique.has(scope));
}

function normalizeProjects(projects: string[] | undefined): string[] | undefined {
  if (projects === undefined) return undefined;
  return [...new Set(projects.map((project) => assertSlug(project, "Project")))].sort();
}

function assertHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Token secret hash must be a SHA-256 hex digest");
  }
  return normalized;
}

function publicToken(token: any) {
  return {
    id: token.externalId,
    name: token.name,
    scopes: token.scopes,
    projects: token.projects ?? null,
    createdAt: new Date(token.createdAt).toISOString(),
    revokedAt: token.revokedAt === undefined ? null : new Date(token.revokedAt).toISOString(),
  };
}
