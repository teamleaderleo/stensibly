import { v } from "convex/values";
import { projectItemControl } from "../src/item-control";
import {
  filterVisibleDependencyEvents,
  readVisibleDependencies,
} from "./lib/dependencyVisibility";
import {
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicArtifact,
  publicEvent,
  publicItem,
  requireServiceSecret,
} from "./lib/domain";
import { readPublicItemRuns } from "./lib/runVisibility";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const MAX_DETAIL_EVENTS = 100;
const MAX_DETAIL_ARTIFACTS = 100;
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
    const [
      eventRows,
      latestClaimEvent,
      latestQueuedEvent,
      latestHandoffEvent,
      artifactRows,
      runs,
      dependencies,
      queuedGroups,
      legacyGroups,
    ] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .order("desc")
        .take(MAX_DETAIL_EVENTS),
      ctx.db
        .query("events")
        .withIndex("by_item_type_created", (q) =>
          q.eq("itemId", item._id).eq("type", "claim.created")
        )
        .order("desc")
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_item_type_created", (q) =>
          q.eq("itemId", item._id).eq("type", "run.queued")
        )
        .order("desc")
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_item_type_created", (q) =>
          q.eq("itemId", item._id).eq("type", "work.handed_off")
        )
        .order("desc")
        .first(),
      ctx.db
        .query("artifacts")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .order("desc")
        .take(MAX_DETAIL_ARTIFACTS),
      readPublicItemRuns(ctx, item),
      readVisibleDependencies(ctx, item),
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
    const visibleEvents = await filterVisibleDependencyEvents(
      ctx,
      item,
      [...eventRows].reverse(),
      dependencies,
    );
    const publicItemValue = await publicItem(ctx, item);
    const controlEvents = [latestClaimEvent, latestQueuedEvent, latestHandoffEvent]
      .filter((event) => event !== null)
      .map((event) => ({
        actorId: event.actorExternalId ?? null,
        type: event.type,
        payload: event.payload,
        createdAt: new Date(event.createdAt).toISOString(),
      }));
    const controlRuns = [
      ...queuedGroups.flat().map((run) => ({
        id: run.externalId,
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
        id: run.externalId,
        actorId: run.actorExternalId,
        leaseOwnerId: run.actorExternalId,
        status: run.status,
        leaseExpiresAt: null,
        lastHeartbeatAt: new Date(run.lastHeartbeatAt).toISOString(),
      })),
    ];

    return {
      item: publicItemValue,
      control: projectItemControl({
        item: publicItemValue,
        now: args.now,
        events: controlEvents,
        runs: controlRuns,
      }),
      events: visibleEvents.map((event) => ({
        ...publicEvent(event),
        itemId: item.externalId,
      })),
      artifacts: [...artifactRows].reverse().map((artifact) => ({
        ...publicArtifact(artifact),
        itemId: item.externalId,
      })),
      runs,
      dependencies,
    };
  },
});
