import { v } from "convex/values";
import { mutation } from "./lib/server";
import {
  requireServiceSecret,
} from "./lib/domain";
import { actorValidator, serviceArgs } from "./lib/validators";
import {
  reserveWorkstationCommandInTransaction,
} from "./workstationCommands";

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
    return reserveWorkstationCommandInTransaction(ctx, args);
  },
});
