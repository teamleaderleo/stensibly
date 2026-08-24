import { v } from "convex/values";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;
const maximumEtagBytes = 1024;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;

export const get = query({
  args: {
    ...serviceArgs,
    repository: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const repository = exactRepository(args.repository);
    const row = await ctx.db
      .query("githubPublicEventsPollStates")
      .withIndex("by_workspace_repository", (q) =>
        q.eq("workspaceId", workspace._id).eq("repository", repository),
      )
      .unique();
    if (!row) return null;
    return publicState(row);
  },
});

export const put = mutation({
  args: {
    ...serviceArgs,
    repository: v.string(),
    etag: v.union(v.string(), v.null()),
    nextEligibleAt: v.number(),
    lastPolledAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) {
      throw new Error("GITHUB_PUBLIC_EVENTS_POLL_STATE_WORKSPACE_NOT_FOUND");
    }
    const repository = exactRepository(args.repository);
    const etag = exactEtag(args.etag);
    const nextEligibleAt = exactTimestamp(
      args.nextEligibleAt,
      "GitHub public Events poll next eligibility",
    );
    const lastPolledAt = args.lastPolledAt === null
      ? null
      : exactTimestamp(
        args.lastPolledAt,
        "GitHub public Events poll last receipt time",
      );
    const existing = await ctx.db
      .query("githubPublicEventsPollStates")
      .withIndex("by_workspace_repository", (q) =>
        q.eq("workspaceId", workspace._id).eq("repository", repository),
      )
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch("githubPublicEventsPollStates", existing._id, {
        etag,
        nextEligibleAt,
        lastPolledAt,
        updatedAt,
      });
      const stored = await ctx.db.get("githubPublicEventsPollStates", existing._id);
      if (!stored) throw new Error("GITHUB_PUBLIC_EVENTS_POLL_STATE_MISSING");
      return publicState(stored);
    }
    const id = await ctx.db.insert("githubPublicEventsPollStates", {
      workspaceId: workspace._id,
      repository,
      etag,
      nextEligibleAt,
      lastPolledAt,
      updatedAt,
    });
    const stored = await ctx.db.get("githubPublicEventsPollStates", id);
    if (!stored) throw new Error("GITHUB_PUBLIC_EVENTS_POLL_STATE_MISSING");
    return publicState(stored);
  },
});

function publicState(row: {
  repository: string;
  etag: string | null;
  nextEligibleAt: number;
  lastPolledAt: number | null;
  updatedAt: number;
}) {
  return {
    repository: row.repository,
    etag: row.etag,
    nextEligibleAt: row.nextEligibleAt,
    lastPolledAt: row.lastPolledAt,
    updatedAt: row.updatedAt,
  };
}

function exactRepository(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || value !== value.trim()
    || !repositoryPattern.test(value)
  ) {
    throw new RangeError("GitHub repository is invalid");
  }
  return value;
}

function exactEtag(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).byteLength > maximumEtagBytes
    || controlCharacterPattern.test(value)
  ) {
    throw new RangeError("GitHub public Events ETag is invalid");
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}
