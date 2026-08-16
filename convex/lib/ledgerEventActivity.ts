import { sha256, stableJson } from "../../src/canonical-json";
import { containsRealisticRetainedCredential } from "../../src/github-retained-credential-policy";
import { compileOrchestratorActivityIngestionCandidate } from "../../src/orchestrator-activity-ingestion-candidate";
import type {
  OrchestratorActivityClass,
  OrchestratorActivitySourceClass,
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

export interface LedgerActivityItem {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly externalId: string;
}

export interface LedgerActivityEvent {
  readonly id: string;
  readonly itemId: string;
  readonly actorId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/**
 * Projects one already-committed canonical ledger event into the durable
 * activity store inside the caller's Convex transaction.
 *
 * Event payload bytes contribute only to the source fingerprint; they are not
 * copied into the content-minimised activity observation.
 */
export async function persistLedgerEventActivity(
  ctx: MutationContext,
  input: Readonly<{
    item: LedgerActivityItem;
    event: LedgerActivityEvent;
    actorExternalId: string;
    sourceClass: OrchestratorActivitySourceClass;
    activityClass: OrchestratorActivityClass;
    activityState: OrchestratorActivityState;
    responsibilityGeneration?: number;
  }>,
): Promise<void> {
  const workspace = await ctx.db.get("workspaces", input.item.workspaceId);
  if (!workspace) throw new Error("Activity workspace disappeared");
  const projectSlug = await projectSlugForItem(ctx, input.item);
  const sourceFingerprint = sha256(stableJson(input.event));
  const activityCandidate = compileOrchestratorActivityIngestionCandidate({
    deliveryId: `ledger:${input.event.id}`,
    deliveryFingerprint: sourceFingerprint,
    acceptedAt: input.event.createdAt,
    observation: {
      workspace: workspace.slug,
      project: projectSlug,
      actorId: activityActorId(workspace.slug, input.actorExternalId),
      sourceClass: input.sourceClass,
      sourceId: input.event.id,
      sourceFingerprint,
      observedAt: input.event.createdAt,
      activityClass: input.activityClass,
      activityState: input.activityState,
      workItemId: input.item.externalId,
      ...(input.responsibilityGeneration === undefined
        ? {}
        : { responsibilityGeneration: input.responsibilityGeneration }),
      relatedEvidenceIds: [input.event.id],
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
