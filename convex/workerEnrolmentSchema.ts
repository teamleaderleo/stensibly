import { defineTable } from "convex/server";
import { v } from "convex/values";

const workerEnrolmentStatus = v.union(
  v.literal("active"),
  v.literal("released"),
  v.literal("expired"),
);

const workerEnrolmentOperation = v.union(
  v.literal("enrol"),
  v.literal("heartbeat"),
  v.literal("release"),
);

const workResponsibilityRole = v.union(
  v.literal("general"),
  v.literal("implementation"),
  v.literal("independent_review"),
);

export const workerEnrolmentTables = {
  workerEnrolments: defineTable({
    workspaceId: v.id("workspaces"),
    externalId: v.string(),
    actorId: v.string(),
    clientId: v.string(),
    oauthAccountId: v.optional(v.string()),
    adapter: v.string(),
    profile: v.string(),
    workerSessionId: v.string(),
    capabilities: v.array(v.string()),
    toolAllowlist: v.array(v.string()),
    projectScope: v.array(v.string()),
    preferredStances: v.array(v.string()),
    startedAt: v.number(),
    expiresAt: v.number(),
    heartbeatSeconds: v.number(),
    correlationId: v.optional(v.string()),
    causationId: v.optional(v.string()),
    requestFingerprint: v.string(),
    status: workerEnrolmentStatus,
    callsign: v.optional(v.string()),
    callsignLeaseId: v.optional(v.id("callsignLeases")),
    callsignLeaseGeneration: v.optional(v.number()),
    acceptedAt: v.number(),
    lastHeartbeatAt: v.number(),
    releasedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_external", ["workspaceId", "externalId"])
    .index("by_workspace_owner_session_status", [
      "workspaceId",
      "actorId",
      "clientId",
      "workerSessionId",
      "status",
    ])
    .index("by_workspace_owner_status", ["workspaceId", "actorId", "clientId", "status"])
    .index("by_workspace_status_expiry", ["workspaceId", "status", "expiresAt"]),

  workerEnrolmentCommands: defineTable({
    workspaceId: v.id("workspaces"),
    actorId: v.string(),
    clientId: v.string(),
    idempotencyKey: v.string(),
    operation: workerEnrolmentOperation,
    request: v.any(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_workspace_owner_idempotency", [
    "workspaceId",
    "actorId",
    "clientId",
    "idempotencyKey",
  ]),

  workSelectionAcceptances: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    workerEnrolmentId: v.id("workerEnrolments"),
    externalId: v.string(),
    workerRef: v.string(),
    actorId: v.string(),
    clientId: v.string(),
    recommendationFingerprint: v.string(),
    selectedItemVersion: v.number(),
    selectedClaimGeneration: v.number(),
    responsibilityRole: workResponsibilityRole,
    independenceKey: v.optional(v.string()),
    acceptedClaimGeneration: v.number(),
    claimExpiresAt: v.number(),
    acceptedAt: v.number(),
    grantsResponsibility: v.literal(true),
    grantsAuthority: v.literal(false),
  })
    .index("by_workspace_external", ["workspaceId", "externalId"])
    .index("by_workspace_worker_accepted", ["workspaceId", "workerRef", "acceptedAt"])
    .index("by_workspace_independence_role", [
      "workspaceId",
      "independenceKey",
      "responsibilityRole",
      "acceptedAt",
    ])
    .index("by_item_accepted", ["itemId", "acceptedAt"]),

  workSelectionCommands: defineTable({
    workspaceId: v.id("workspaces"),
    actorId: v.string(),
    clientId: v.string(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    request: v.any(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_workspace_owner_idempotency", [
    "workspaceId",
    "actorId",
    "clientId",
    "idempotencyKey",
  ]),
} as const;
