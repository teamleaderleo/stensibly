import { v } from "convex/values";
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

export const MAX_ITEM_DETAIL_EVENTS = 500;
export const MAX_ITEM_DETAIL_ARTIFACTS = 100;

export const get = query({
  args: { ...serviceArgs, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.id);
    const [recentEvents, recentArtifacts, runs, dependencies] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .order("desc")
        .take(MAX_ITEM_DETAIL_EVENTS),
      ctx.db
        .query("artifacts")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .order("desc")
        .take(MAX_ITEM_DETAIL_ARTIFACTS),
      readPublicItemRuns(ctx, item),
      readVisibleDependencies(ctx, item),
    ]);
    const visibleEvents = await filterVisibleDependencyEvents(
      ctx,
      item,
      recentEvents,
      dependencies,
    );

    return {
      item: await publicItem(ctx, item),
      events: visibleEvents.reverse().map((event) => ({
        ...publicEvent(event),
        itemId: item.externalId,
      })),
      artifacts: recentArtifacts.reverse().map((artifact) => ({
        ...publicArtifact(artifact),
        itemId: item.externalId,
      })),
      runs,
      dependencies,
    };
  },
});
