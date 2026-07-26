import { v } from "convex/values";
import { projectItemControl } from "../src/item-control";
import {
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicItem,
  requireServiceSecret,
} from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const MAX_CONTROL_EVENTS = 32;
const MAX_RUNS_PER_LIVE_STATUS = 2;
const queuedLiveStatuses = ["queued", "starting", "running", "waiting"] as const;
const legacyLiveStatuses = ["running", "waiting"] as const;

export const get = query({
  args: {
    ...serviceArgs,
    id: v.string(),
    now: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.id);
    const [events, queuedGroups, legacyGroups] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .order("desc")
        .take(MAX_CONTROL_EVENTS),
      Promise.all(queuedLiveStatuses.map(async (status) =>
        await ctx.db
          .query("queuedRuns")
          .withIndex("by_item_status", (q) =>
            q.eq("itemId", item._id).eq("status", status)
          )
          .order("desc")
          .take(MAX_RUNS_PER_LIVE_STATUS)
      )),
      Promise.all(legacyLiveStatuses.map(async (status) =>
        await ctx.db
          .query("runs")
          .withIndex("by_item_status", (q) =>
            q.eq("itemId", item._id).eq("status", status)
          )
          .order("desc")
          .take(MAX_RUNS_PER_LIVE_STATUS)
      )),
    ]);

    return projectItemControl({
      item: await publicItem(ctx, item),
      now: args.now,
      events: events
        .filter((event) => event.type === "claim.created" || event.type === "work.handed_off")
        .map((event) => ({
          actorId: event.actorExternalId ?? null,
          type: event.type,
          payload: event.payload,
          createdAt: new Date(event.createdAt).toISOString(),
        })),
      runs: [
        ...queuedGroups.flat().map((run) => ({
          actorId: run.actorExternalId,
          leaseOwnerId: run.leaseOwnerExternalId ?? null,
          status: run.status,
          leaseExpiresAt: run.leaseExpiresAt === undefined
            ? null
            : new Date(run.leaseExpiresAt).toISOString(),
          lastHeartbeatAt: run.lastHeartbeatAt === undefined
            ? null
            : new Date(run.lastHeartbeatAt).toISOString(),
        })),
        ...legacyGroups.flat().map((run) => ({
          actorId: run.actorExternalId,
          leaseOwnerId: run.actorExternalId,
          status: run.status,
          leaseExpiresAt: null,
          lastHeartbeatAt: new Date(run.lastHeartbeatAt).toISOString(),
        })),
      ],
    });
  },
});
