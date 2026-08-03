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

  githubProjectContexts: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    externalId: v.string(),
    issueExternalId: v.string(),
    repositoryFullName: v.string(),
    sourceRevision: v.string(),
    snapshotSha256: v.string(),
    contentSha256: v.string(),
    providerUpdatedAt: v.number(),
    snapshotJson: v.string(),
    projectAttachmentExternalId: v.string(),
    projectAttachmentSnapshotSha256: v.string(),
    instructionSetId: v.string(),
    instructionSetSha256: v.string(),
    instructionSetJson: v.string(),
    syncStatus: v.union(v.literal("synchronized"), v.literal("degraded")),
    syncCursor: v.optional(v.string()),
    degradedReasonCode: v.optional(v.string()),
    observationRef: v.string(),
    observedAt: v.number(),
    acceptedBy: v.string(),
    acceptedAt: v.number(),
    isCurrent: v.boolean(),
    outcome: v.union(
      v.literal("initial"),
      v.literal("updated"),
      v.literal("stale"),
      v.literal("instruction_rebound"),
      v.literal("synchronization_updated"),
    ),
  })
    .index("by_project_observation", ["projectId", "observationRef"])
    .index("by_project_issue_revision", ["projectId", "issueExternalId", "sourceRevision"])
    .index("by_project_issue_current", ["projectId", "issueExternalId", "isCurrent"])
    .index("by_project_current_issue", ["projectId", "isCurrent", "issueExternalId"])
    .index("by_project_issue_accepted", ["projectId", "issueExternalId", "acceptedAt", "externalId"]),

  githubProviderReceipts: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    externalId: v.string(),
    idempotencyKey: v.string(),
    repositoryFullName: v.string(),
    operation: v.string(),
    actorId: v.string(),
    clientId: v.string(),
    parametersSha256: v.string(),
    state: v.union(
      v.literal("reserved"),
      v.literal("succeeded"),
      v.literal("rejected"),
      v.literal("stale"),
      v.literal("pending_reconciliation"),
      v.literal("reconciled"),
    ),
    receiptJson: v.string(),
    receiptSha256: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_idempotency", ["projectId", "idempotencyKey"])
    .index("by_project_external", ["projectId", "externalId"]),

  githubRepositoryWriteReceipts: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    externalId: v.string(),
    idempotencyKey: v.string(),
    repositoryFullName: v.string(),
    targetRef: v.string(),
    state: v.union(
      v.literal("reserved"),
      v.literal("rejected"),
      v.literal("pending_reconciliation"),
      v.literal("verified_pending_release"),
      v.literal("succeeded"),
    ),
    receiptJson: v.string(),
    receiptSha256: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_idempotency", ["projectId", "idempotencyKey"])
    .index("by_project_external", ["projectId", "externalId"]),

  githubRepositoryWriteLanes: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    repositoryFullName: v.string(),
    targetRef: v.string(),
    ownerReceiptExternalId: v.string(),
    expectedParentSha: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_ref", ["projectId", "repositoryFullName", "targetRef"])
    .index("by_project_owner", ["projectId", "ownerReceiptExternalId"]),

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
    lifecycleState: v.optional(v.union(v.literal("unused"), v.literal("used"))),
    unusedExpiresAt: v.optional(v.number()),
    firstUsedAt: v.optional(v.number()),
    cleanupScheduledAt: v.optional(v.number()),
    cleanupScheduleGeneration: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_lifecycle_expiry", ["workspaceId", "lifecycleState", "unusedExpiresAt"]),

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
    .index("by_expiry", ["expiresAt"])
    .index("by_workspace_client_created", ["workspaceId", "clientExternalId", "createdAt"]),

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
    .index("by_workspace_client_created", ["workspaceId", "clientExternalId", "createdAt"])
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

  providerCapacityObservations: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.literal("coderabbit"),
    payloadDigest: v.string(),
    sourceCommentId: v.string(),
    repository: v.string(),
    pullRequestNumber: v.number(),
    subjectLogin: v.string(),
    subjectBasis: v.literal("pull_request_author_proxy"),
    providerState: v.union(v.literal("available"), v.literal("unavailable")),
    remaining: v.union(v.number(), v.null()),
    quotaLimit: v.union(v.number(), v.null()),
    refillAt: v.union(v.number(), v.null()),
    observedAt: v.number(),
    receivedAt: v.number(),
  })
    .index("by_workspace_payload", ["workspaceId", "provider", "payloadDigest"])
    .index("by_workspace_subject_observed", [
      "workspaceId",
      "provider",
      "repository",
      "subjectLogin",
      "observedAt",
      "receivedAt",
    ])
    .index("by_workspace_received", ["workspaceId", "receivedAt"]),

  providerCapacityDeliveries: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.literal("coderabbit"),
    deliveryId: v.string(),
    payloadDigest: v.string(),
    observationId: v.id("providerCapacityObservations"),
    createdAt: v.number(),
  })
    .index("by_workspace_delivery", ["workspaceId", "provider", "deliveryId"])
    .index("by_observation", ["observationId", "createdAt"]),

  githubRepositoryObservations: defineTable({
    workspaceId: v.id("workspaces"),
    observationId: v.string(),
    deliveryId: v.string(),
    payloadDigest: v.string(),
    semanticFingerprint: v.string(),
    eventType: v.string(),
    action: v.string(),
    repository: v.string(),
    actor: v.union(v.string(), v.null()),
    subjectKind: v.string(),
    subjectExternalId: v.string(),
    sourceTime: v.number(),
    sourceTimeSource: v.union(v.literal("provider"), v.literal("received")),
    receivedAt: v.number(),
    observationJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace_delivery", ["workspaceId", "deliveryId"])
    .index("by_workspace_observation", ["workspaceId", "observationId"])
    .index("by_workspace_repository_received", ["workspaceId", "repository", "receivedAt"])
    .index("by_workspace_subject_received", ["workspaceId", "subjectExternalId", "receivedAt"])
    .index("by_workspace_semantic_received", ["workspaceId", "semanticFingerprint", "receivedAt"]),

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