import { defineTable } from "convex/server";
import { v } from "convex/values";

export const orchestratorActivityTables = {
  orchestratorActivityDeliveries: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    deliveryId: v.string(),
    deliveryFingerprint: v.string(),
    requestFingerprint: v.string(),
    observationId: v.string(),
    observationFingerprint: v.string(),
    receiptJson: v.string(),
    observationJson: v.string(),
    acceptedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_project_delivery", ["projectId", "deliveryId"])
    .index("by_project_accepted", ["projectId", "acceptedAt", "deliveryId"]),

  orchestratorActivityObservations: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    observationId: v.string(),
    observationFingerprint: v.string(),
    sourceClass: v.string(),
    sourceId: v.string(),
    observationJson: v.string(),
    appendOrder: v.number(),
    firstAcceptedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_project_observation", ["projectId", "observationId"])
    .index("by_project_source", ["projectId", "sourceClass", "sourceId"])
    .index("by_project_append_order", ["projectId", "appendOrder"]),
};
