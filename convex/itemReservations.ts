import { v } from "convex/values";
import {
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { readPublicItemReservations } from "./lib/reservationVisibility";
import { query } from "./lib/server";
import { reservationModeValidator, serviceArgs } from "./lib/validators";

const itemReservationValidator = v.object({
  id: v.string(),
  resource: v.string(),
  mode: reservationModeValidator,
  capacity: v.number(),
  units: v.number(),
  usedUnits: v.number(),
  availableUnits: v.number(),
  holderActorId: v.string(),
  expiresAt: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export const list = query({
  args: {
    ...serviceArgs,
    itemId: v.string(),
    now: v.number(),
  },
  returns: v.array(itemReservationValidator),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const now = normalizeTimestamp(args.now);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.itemId} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.itemId);
    return await readPublicItemReservations(ctx, item, now);
  },
});

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 8.64e15) {
    throw new Error("Reservation visibility time must be a valid Unix timestamp in milliseconds");
  }
  return value;
}
