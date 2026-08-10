import { defineTable } from "convex/server";
import { v } from "convex/values";

const callsignLeaseStatus = v.union(
  v.literal("active"),
  v.literal("released"),
  v.literal("expired"),
);

const callsignLeaseOperation = v.union(
  v.literal("reserve"),
  v.literal("renew"),
  v.literal("release"),
);

export const callsignLeaseTables = {
  callsignLeases: defineTable({
    workspaceId: v.id("workspaces"),
    externalId: v.string(),
    callsign: v.string(),
    collisionKey: v.string(),
    workerSessionId: v.string(),
    runId: v.string(),
    generation: v.number(),
    status: callsignLeaseStatus,
    reservationRequestId: v.string(),
    reservationFingerprint: v.string(),
    acceptedAt: v.number(),
    expiresAt: v.number(),
    lastHeartbeatAt: v.number(),
    releasedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_external", ["workspaceId", "externalId"])
    .index("by_workspace_collision_status", ["workspaceId", "collisionKey", "status"])
    .index("by_workspace_collision_generation", ["workspaceId", "collisionKey", "generation"])
    .index("by_workspace_session_status", ["workspaceId", "workerSessionId", "status"])
    .index("by_workspace_status_expiry", ["workspaceId", "status", "expiresAt"]),

  callsignLeaseCommands: defineTable({
    workspaceId: v.id("workspaces"),
    idempotencyKey: v.string(),
    operation: callsignLeaseOperation,
    request: v.any(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"]),
} as const;
