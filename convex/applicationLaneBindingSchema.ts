import { defineTable } from "convex/server";
import { v } from "convex/values";

export const applicationLaneBindingTables = {
  applicationLaneBindings: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    itemExternalId: v.string(),
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
    .index("by_project_current_item_binding", [
      "projectId",
      "status",
      "isCurrent",
      "itemExternalId",
      "externalId",
      "generation",
    ])
    .index("by_item_id_and_status_and_is_current_and_generation", [
      "itemId",
      "status",
      "isCurrent",
      "generation",
    ]),

  applicationLaneWakeIntents: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    itemExternalId: v.string(),
    requestKey: v.string(),
    requestJson: v.string(),
    sourceRef: v.string(),
    wakeFingerprint: v.string(),
    wakeJson: v.string(),
    registrationId: v.string(),
    registrationGeneration: v.number(),
    claimGeneration: v.number(),
    bindingId: v.string(),
    bindingGeneration: v.number(),
    laneRef: v.string(),
    laneGeneration: v.number(),
    sourceEventId: v.string(),
    observedAt: v.number(),
    recordedAt: v.number(),
  })
    .index("by_workspace_request_key", ["workspaceId", "requestKey"])
    .index("by_workspace_source_ref", ["workspaceId", "sourceRef"])
    .index("by_item_claim_generation", ["itemId", "claimGeneration", "recordedAt"]),

  applicationLaneTriggerConsumptions: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    itemExternalId: v.string(),
    triggerIdempotencyKey: v.string(),
    triggerFingerprint: v.string(),
    sourceRef: v.string(),
    sourceFingerprint: v.string(),
    expectedClaimGeneration: v.number(),
    claimedGeneration: v.number(),
    runId: v.id("queuedRuns"),
    runExternalId: v.string(),
    receiptJson: v.string(),
    receiptFingerprint: v.string(),
    consumedAt: v.number(),
  })
    .index("by_workspace_trigger_key", ["workspaceId", "triggerIdempotencyKey"])
    .index("by_workspace_source_ref", ["workspaceId", "sourceRef"])
    .index("by_run_id", ["runId"]),
};
