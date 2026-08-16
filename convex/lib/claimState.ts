import { persistClaimActivity } from "./claimActivity";
import { appendEvent, type MutationContext } from "./domain";

export async function expireClaimIfNeeded(
  ctx: MutationContext,
  item: any,
  now = Date.now(),
) {
  if (
    item.status !== "active" ||
    item.claimedByActorId === undefined ||
    item.claimExpiresAt === undefined ||
    item.claimExpiresAt > now
  ) {
    return item;
  }

  const previousClaimant = item.claimedByExternalId;
  const expiredAt = item.claimExpiresAt;
  const expiredGeneration = item.claimGeneration;
  const patch = {
    status: "ready" as const,
    claimedByActorId: undefined,
    claimedByExternalId: undefined,
    claimExpiresAt: undefined,
    claimGeneration: expiredGeneration + 1,
    version: item.version + 1,
    updatedAt: now,
  };
  await ctx.db.patch(item._id, patch);
  const claimEvent = await appendEvent(ctx, {
    workspaceId: item.workspaceId,
    projectId: item.projectId,
    itemId: item._id,
    type: "claim.expired",
    payload: { previousClaimant, expiredAt: new Date(expiredAt).toISOString() },
    createdAt: now,
  });
  await persistClaimActivity(ctx, {
    item,
    claimEvent,
    actorExternalId: previousClaimant ?? "system:claim-expiry",
    activityClass: "progress_evidence",
    activityState: "stale",
    responsibilityGeneration: expiredGeneration,
  });
  return { ...item, ...patch };
}

export function liveClaimHeldByOther(item: any, actorExternalId: string, now = Date.now()): boolean {
  return Boolean(
    item.claimedByActorId !== undefined &&
      item.claimExpiresAt !== undefined &&
      item.claimExpiresAt > now &&
      item.claimedByExternalId !== actorExternalId,
  );
}
