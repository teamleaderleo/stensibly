import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
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
  type ReservationInput,
} from "./runnerAdapterCommands";

export const reserve = mutation({
  args: {
    ...serviceArgs,
    ...workstationReservationArgs(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    return reserveWorkstationCommandInTransaction(ctx, args);
  },
});

export async function reserveWorkstationCommandInTransaction(
  ctx: MutationCtx,
  args: WorkstationReservationArgs,
) {
  const workspaceSlug = normalizeWorkspace(args.workspace);
  const workspace = await findWorkspace(ctx, workspaceSlug);
  if (!workspace) throw new Error("Workstation workspace does not exist");
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
    throw new Error(
      "Workstation item claim generation or authority changed before reservation",
    );
  }
  return reserveRunnerAdapterCommandInTransaction(ctx, workspaceSlug, reservation);
}

export function workstationReservationArgs() {
  return {
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
  } as const;
}

export type WorkstationReservationArgs = ReservationInput & {
  workspace?: string;
  itemClaimGeneration: number;
  authorityHolderId: string;
  authorityExpiresAt: string;
};

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Workstation item claim generation is invalid");
  }
  return value;
}

function exactTimestamp(value: string): number {
  if (typeof value !== "string") throw new Error("Workstation authority expiry is invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Workstation authority expiry is invalid");
  }
  return parsed;
}
