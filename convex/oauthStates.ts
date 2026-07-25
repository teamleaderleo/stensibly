import { v } from "convex/values";
import {
  assertText,
  ensureWorkspace,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const MAX_STATE_LIFETIME_MS = 15 * 60 * 1000;

const publicStateValidator = v.object({
  id: v.string(),
  returnTo: v.string(),
  createdAt: v.string(),
  expiresAt: v.string(),
  consumedAt: v.union(v.string(), v.null()),
});

export const create = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
    pkceVerifierHash: v.string(),
    returnTo: v.string(),
    expiresAt: v.number(),
  },
  returns: publicStateValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await ensureWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Failed to create workspace");

    const externalId = assertStateId(args.id);
    const now = Date.now();
    const expired = await ctx.db
      .query("oauthStates")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", now))
      .take(100);
    for (const state of expired) await ctx.db.delete(state._id);

    const existing = await ctx.db
      .query("oauthStates")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (existing) throw new Error(`OAuth state ${externalId} already exists`);

    const expiresAt = assertExpiry(args.expiresAt, now);
    const id = await ctx.db.insert("oauthStates", {
      workspaceId: workspace._id,
      externalId,
      secretHash: assertHash(args.secretHash),
      pkceVerifierHash: assertHash(args.pkceVerifierHash),
      returnTo: assertReturnTo(args.returnTo),
      createdAt: now,
      expiresAt,
    });
    const state = await ctx.db.get("oauthStates", id);
    if (!state) throw new Error("Created OAuth state disappeared");
    return publicState(state);
  },
});

export const consume = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    secretHash: v.string(),
    pkceVerifierHash: v.string(),
  },
  returns: v.union(publicStateValidator, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;

    const externalId = readStateId(args.id);
    const hash = readHash(args.secretHash);
    const pkceVerifierHash = readHash(args.pkceVerifierHash);
    if (!externalId || !hash || !pkceVerifierHash) return null;
    const state = await ctx.db
      .query("oauthStates")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    const now = Date.now();
    if (!state || state.workspaceId !== workspace._id) return null;
    if (state.expiresAt <= now) {
      await ctx.db.delete(state._id);
      return null;
    }
    if (state.secretHash !== hash || state.pkceVerifierHash !== pkceVerifierHash) {
      return null;
    }

    await ctx.db.delete(state._id);
    return publicState(state, now);
  },
});

function assertStateId(value: string): string {
  const normalized = readStateId(value);
  if (!normalized) throw new Error("OAuth state id is invalid");
  return normalized;
}

function readStateId(value: string): string | null {
  const normalized = value.trim();
  return /^oauth_[A-Za-z0-9_-]{12,80}$/.test(normalized) ? normalized : null;
}

function assertHash(value: string): string {
  const hash = readHash(value);
  if (!hash) throw new Error("OAuth state secret hash must be a SHA-256 hex digest");
  return hash;
}

function readHash(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function assertExpiry(value: number, now: number): number {
  if (!Number.isFinite(value) || value <= now || value > now + MAX_STATE_LIFETIME_MS) {
    throw new Error("OAuth state expiry must be in the future and no more than 15 minutes away");
  }
  return Math.floor(value);
}

function assertReturnTo(value: string): string {
  const normalized = assertText(value, "OAuth return destination", 2048);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("OAuth return destination is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("OAuth return destination must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OAuth return destination cannot contain credentials");
  }
  return parsed.toString();
}

function publicState(
  state: { externalId: string; returnTo: string; createdAt: number; expiresAt: number },
  consumedAt?: number,
) {
  return {
    id: state.externalId,
    returnTo: state.returnTo,
    createdAt: new Date(state.createdAt).toISOString(),
    expiresAt: new Date(state.expiresAt).toISOString(),
    consumedAt: consumedAt === undefined ? null : new Date(consumedAt).toISOString(),
  };
}
