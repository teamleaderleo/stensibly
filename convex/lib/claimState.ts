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
  const patch = {
    status: "ready" as const,
    claimedByActorId: undefined,
    claimedByExternalId: undefined,
    claimExpiresAt: undefined,
    claimGeneration: item.claimGeneration + 1,
    version: item.version + 1,
    updatedAt: now,
  };
  await ctx.db.patch(item._id, patch);
  await appendEvent(ctx, {
    workspaceId: item.workspaceId,
    projectId: item.projectId,
    itemId: item._id,
    type: "claim.expired",
    payload: { previousClaimant, expiredAt: new Date(expiredAt).toISOString() },
    createdAt: now,
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
