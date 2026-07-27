import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const MAX_AUDIT_CLIENTS = 1_000;
const MAX_MALFORMED_ROW_REFERENCES = 100;

const lifecycleCountsValidator = v.object({
  total: v.number(),
  legacy: v.number(),
  unusedLive: v.number(),
  unusedExpired: v.number(),
  used: v.number(),
  malformed: v.number(),
});

const malformedRowValidator = v.object({
  rowId: v.id("mcpOAuthClients"),
  classification: v.literal("malformed"),
  lifecycleState: v.union(
    v.literal("unused"),
    v.literal("used"),
    v.null(),
  ),
  hasUnusedExpiresAt: v.boolean(),
  hasFirstUsedAt: v.boolean(),
  hasCleanupScheduledAt: v.boolean(),
  hasCleanupScheduleGeneration: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const lifecycleAuditValidator = v.object({
  version: v.literal(1),
  workspace: v.string(),
  workspaceFound: v.boolean(),
  observedAt: v.number(),
  scannedClients: v.number(),
  truncatedClients: v.boolean(),
  counts: lifecycleCountsValidator,
  malformedRows: v.array(malformedRowValidator),
  malformedRowsTruncated: v.boolean(),
  lifecycleShapeClear: v.boolean(),
  requiresExplicitRepair: v.boolean(),
  requiresCleanupEvidence: v.boolean(),
  requiresFurtherInspection: v.boolean(),
  containsSecrets: v.literal(false),
  grantsOAuthEnablement: v.literal(false),
});

type LifecycleClass =
  | "legacy"
  | "unused_live"
  | "unused_expired"
  | "used"
  | "malformed";

type LifecycleCounts = {
  total: number;
  legacy: number;
  unusedLive: number;
  unusedExpired: number;
  used: number;
  malformed: number;
};

/**
 * Produces one bounded, content-minimised audit projection for OAuth dynamic-client
 * lifecycle rows in a workspace.
 *
 * The projection intentionally excludes external client IDs, names, redirect URIs,
 * credentials, and registration metadata. Opaque Convex row IDs are returned only
 * for malformed rows so an authorised operator can inspect and repair the exact
 * records through a separately reviewed path.
 *
 * A clear lifecycle shape covers classification consistency only. It is not rollout
 * approval and does not replace cleanup/retry evidence, abuse evidence, reference
 * inspection, deployment evidence, or the contemporaneous human approval required
 * for production OAuth enablement.
 */
export const auditClientLifecycles = query({
  args: {
    ...serviceArgs,
    observedAt: v.number(),
  },
  returns: lifecycleAuditValidator,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const observedAt = assertTrustedTimestamp(args.observedAt, "Lifecycle audit time");
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) {
      return {
        version: 1 as const,
        workspace: workspaceSlug,
        workspaceFound: false,
        observedAt,
        scannedClients: 0,
        truncatedClients: false,
        counts: emptyCounts(),
        malformedRows: [],
        malformedRowsTruncated: false,
        lifecycleShapeClear: false,
        requiresExplicitRepair: false,
        requiresCleanupEvidence: false,
        requiresFurtherInspection: true,
        containsSecrets: false as const,
        grantsOAuthEnablement: false as const,
      };
    }

    const rows = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_AUDIT_CLIENTS + 1);
    const truncatedClients = rows.length > MAX_AUDIT_CLIENTS;
    const scannedRows = rows.slice(0, MAX_AUDIT_CLIENTS);
    const counts = emptyCounts();
    const malformedRows: Array<{
      rowId: Doc<"mcpOAuthClients">["_id"];
      classification: "malformed";
      lifecycleState: "unused" | "used" | null;
      hasUnusedExpiresAt: boolean;
      hasFirstUsedAt: boolean;
      hasCleanupScheduledAt: boolean;
      hasCleanupScheduleGeneration: boolean;
      createdAt: number;
      updatedAt: number;
    }> = [];

    for (const row of scannedRows) {
      const classification = classifyLifecycle(row, observedAt);
      counts.total += 1;
      incrementCount(counts, classification);
      if (
        classification === "malformed"
        && malformedRows.length < MAX_MALFORMED_ROW_REFERENCES
      ) {
        malformedRows.push({
          rowId: row._id,
          classification,
          lifecycleState: row.lifecycleState ?? null,
          hasUnusedExpiresAt: row.unusedExpiresAt !== undefined,
          hasFirstUsedAt: row.firstUsedAt !== undefined,
          hasCleanupScheduledAt: row.cleanupScheduledAt !== undefined,
          hasCleanupScheduleGeneration: row.cleanupScheduleGeneration !== undefined,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }

    const malformedRowsTruncated = truncatedClients
      || malformedRows.length < counts.malformed;
    return {
      version: 1 as const,
      workspace: workspaceSlug,
      workspaceFound: true,
      observedAt,
      scannedClients: scannedRows.length,
      truncatedClients,
      counts,
      malformedRows,
      malformedRowsTruncated,
      lifecycleShapeClear: !truncatedClients && counts.malformed === 0,
      requiresExplicitRepair: counts.malformed > 0,
      requiresCleanupEvidence: counts.unusedExpired > 0,
      requiresFurtherInspection: truncatedClients || malformedRowsTruncated,
      containsSecrets: false as const,
      grantsOAuthEnablement: false as const,
    };
  },
});

function classifyLifecycle(
  client: Doc<"mcpOAuthClients">,
  observedAt: number,
): LifecycleClass {
  const allAbsent = client.lifecycleState === undefined
    && client.unusedExpiresAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined
    && client.firstUsedAt === undefined;
  if (allAbsent) return "legacy";

  if (
    client.lifecycleState === "unused"
    && safeTimestamp(client.unusedExpiresAt)
    && client.cleanupScheduledAt === client.unusedExpiresAt
    && positiveGeneration(client.cleanupScheduleGeneration)
    && client.firstUsedAt === undefined
  ) {
    return client.unusedExpiresAt <= observedAt
      ? "unused_expired"
      : "unused_live";
  }

  if (
    client.lifecycleState === "used"
    && safeTimestamp(client.firstUsedAt)
    && client.unusedExpiresAt === undefined
    && client.cleanupScheduledAt === undefined
    && client.cleanupScheduleGeneration === undefined
  ) {
    return "used";
  }

  return "malformed";
}

function emptyCounts(): LifecycleCounts {
  return {
    total: 0,
    legacy: 0,
    unusedLive: 0,
    unusedExpired: 0,
    used: 0,
    malformed: 0,
  };
}

function incrementCount(counts: LifecycleCounts, classification: LifecycleClass): void {
  switch (classification) {
    case "legacy":
      counts.legacy += 1;
      break;
    case "unused_live":
      counts.unusedLive += 1;
      break;
    case "unused_expired":
      counts.unusedExpired += 1;
      break;
    case "used":
      counts.used += 1;
      break;
    case "malformed":
      counts.malformed += 1;
      break;
  }
}

function positiveGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertTrustedTimestamp(value: number, label: string): number {
  if (!safeTimestamp(value)) throw new Error(`${label} is invalid`);
  return value;
}
