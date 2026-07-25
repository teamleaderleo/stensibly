import type { Doc } from "../_generated/dataModel";
import type { QueryContext } from "./domain";

const MAX_PROJECT_ACTIVE_RESERVATIONS = 1_000;
const MAX_RESOURCE_ACTIVE_RESERVATIONS = 1_000;
const MAX_ITEM_RESERVATIONS = 100;

export interface PublicItemReservation {
  id: string;
  resource: string;
  mode: Doc<"reservations">["mode"];
  capacity: number;
  units: number;
  usedUnits: number;
  availableUnits: number;
  holderActorId: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export async function readPublicItemReservations(
  ctx: QueryContext,
  item: Doc<"items">,
  now: number,
): Promise<PublicItemReservation[]> {
  const projectReservations = await ctx.db
    .query("reservations")
    .withIndex("by_project_status", (q) =>
      q
        .eq("projectId", item.projectId)
        .eq("status", "active")
        .gt("expiresAt", now),
    )
    .take(MAX_PROJECT_ACTIVE_RESERVATIONS + 1);
  if (projectReservations.length > MAX_PROJECT_ACTIVE_RESERVATIONS) {
    throw new Error(
      `Project has too many active reservations to read item capacity safely`,
    );
  }

  const itemReservations = projectReservations.filter(
    (reservation) => reservation.itemId === item._id,
  );
  if (itemReservations.length > MAX_ITEM_RESERVATIONS) {
    throw new Error(
      `Item ${item.externalId} has too many active reservations to read safely`,
    );
  }

  const usedByResource = new Map<string, number>();
  await Promise.all([...new Set(itemReservations.map((reservation) => reservation.resource))]
    .map(async (resource) => {
      const active = await ctx.db
        .query("reservations")
        .withIndex("by_resource_status", (q) =>
          q
            .eq("workspaceId", item.workspaceId)
            .eq("resource", resource)
            .eq("status", "active")
            .gt("expiresAt", now),
        )
        .take(MAX_RESOURCE_ACTIVE_RESERVATIONS + 1);
      if (active.length > MAX_RESOURCE_ACTIVE_RESERVATIONS) {
        throw new Error(
          `Resource ${resource} has too many active reservations to aggregate safely`,
        );
      }
      usedByResource.set(
        resource,
        active.reduce((sum, reservation) => sum + reservation.units, 0),
      );
    }));

  return itemReservations
    .sort((left, right) =>
      left.expiresAt - right.expiresAt
      || left.externalId.localeCompare(right.externalId),
    )
    .map((reservation) => {
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
