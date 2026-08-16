import { sha256, stableJson } from "../../src/canonical-json";
import { containsRealisticRetainedCredential } from "../../src/github-retained-credential-policy";
import { compileOrchestratorActivityIngestionCandidate } from "../../src/orchestrator-activity-ingestion-candidate";
import type {
  OrchestratorActivityClass,
  OrchestratorActivityState,
} from "../../src/orchestrator-activity-observation";
import {
  projectSlugForItem,
  type MutationContext,
  type ProjectId,
  type WorkspaceId,
} from "./domain";
import { persistOrchestratorActivityCandidate } from "./orchestratorActivityStore";

const activityIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,239}$/u;

export interface ClaimActivityItem {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly externalId: string;
}

export interface ClaimActivityEvent {
  readonly id: string;
  readonly itemId: string;
  readonly actorId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/**
 * Projects one already-committed canonical claim event into the durable
 * activity store inside the caller's Convex transaction.
 */
export async function persistClaimActivity(
  ctx: MutationContext,
  input: Readonly<{
    item: ClaimActivityItem;
    claimEvent: ClaimActivityEvent;
    actorExternalId: string;
    activityClass: OrchestratorActivityClass;
    activityState: OrchestratorActivityState;
    responsibilityGeneration: number;
  }>,
): Promise<void> {
  const workspace = await ctx.db.get("workspaces", input.item.workspaceId);
  if (!workspace) throw new Error("Claim activity workspace disappeared");
  const projectSlug = await projectSlugForItem(ctx, input.item);
  const sourceFingerprint = sha256(stableJson(input.claimEvent));
  const activityCandidate = compileOrchestratorActivityIngestionCandidate({
    deliveryId: `ledger:${input.claimEvent.id}`,
    deliveryFingerprint: sourceFingerprint,
    acceptedAt: input.claimEvent.createdAt,
    observation: {
      workspace: workspace.slug,
      project: projectSlug,
      actorId: activityActorId(workspace.slug, input.actorExternalId),
      sourceClass: "responsibility",
      sourceId: input.claimEvent.id,
      sourceFingerprint,
      observedAt: input.claimEvent.createdAt,
      activityClass: input.activityClass,
      activityState: input.activityState,
      workItemId: input.item.externalId,
      responsibilityGeneration: input.responsibilityGeneration,
      relatedEvidenceIds: [input.claimEvent.id],
    },
  });
  await persistOrchestratorActivityCandidate(ctx, {
    workspaceId: input.item.workspaceId,
    projectId: input.item.projectId,
    workspace: workspace.slug,
    project: projectSlug,
  }, activityCandidate);
}

function activityActorId(workspace: string, externalId: string): string {
  if (
    activityIdentifierPattern.test(externalId)
    && !containsRealisticRetainedCredential(externalId)
  ) {
    return externalId;
  }
  const digest = sha256(stableJson({ workspace, actorExternalId: externalId }));
  return `actor:${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}
