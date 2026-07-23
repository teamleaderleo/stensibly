import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const actorKind = v.union(
  v.literal("human"),
  v.literal("agent"),
  v.literal("service"),
);

const itemKind = v.union(
  v.literal("task"),
  v.literal("finding"),
  v.literal("question"),
  v.literal("decision"),
  v.literal("tip"),
  v.literal("handoff"),
  v.literal("note"),
);

const itemStatus = v.union(
  v.literal("ready"),
  v.literal("active"),
  v.literal("blocked"),
  v.literal("done"),
  v.literal("archived"),
);

const artifactKind = v.union(
  v.literal("file"),
  v.literal("url"),
  v.literal("commit"),
  v.literal("issue"),
  v.literal("document"),
  v.literal("image"),
  v.literal("log"),
  v.literal("dataset"),
  v.literal("other"),
);

const runStatus = v.union(
  v.literal("running"),
  v.literal("waiting"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const dependencyKind = v.union(
  v.literal("blocks"),
  v.literal("depends_on"),
  v.literal("related_to"),
  v.literal("duplicates"),
  v.literal("supersedes"),
);

const reservationMode = v.union(v.literal("exclusive"), v.literal("shared"));
const reservationStatus = v.union(v.literal("active"), v.literal("released"), v.literal("expired"));
const tokenScope = v.union(v.literal("read"), v.literal("write"), v.literal("admin"));

export default defineSchema({
  workspaces: defineTable({
    externalId: v.string(),
    slug: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_slug", ["slug"]),

  projects: defineTable({
    workspaceId: v.id("workspaces"),
    externalId: v.string(),
    slug: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_workspace_slug", ["workspaceId", "slug"]),

  actors: defineTable({
    workspaceId: v.id("workspaces"),
    externalId: v.string(),
    name: v.string(),
    kind: actorKind,
    capabilities: v.optional(v.array(v.string())),
    updatedAt: v.number(),
  })
    .index("by_workspace_external", ["workspaceId", "externalId"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"]),

  items: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    externalId: v.string(),
    kind: itemKind,
    title: v.string(),
    summary: v.optional(v.string()),
    status: itemStatus,
    priority: v.number(),
    nextAction: v.optional(v.string()),
    claimedByActorId: v.optional(v.id("actors")),
    claimedByExternalId: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    claimGeneration: v.number(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_external", ["workspaceId", "externalId"])
    .index("by_project_status", ["projectId", "status", "updatedAt"])
    .index("by_workspace_status", ["workspaceId", "status", "updatedAt"])
    .index("by_claim_expiry", ["status", "claimExpiresAt"])
    .index("by_actor_status", ["claimedByActorId", "status", "updatedAt"]),

  events: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    externalId: v.string(),
    actorId: v.optional(v.id("actors")),
    actorExternalId: v.optional(v.string()),
    type: v.string(),
    payload: v.any(),
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_item_created", ["itemId", "createdAt"])
    .index("by_project_created", ["projectId", "createdAt"])
    .index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"]),

  artifacts: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    externalId: v.string(),
    actorId: v.id("actors"),
    actorExternalId: v.string(),
    kind: artifactKind,
    label: v.string(),
    uri: v.string(),
    mimeType: v.optional(v.string()),
    metadata: v.any(),
    createdAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_item_created", ["itemId", "createdAt"])
    .index("by_project_created", ["projectId", "createdAt"]),

  runs: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    externalId: v.string(),
    actorId: v.id("actors"),
    actorExternalId: v.string(),
    harness: v.string(),
    model: v.optional(v.string()),
    externalRunId: v.optional(v.string()),
    repository: v.optional(v.string()),
    branch: v.optional(v.string()),
    worktree: v.optional(v.string()),
    status: runStatus,
    childAgentCount: v.optional(v.number()),
    toolCallCount: v.optional(v.number()),
    startedAt: v.number(),
    lastHeartbeatAt: v.number(),
    endedAt: v.optional(v.number()),
    outcome: v.optional(v.string()),
  })
    .index("by_external_id", ["externalId"])
    .index("by_item_status", ["itemId", "status", "startedAt"])
    .index("by_project_status", ["projectId", "status", "lastHeartbeatAt"])
    .index("by_actor_status", ["actorId", "status", "lastHeartbeatAt"]),

  dependencies: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    fromItemId: v.id("items"),
    toItemId: v.id("items"),
    kind: dependencyKind,
    createdByActorId: v.id("actors"),
    createdAt: v.number(),
  })
    .index("by_from_kind", ["fromItemId", "kind", "toItemId"])
    .index("by_to_kind", ["toItemId", "kind", "fromItemId"]),

  apiTokens: defineTable({
    workspaceId: v.id("workspaces"),
    externalId: v.string(),
    name: v.string(),
    secretHash: v.string(),
    scopes: v.array(tokenScope),
    projects: v.optional(v.array(v.string())),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_external_id", ["externalId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  reservations: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.optional(v.id("projects")),
    itemId: v.optional(v.id("items")),
    externalId: v.string(),
    resource: v.string(),
    mode: reservationMode,
    capacity: v.number(),
    units: v.number(),
    holderActorId: v.id("actors"),
    holderActorExternalId: v.string(),
    status: reservationStatus,
    generation: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_resource_status", ["workspaceId", "resource", "status", "expiresAt"])
    .index("by_workspace_status", ["workspaceId", "status", "expiresAt"])
    .index("by_project_status", ["projectId", "status", "expiresAt"])
    .index("by_holder_status", ["holderActorId", "status", "expiresAt"]),
});
