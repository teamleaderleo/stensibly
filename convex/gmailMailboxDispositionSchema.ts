import { defineTable } from "convex/server";
import { v } from "convex/values";

const dispositionStatus = v.union(
  v.literal("reserved"),
  v.literal("reconciliation_required"),
  v.literal("settled"),
);

const reconciliationPhase = v.union(
  v.null(),
  v.literal("interrupted"),
  v.literal("precondition_read"),
  v.literal("mutation_outcome"),
  v.literal("post_mutation_readback"),
);

const settledOutcome = v.union(
  v.null(),
  v.literal("applied"),
  v.literal("noop"),
  v.literal("ignored_draft"),
  v.literal("reconciled"),
);

export const gmailMailboxDispositionTables = {
  gmailMailboxDispositionStates: defineTable({
    workspaceId: v.id("workspaces"),
    stnThreadId: v.string(),
    revision: v.string(),
    stateJson: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_id_and_stn_thread_id", ["workspaceId", "stnThreadId"]),

  gmailMailboxDispositionTargets: defineTable({
    workspaceId: v.id("workspaces"),
    stnThreadId: v.string(),
    provider: v.literal("gmail"),
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    providerThreadId: v.string(),
    providerMessageId: v.string(),
    attemptedAt: v.string(),
    receiptJson: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_id_and_stn_thread_id", ["workspaceId", "stnThreadId"]),

  gmailMailboxDispositionEffects: defineTable({
    workspaceId: v.id("workspaces"),
    effectId: v.string(),
    stnThreadId: v.string(),
    provider: v.literal("gmail"),
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    providerThreadId: v.string(),
    providerMessageId: v.string(),
    stateRevision: v.string(),
    status: dispositionStatus,
    reconciliationPhase,
    settledOutcome,
    effectJson: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_id_and_effect_id", ["workspaceId", "effectId"])
    .index("by_workspace_id_and_stn_thread_id_and_state_revision", [
      "workspaceId",
      "stnThreadId",
      "stateRevision",
    ]),

  gmailMailboxDispositionLanes: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.literal("gmail"),
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    providerThreadId: v.string(),
    providerMessageId: v.string(),
    effectId: v.string(),
    status: v.union(v.literal("reserved"), v.literal("reconciliation_required")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_provider_account_binding_mailbox_thread_message", [
      "workspaceId",
      "provider",
      "accountBinding",
      "mailboxAddress",
      "providerThreadId",
      "providerMessageId",
    ])
    .index("by_workspace_id_and_effect_id", ["workspaceId", "effectId"]),
};
