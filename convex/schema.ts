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

const queuedRunStatus = v.union(
  v.literal("queued"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("blocked"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("abandoned"),
);

const dependencyKind = v.union(
  v.literal("blocks"),
  v.literal("depends_on"),
  v.literal("related_to"),
  v.literal("duplicates"),
  v.literal("supersedes"),
);

const continuationApprovalMode = v.union(
  v.literal("automatic"),
  v.literal("notify"),
  v.literal("human"),
);
const continuationDeliveryMode = v.union(
  v.literal("current_conversation"),
  v.literal("human_inbox"),
  v.literal("supervisor"),
);
const continuationStatus = v.union(
  v.literal("proposed"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("deferred"),
  v.literal("consumed"),
  v.literal("cancelled"),
  v.literal("superseded"),
  v.literal("expired"),
);
const continuationCommand = v.union(
  v.literal("approve"),
  v.literal("reject"),
  v.literal("defer"),
  v.literal("consume"),
  v.literal("cancel"),
  v.literal("supersede"),
  v.literal("edit"),
);

const reservationMode = v.union(v.literal("exclusive"), v.literal("shared"));
const reservationStatus = v.union(v.literal("active"), v.literal("released"), v.literal("expired"));
const tokenScope = v.union(v.literal("read"), v.literal("write"), v.literal("admin"));
const mcpOAuthScope = v.union(
  v.literal("read"),
  v.literal("write"),
  v.literal("offline_access"),
);
export const accountRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("viewer"),
);

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

  projectAttachments: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    externalId: v.string(),
    snapshotJson: v.string(),
    snapshotSha256: v.string(),
    contentSha256: v.string(),
    sourcePath: v.string(),
    sourceRevision: v.string(),
    acceptedBy: v.string(),
    authorityWidening: v.boolean(),
    acceptedAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_project_created", ["projectId", "acceptedAt"])
    .index("by_project_snapshot", ["projectId", "snapshotSha256", "acceptedAt"]),

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

  accounts: defineTable({
    externalId: v.string(),
    displayName: v.string(),
    primaryEmail: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    defaultActorExternalId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    disabledAt: v.optional(v.number()),
  })
    .index("by_external_id", ["externalId"])
    .index("by_primary_email", ["primaryEmail"]),

  accountIdentities: defineTable({
    accountId: v.id("accounts"),
    provider: v.string(),
    subject: v.string(),
    username: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerified: v.boolean(),
    avatarUrl: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_provider_subject", ["provider", "subject"])
    .index("by_account_provider", ["accountId", "provider"]),

  workspaceMemberships: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("accounts"),
    role: accountRole,
    projects: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_account_workspace", ["accountId", "workspaceId"])
    .index("by_workspace_role", ["workspaceId", "role"]),

  browserSessions: defineTable({
    accountId: v.id("accounts"),
    externalId: v.string(),
    secretHash: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_external_id", ["externalId"])
    .index("by_account_created", ["accountId", "createdAt"])
    .index("by_expiry", ["expiresAt"]),

  oauthStates: defineTable({
    workspaceId: v.id("workspaces"),
    externalId: v.string(),
    secretHash: v.string(),
    pkceVerifierHash: v.string(),
    returnTo: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_expiry", ["expiresAt"]),

  mcpOAuthClients: defineTable({
    workspaceId: v.id("workspaces"),
    externalId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.literal("none"),
    grantTypes: v.array(v.string()),
    responseTypes: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  mcpOAuthCodes: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("accounts"),
    externalId: v.string(),
    secretHash: v.string(),
    clientExternalId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    scopes: v.array(mcpOAuthScope),
    resource: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_expiry", ["expiresAt"]),

  mcpOAuthRefreshTokens: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("accounts"),
    externalId: v.string(),
    familyExternalId: v.string(),
    familyExpiresAt: v.optional(v.number()),
    cleanupScheduledAt: v.optional(v.number()),
    cleanupScheduleGeneration: v.optional(v.number()),
    secretHash: v.string(),
    clientExternalId: v.string(),
    scopes: v.array(mcpOAuthScope),
    resource: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    rotatedToExternalId: v.optional(v.string()),
  })
    .index("by_external_id", ["externalId"])
    .index("by_family_created", ["familyExternalId", "createdAt"])
    .index("by_workspace_family_created", ["workspaceId", "familyExternalId", "createdAt"])
    .index("by_expiry", ["expiresAt"]),

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
    .index("by_external_id", ["externalId"])
    .index("by_item_created", ["itemId", "createdAt"])
    .index("by_item_type_created", ["itemId", "type", "createdAt"])
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

  queuedRuns: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    itemId: v.id("items"),
    externalId: v.string(),
    actorId: v.id("actors"),
    actorExternalId: v.string(),
    runnerType: v.string(),
    runnerProfile: v.string(),
    externalRunId: v.optional(v.string()),
    status: queuedRunStatus,
    generation: v.number(),
    leaseGeneration: v.number(),
    leaseOwnerExternalId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    checkpoint: v.optional(v.string()),
    outcome: v.optional(v.string()),
    continuationRef: v.optional(v.string()),
    usage: v.any(),
    retryAttempt: v.number(),
    maxAttempts: v.number(),
    retryBackoffSeconds: v.number(),
    nextRetryAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
  })
    .index("by_workspace_external", ["workspaceId", "externalId"])
    .index("by_item_status", ["itemId", "status", "createdAt"])
    .index("by_project_status", ["projectId", "status", "updatedAt"]),

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

  continuations: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    sourceItemId: v.id("items"),
    sourceEventExternalId: v.string(),
    sourceRunId: v.optional(v.string()),
    externalId: v.string(),
    title: v.string(),
    rationale: v.string(),
    instruction: v.string(),
    action: v.any(),
    evidence: v.any(),
    suggestedByActorId: v.id("actors"),
    suggestedByExternalId: v.string(),
    approvalMode: continuationApprovalMode,
    deliveryMode: continuationDeliveryMode,
    status: continuationStatus,
    generation: v.number(),
    expiresAt: v.optional(v.number()),
    resolutionActorId: v.optional(v.id("actors")),
    resolutionActorExternalId: v.optional(v.string()),
    resolutionNote: v.optional(v.string()),
    result: v.optional(v.any()),
    consumedAt: v.optional(v.number()),
    request: v.any(),
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_external", ["workspaceId", "externalId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_item_status", ["sourceItemId", "status", "createdAt"])
    .index("by_delivery_status", ["workspaceId", "deliveryMode", "status", "updatedAt"])
    .index("by_expiry", ["status", "expiresAt"])
    .index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"]),

  continuationCommands: defineTable({
    workspaceId: v.id("workspaces"),
    continuationId: v.id("continuations"),
    continuationExternalId: v.string(),
    idempotencyKey: v.string(),
    command: continuationCommand,
    request: v.any(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"]),

  continuationSupervisorCommands: defineTable({
    workspaceId: v.id("workspaces"),
    continuationId: v.id("continuations"),
    continuationExternalId: v.string(),
    idempotencyKey: v.string(),
    request: v.any(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"]),

  completionContinuationCommands: defineTable({
    workspaceId: v.id("workspaces"),
    itemId: v.id("items"),
    itemExternalId: v.string(),
    idempotencyKey: v.string(),
    request: v.any(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"]),

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
