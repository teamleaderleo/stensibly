import { defineTable } from "convex/server";
import { v } from "convex/values";

const mailboxProvider = v.union(v.literal("gmail"), v.literal("outlook"));
const mailboxCoverage = v.union(v.literal("continuous"), v.literal("unknown"));

export const mailboxIntakeTables = {
  mailboxIntakeBindings: defineTable({
    workspaceId: v.id("workspaces"),
    mailboxBindingId: v.string(),
    provider: mailboxProvider,
    cursorValue: v.string(),
    coverage: mailboxCoverage,
    lastNotificationId: v.optional(v.string()),
    stateJson: v.string(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_id_and_mailbox_binding_id", ["workspaceId", "mailboxBindingId"]),

  mailboxIntakeObservations: defineTable({
    workspaceId: v.id("workspaces"),
    mailboxBindingId: v.string(),
    observationId: v.string(),
    semanticFingerprint: v.string(),
    provider: mailboxProvider,
    eventType: v.string(),
    providerCursor: v.string(),
    observedAt: v.number(),
    receivedAt: v.number(),
    observationJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace_id_and_observation_id", ["workspaceId", "observationId"])
    .index("by_workspace_id_and_mailbox_binding_id_and_received_at", [
      "workspaceId",
      "mailboxBindingId",
      "receivedAt",
    ]),

  mailboxIntakeReconciliations: defineTable({
    workspaceId: v.id("workspaces"),
    mailboxBindingId: v.string(),
    reconciliationId: v.string(),
    requestFingerprint: v.string(),
    previousRevision: v.number(),
    nextRevision: v.number(),
    insertedObservations: v.number(),
    createdAt: v.number(),
  })
    .index("by_workspace_id_and_mailbox_binding_id_and_reconciliation_id", [
      "workspaceId",
      "mailboxBindingId",
      "reconciliationId",
    ]),
};
