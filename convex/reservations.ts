import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  appendEvent,
  assertLeaseSeconds,
  assertSlug,
  assertText,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { internalMutation, mutation, query } from "./lib/server";
import {
  actorValidator,
  reservationModeValidator,
  serviceArgs,
} from "./lib/validators";

const expireReservationRef = makeFunctionReference<"mutation">("reservations:expireScheduled");

export const acquire = mutation({
  args: {
    ...serviceArgs,
    resource: v.string(),
    mode: reservationModeValidator,
    capacity: v.number(),
    units: v.number(),
    leaseSeconds: v.number(),
    actor: actorValidator,
    project: v.optional(v.string()),
    itemId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Workspace does not exist");
    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const resource = assertText(args.resource, "Resource", 500);
    const capacity = positiveInteger(args.capacity, "Capacity");
    const units = positiveInteger(args.units, "Units");
    if (units > capacity) throw new Error("Reservation units cannot exceed capacity");
    if (args.mode === "exclusive" && (capacity !== 1 || units !== 1)) {
      throw new Error("Exclusive reservations use capacity 1 and units 1");
    }
    const leaseSeconds = assertLeaseSeconds(args.leaseSeconds);
    const now = Date.now();

    const active = await ctx.db
      .query("reservations")
      .withIndex("by_resource_status", (q) =>
        q.eq("workspaceId", workspace._id).eq("resource", resource).eq("status", "active"),
      )
      .collect();
    const live = [];
    for (const reservation of active) {
      if (reservation.expiresAt <= now) {
        await expireReservation(ctx, reservation, now);
      } else {
        live.push(reservation);
      }
    }

    if (args.mode === "exclusive" && live.length > 0) {
      throw new Error("Resource already has an active reservation");
    }
    if (args.mode === "shared") {
      if (live.some((reservation) => reservation.mode === "exclusive")) {
        throw new Error("Resource is held exclusively");
      }
      if (live.some((reservation) => reservation.capacity !== capacity)) {
        throw new Error("Shared reservations must agree on resource capacity");
      }
      const used = live.reduce((sum, reservation) => sum + reservation.units, 0);
      if (used + units > capacity) throw new Error("Resource capacity is exhausted");
    }

    const project = args.project
      ? await findProject(ctx, workspace._id, assertSlug(args.project, "Project"))
      : null;
    if (args.project && !project) throw new Error(`Project ${args.project} does not exist`);
    const item = args.itemId
      ? await getItemByExternalId(ctx, workspace._id, args.itemId)
      : null;
    if (item && project && item.projectId !== project._id) {
      throw new Error("Reservation item does not belong to the selected project");
    }

    const expiresAt = now + leaseSeconds * 1_000;
    const reservationId = await ctx.db.insert("reservations", {
      workspaceId: workspace._id,
      projectId: project?._id ?? item?.projectId,
      itemId: item?._id,
      externalId: "pending",
      resource,
      mode: args.mode,
      capacity,
      units,
      holderActorId: actor._id,
      holderActorExternalId: actor.externalId,
      status: "active",
      generation: 1,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    const externalId = `res_${reservationId}`;
    await ctx.db.patch(reservationId, { externalId });
    await ctx.scheduler.runAt(expiresAt, expireReservationRef, {
      reservationId,
      generation: 1,
    });
    if (item) {
      await appendEvent(ctx, {
        workspaceId: workspace._id,
        projectId: item.projectId,
        itemId: item._id,
        actorId: actor._id,
        actorExternalId: actor.externalId,
        type: "reservation.acquired",
        payload: { reservationId: externalId, resource, mode: args.mode, units, capacity },
        createdAt: now,
      });
    }
    const reservation = await ctx.db.get("reservations", reservationId);
    if (!reservation) throw new Error("Reservation disappeared");
    return publicReservation(reservation);
  },
});

export const release = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actorId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Reservation ${args.id} does not exist`);
    const reservation = await ctx.db
      .query("reservations")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.id))
      .unique();
    if (!reservation || reservation.workspaceId !== workspace._id) {
      throw new Error(`Reservation ${args.id} does not exist`);
    }
    if (reservation.holderActorExternalId !== args.actorId) {
      throw new Error("Only the reservation holder can release it");
    }
    if (reservation.status !== "active") return publicReservation(reservation);
    const now = Date.now();
    await ctx.db.patch(reservation._id, {
      status: "released",
      generation: reservation.generation + 1,
      updatedAt: now,
    });
    if (reservation.itemId) {
      await appendEvent(ctx, {
        workspaceId: reservation.workspaceId,
        projectId: reservation.projectId!,
        itemId: reservation.itemId,
        actorId: reservation.holderActorId,
        actorExternalId: reservation.holderActorExternalId,
        type: "reservation.released",
        payload: { reservationId: reservation.externalId, resource: reservation.resource },
        createdAt: now,
      });
    }
    const updated = await ctx.db.get("reservations", reservation._id);
    return publicReservation(updated ?? reservation);
  },
});

export const listActive = query({
  args: {
    ...serviceArgs,
    resource: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 500);
    const now = Date.now();
    const reservations = args.resource
      ? await ctx.db
          .query("reservations")
          .withIndex("by_resource_status", (q) =>
            q
              .eq("workspaceId", workspace._id)
              .eq("resource", assertText(args.resource!, "Resource", 500))
              .eq("status", "active"),
          )
          .collect()
      : await ctx.db
          .query("reservations")
          .withIndex("by_workspace_status", (q) =>
            q.eq("workspaceId", workspace._id).eq("status", "active"),
          )
          .collect();
    return reservations
      .filter((reservation) => reservation.expiresAt > now)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, limit)
      .map(publicReservation);
  },
});

export const expireScheduled = internalMutation({
  args: {
    reservationId: v.id("reservations"),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const reservation = await ctx.db.get("reservations", args.reservationId);
    if (
      !reservation ||
      reservation.status !== "active" ||
      reservation.generation !== args.generation ||
      reservation.expiresAt > Date.now()
    ) {
      return null;
    }
    await expireReservation(ctx, reservation, Date.now());
    return null;
  },
});

async function expireReservation(ctx: any, reservation: any, now: number) {
  await ctx.db.patch(reservation._id, {
    status: "expired",
    generation: reservation.generation + 1,
    updatedAt: now,
  });
  if (reservation.itemId) {
    await appendEvent(ctx, {
      workspaceId: reservation.workspaceId,
      projectId: reservation.projectId,
      itemId: reservation.itemId,
      type: "reservation.expired",
      payload: { reservationId: reservation.externalId, resource: reservation.resource },
      createdAt: now,
    });
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function publicReservation(reservation: any) {
  return {
    id: reservation.externalId,
    resource: reservation.resource,
    mode: reservation.mode,
    capacity: reservation.capacity,
    units: reservation.units,
    holderActorId: reservation.holderActorExternalId,
    status: reservation.status,
    expiresAt: new Date(reservation.expiresAt).toISOString(),
    createdAt: new Date(reservation.createdAt).toISOString(),
    updatedAt: new Date(reservation.updatedAt).toISOString(),
  };
}
