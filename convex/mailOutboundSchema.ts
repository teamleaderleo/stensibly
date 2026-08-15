import { defineTable } from "convex/server";
import { v } from "convex/values";

const deliveryState = v.union(
  v.literal("reserved"),
  v.literal("sent"),
  v.literal("ambiguous"),
  v.literal("failed"),
  v.literal("reconciled"),
);

export const mailOutboundTables = {
  mailOutboundThreads: defineTable({
    workspaceId: v.id("workspaces"),
    threadId: v.string(),
    handle: v.string(),
    project: v.string(),
    sourceIdentity: v.string(),
    threadJson: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_thread_id", ["workspaceId", "threadId"])
    .index("by_workspace_handle", ["workspaceId", "handle"])
    .index("by_workspace_project_source", ["workspaceId", "project", "sourceIdentity"]),

  mailOutboundProviderProjections: defineTable({
    workspaceId: v.id("workspaces"),
    threadId: v.string(),
    provider: v.string(),
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    providerThreadId: v.string(),
    projectionJson: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_thread_provider_account", [
    "workspaceId",
    "threadId",
    "provider",
    "accountBinding",
  ]),

  mailOutboundEffects: defineTable({
    workspaceId: v.id("workspaces"),
    outboundEffectId: v.string(),
    threadId: v.string(),
    provider: v.string(),
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    contentFingerprint: v.string(),
    attemptNumber: v.number(),
    state: deliveryState,
    effectJson: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_effect_id", ["workspaceId", "outboundEffectId"])
    .index("by_workspace_thread_provider_account_created", [
      "workspaceId",
      "threadId",
      "provider",
      "accountBinding",
      "createdAt",
    ])
    .index("by_workspace_material_attempt", [
      "workspaceId",
      "threadId",
      "provider",
      "accountBinding",
      "contentFingerprint",
      "attemptNumber",
    ]),

  mailOutboundDeliveryLanes: defineTable({
    workspaceId: v.id("workspaces"),
    threadId: v.string(),
    provider: v.string(),
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    outboundEffectId: v.string(),
    state: v.union(v.literal("reserved"), v.literal("ambiguous")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_thread_provider_account", [
      "workspaceId",
      "threadId",
      "provider",
      "accountBinding",
    ])
    .index("by_workspace_effect_id", ["workspaceId", "outboundEffectId"]),

  mailOutboundProviderMessages: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.string(),
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    providerMessageId: v.string(),
    outboundEffectId: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace_provider_account_message", [
      "workspaceId",
      "provider",
      "accountBinding",
      "providerMessageId",
    ])
    .index("by_workspace_effect_id", ["workspaceId", "outboundEffectId"]),
};
