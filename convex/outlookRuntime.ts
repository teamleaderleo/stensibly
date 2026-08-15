import { v } from "convex/values";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const mailboxBindingPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,255}$/u;
const sealedRefreshTokenPattern = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,8192}$/u;

export const getAuth = query({
  args: {
    ...serviceArgs,
    mailboxBindingId: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const mailboxBindingId = exactMailboxBindingId(args.mailboxBindingId);
    const row = await ctx.db
      .query("outlookRuntimeAuth")
      .withIndex("by_workspace_id_and_mailbox_binding_id", (q) =>
        q.eq("workspaceId", workspace._id)
          .eq("mailboxBindingId", mailboxBindingId),
      )
      .unique();
    return row
      ? {
        mailboxBindingId: row.mailboxBindingId,
        sealedRefreshToken: row.sealedRefreshToken,
        generation: row.generation,
      }
      : null;
  },
});

export const setAuth = mutation({
  args: {
    ...serviceArgs,
    mailboxBindingId: v.string(),
    expectedGeneration: v.union(v.null(), v.number()),
    sealedRefreshToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("OUTLOOK_RUNTIME_WORKSPACE_NOT_FOUND");
    const mailboxBindingId = exactMailboxBindingId(args.mailboxBindingId);
    const sealedRefreshToken = exactSealedRefreshToken(args.sealedRefreshToken);
    if (
      args.expectedGeneration !== null
      && (!Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 1)
    ) {
      throw new RangeError("Outlook auth expected generation is invalid");
    }

    const current = await ctx.db
      .query("outlookRuntimeAuth")
      .withIndex("by_workspace_id_and_mailbox_binding_id", (q) =>
        q.eq("workspaceId", workspace._id)
          .eq("mailboxBindingId", mailboxBindingId),
      )
      .unique();

    if (!current) {
      if (args.expectedGeneration !== null) {
        throw new Error("OUTLOOK_RUNTIME_AUTH_REVISION_CONFLICT");
      }
      const now = Date.now();
      await ctx.db.insert("outlookRuntimeAuth", {
        workspaceId: workspace._id,
        mailboxBindingId,
        sealedRefreshToken,
        generation: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { duplicate: false, generation: 1 };
    }

    if (args.expectedGeneration !== current.generation) {
      throw new Error("OUTLOOK_RUNTIME_AUTH_REVISION_CONFLICT");
    }
    if (current.sealedRefreshToken === sealedRefreshToken) {
      return { duplicate: true, generation: current.generation };
    }

    const generation = current.generation + 1;
    await ctx.db.patch(current._id, {
      sealedRefreshToken,
      generation,
      updatedAt: Date.now(),
    });
    return { duplicate: false, generation };
  },
});

function exactMailboxBindingId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value !== value.trim()
    || !mailboxBindingPattern.test(value)
  ) {
    throw new RangeError("Outlook mailbox binding ID is invalid");
  }
  return value;
}

function exactSealedRefreshToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 8_256
    || !sealedRefreshTokenPattern.test(value)
  ) {
    throw new RangeError("Outlook sealed refresh token is invalid");
  }
  return value;
}
