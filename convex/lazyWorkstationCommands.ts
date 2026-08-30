import { v } from "convex/values";
import { mutation } from "./lib/server";
import {
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { actorValidator, serviceArgs } from "./lib/validators";
import {
  normalizeInput,
  reserveRunnerAdapterCommandInTransaction,
} from "./runnerAdapterCommands";

export const reserve = mutation({
  args: {
    ...serviceArgs,
    itemClaimGeneration: v.number(),
    authorityHolderId: v.string(),
    authorityExpiresAt: v.string(),
    project: v.string(),
    itemId: v.string(),
    runId: v.string(),
    runGeneration: v.number(),
    leaseGeneration: v.number(),
    actor: actorValidator,
    adapterId: v.string(),
    profileId: v.string(),
    profileVersion: v.union(v.string(), v.null()),
    requestFingerprint: v.string(),
    commandId: v.string(),
    commandFingerprint: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Lazy workstation workspace does not exist");
    const reservation = normalizeInput(args);
    const replay = await ctx.db
      .query("runnerAdapterCommands")
      .withIndex("by_workspace_id_and_idempotency_key", (q) =>
        q.eq("workspaceId", workspace._id).eq("idempotencyKey", reservation.idempotencyKey)
      )
      .unique();
    if (replay) {
      return reserveRunnerAdapterCommandInTransaction(ctx, workspaceSlug, reservation);
    }
    const project = await findProject(ctx, workspace._id, args.project);
    const item = await getItemByExternalId(ctx, workspace._id, args.itemId);
    const expiresAt = exactTimestamp(args.authorityExpiresAt);
    if (
      !project
      || !item
      || item.projectId !== project._id
      || item.status !== "active"
      || item.claimGeneration !== nonNegativeInteger(args.itemClaimGeneration)
      || item.claimedByExternalId !== args.authorityHolderId
      || item.claimExpiresAt !== expiresAt
      || args.actor.id !== args.authorityHolderId
      || expiresAt <= Date.now()
    ) {
      throw new Error("Lazy workstation item claim generation or authority changed before reservation");
    }
    return reserveRunnerAdapterCommandInTransaction(
      ctx,
      workspaceSlug,
      reservation,
    );
  },
});

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Lazy workstation item claim generation is invalid");
  }
  return value;
}

function exactTimestamp(value: string): number {
  if (typeof value !== "string") throw new Error("Lazy workstation authority expiry is invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Lazy workstation authority expiry is invalid");
  }
  return parsed;
}
