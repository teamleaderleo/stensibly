export async function publicItemReservations(
  ctx: any,
  item: any,
  workspaceId: any,
) {
  const now = Date.now();
  const itemReservations = await ctx.db
    .query("reservations")
    .withIndex("by_item_status", (q: any) =>
      q.eq("itemId", item._id).eq("status", "active"),
    )
    .collect();
  const live = itemReservations.filter((reservation: any) => reservation.expiresAt > now);
  const resources = [...new Set(live.map((reservation: any) => reservation.resource))];
  const usedByResource = new Map<string, number>();

  await Promise.all(resources.map(async (resource) => {
    const active = await ctx.db
      .query("reservations")
      .withIndex("by_resource_status", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("resource", resource).eq("status", "active"),
      )
      .collect();
    const usedUnits = active
      .filter((reservation: any) => reservation.expiresAt > now)
      .reduce((sum: number, reservation: any) => sum + reservation.units, 0);
    usedByResource.set(resource, usedUnits);
  }));

  return live
    .sort((a: any, b: any) => a.expiresAt - b.expiresAt || a.externalId.localeCompare(b.externalId))
    .map((reservation: any) => {
      const usedUnits = usedByResource.get(reservation.resource) ?? reservation.units;
      return {
        id: reservation.externalId,
        resource: reservation.resource,
        mode: reservation.mode,
        capacity: reservation.capacity,
        units: reservation.units,
        usedUnits,
        availableUnits: Math.max(0, reservation.capacity - usedUnits),
        holderActorId: reservation.holderActorExternalId,
        expiresAt: new Date(reservation.expiresAt).toISOString(),
        createdAt: new Date(reservation.createdAt).toISOString(),
        updatedAt: new Date(reservation.updatedAt).toISOString(),
      };
    });
}
