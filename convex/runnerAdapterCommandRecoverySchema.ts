import { defineTable } from "convex/server";
import { v } from "convex/values";
import { mailboxIntakeTables } from "./mailboxIntakeSchema";
import { mailOutboundTables } from "./mailOutboundSchema";
import { mailSemanticAdmissionTables } from "./mailSemanticAdmissionSchema";

export const runnerAdapterCommandRecoveryTables = {
  ...mailboxIntakeTables,
  ...mailSemanticAdmissionTables,
  ...mailOutboundTables,
  runnerAdapterCommandRecoveries: defineTable({
    workspaceId: v.id("workspaces"),
    commandId: v.id("runnerAdapterCommands"),
    commandExternalId: v.string(),
    recoveryGeneration: v.number(),
    actorId: v.id("actors"),
    actorExternalId: v.string(),
    idempotencyKey: v.string(),
    request: v.any(),
    claim: v.any(),
    claimedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_workspace_id_and_idempotency_key", ["workspaceId", "idempotencyKey"])
    .index("by_command_id_and_recovery_generation", ["commandId", "recoveryGeneration"]),
};
