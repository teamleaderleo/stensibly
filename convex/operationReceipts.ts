import { v } from "convex/values";
import {
  recordedOperationReceipt,
  unknownOperationReceipt,
} from "../src/operation-receipt-contracts";
import {
  assertSlug,
  assertText,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

export const get = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = {
      project: assertSlug(args.project, "Project"),
      idempotencyKey: assertText(args.idempotencyKey, "Idempotency key", 240),
    };
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return unknownOperationReceipt(input);
    const project = await findProject(ctx, workspace._id, input.project);
    if (!project) return unknownOperationReceipt(input);

    const event = await ctx.db
      .query("events")
      .withIndex("by_workspace_idempotency", (q) =>
        q.eq("workspaceId", workspace._id).eq("idempotencyKey", input.idempotencyKey)
      )
      .unique();
    if (!event || event.projectId !== project._id) {
      return unknownOperationReceipt(input);
    }
    const item = await ctx.db.get(event.itemId);
    if (!item || item.projectId !== project._id) {
      return unknownOperationReceipt(input);
    }

    return recordedOperationReceipt(input, {
      eventId: event.externalId,
      itemId: item.externalId,
      actorId: event.actorExternalId ?? null,
      operation: event.type,
      payload: event.payload,
      recordedAt: new Date(event.createdAt).toISOString(),
    });
  },
});
