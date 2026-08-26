import { defineTable } from "convex/server";
import { v } from "convex/values";

export const applicationLaneBindingTables = {
  applicationLaneBindings: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    externalId: v.string(),
    generation: v.number(),
    provider: v.literal("elatura"),
    laneRef: v.string(),
    laneGeneration: v.number(),
    status: v.union(v.literal("active"), v.literal("retired")),
    bindingJson: v.string(),
    bindingFingerprint: v.string(),
    isCurrent: v.boolean(),
    idempotencyKey: v.string(),
    requestJson: v.string(),
    recordedAt: v.number(),
  })
    .index("by_workspace_id_and_idempotency_key", [
      "workspaceId",
      "idempotencyKey",
    ])
    .index("by_project_id_and_external_id_and_is_current", [
      "projectId",
      "externalId",
      "isCurrent",
    ])
    .index("by_project_id_and_external_id_and_generation", [
      "projectId",
      "externalId",
      "generation",
    ])
    .index("by_item_id_and_status_and_is_current_and_generation", [
      "itemId",
      "status",
      "isCurrent",
      "generation",
    ]),
};
