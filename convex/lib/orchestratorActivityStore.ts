import { stableJson } from "../../src/canonical-json";
import {
  compileOrchestratorActivityIngestionCandidate,
  type OrchestratorActivityIngestionCandidate,
} from "../../src/orchestrator-activity-ingestion-candidate";
import {
  admitOrchestratorActivityObservation,
  orchestratorActivityObservationInput,
} from "../../src/orchestrator-activity-observation-admission";
import type {
  OrchestratorActivityObservation,
} from "../../src/orchestrator-activity-observation";
import type {
  MutationContext,
  ProjectId,
  WorkspaceId,
} from "./domain";

const maximumStoredJsonBytes = 64 * 1024;
const maximumAppendOrder = 2_147_483_647;

export interface OrchestratorActivityDurableScope {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly workspace: string;
  readonly project: string;
}

export interface OrchestratorActivityDurableWriteResult {
  readonly receiptJson: string;
  readonly observationJson: string;
  readonly replayed: boolean;
  readonly observationAppended: boolean;
}

/**
 * Persists one already-admitted activity candidate inside the caller's Convex
 * transaction. Ordinary domain mutations can therefore emit activity without
 * adding a second externally visible write or weakening their atomicity.
 */
export async function persistOrchestratorActivityCandidate(
  ctx: MutationContext,
  scope: OrchestratorActivityDurableScope,
  candidate: OrchestratorActivityIngestionCandidate,
): Promise<OrchestratorActivityDurableWriteResult> {
  if (
    candidate.observation.workspace !== scope.workspace
    || candidate.observation.project !== scope.project
  ) {
    throw new Error("Orchestrator activity ingestion scope mismatch");
  }
  const workspace = await ctx.db.get("workspaces", scope.workspaceId);
  const project = await ctx.db.get("projects", scope.projectId);
  if (
    !workspace
    || workspace.slug !== scope.workspace
    || !project
    || project.workspaceId !== scope.workspaceId
    || project.slug !== scope.project
  ) {
    throw new Error("Orchestrator activity durable scope is inconsistent");
  }

  const existingDelivery = await ctx.db
    .query("orchestratorActivityDeliveries")
    .withIndex("by_project_delivery", (q) => q
      .eq("projectId", scope.projectId)
      .eq("deliveryId", candidate.deliveryId))
    .unique();
  if (existingDelivery) {
    if (existingDelivery.requestFingerprint !== candidate.requestFingerprint) {
      throw new Error("Orchestrator activity delivery identity conflict");
    }
    const stored = admitStoredOrchestratorActivityDelivery(existingDelivery);
    return Object.freeze({
      receiptJson: stableJson(stored.receipt),
      observationJson: stableJson(stored.observation),
      replayed: true,
      observationAppended: false,
    });
  }

  const sourceRow = await ctx.db
    .query("orchestratorActivityObservations")
    .withIndex("by_project_source", (q) => q
      .eq("projectId", scope.projectId)
      .eq("sourceClass", candidate.observation.sourceClass)
      .eq("sourceId", candidate.observation.sourceId))
    .unique();
  if (
    sourceRow
    && sourceRow.observationFingerprint !== candidate.observation.observationFingerprint
  ) {
    throw new Error("Orchestrator activity source identity conflict");
  }

  const observationRow = await ctx.db
    .query("orchestratorActivityObservations")
    .withIndex("by_project_observation", (q) => q
      .eq("projectId", scope.projectId)
      .eq("observationId", candidate.observation.observationId))
    .unique();
  if (
    observationRow
    && observationRow.observationFingerprint !== candidate.observation.observationFingerprint
  ) {
    throw new Error("Orchestrator activity observation identity conflict");
  }
  if (sourceRow && observationRow && sourceRow._id !== observationRow._id) {
    throw new Error("Orchestrator activity durable identity conflict");
  }

  let canonicalObservation = candidate.observation;
  let observationAppended = false;
  const canonicalRow = observationRow ?? sourceRow;
  if (canonicalRow) {
    canonicalObservation = admitStoredOrchestratorActivityObservation(canonicalRow);
    if (stableJson(canonicalObservation) !== stableJson(candidate.observation)) {
      throw new Error("Orchestrator activity durable observation conflict");
    }
  } else {
    const latest = await ctx.db
      .query("orchestratorActivityObservations")
      .withIndex("by_project_append_order", (q) => q.eq("projectId", scope.projectId))
      .order("desc")
      .take(1);
    const appendOrder = (latest[0]?.appendOrder ?? 0) + 1;
    if (!Number.isSafeInteger(appendOrder) || appendOrder > maximumAppendOrder) {
      throw new Error("Orchestrator activity append order exhausted");
    }
    const now = Date.now();
    await ctx.db.insert("orchestratorActivityObservations", {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      observationId: candidate.observation.observationId,
      observationFingerprint: candidate.observation.observationFingerprint,
      sourceClass: candidate.observation.sourceClass,
      sourceId: candidate.observation.sourceId,
      observationJson: stableJson(candidate.observation),
      appendOrder,
      firstAcceptedAt: Date.parse(candidate.acceptedAt),
      createdAt: now,
    });
    observationAppended = true;
  }

  await ctx.db.insert("orchestratorActivityDeliveries", {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    deliveryId: candidate.deliveryId,
    deliveryFingerprint: candidate.deliveryFingerprint,
    requestFingerprint: candidate.requestFingerprint,
    observationId: canonicalObservation.observationId,
    observationFingerprint: canonicalObservation.observationFingerprint,
    receiptJson: stableJson(candidate.receipt),
    observationJson: stableJson(canonicalObservation),
    acceptedAt: Date.parse(candidate.acceptedAt),
    createdAt: Date.now(),
  });

  return Object.freeze({
    receiptJson: stableJson(candidate.receipt),
    observationJson: stableJson(canonicalObservation),
    replayed: false,
    observationAppended,
  });
}

export function admitStoredOrchestratorActivityDelivery(row: {
  deliveryId: string;
  deliveryFingerprint: string;
  requestFingerprint: string;
  observationId: string;
  observationFingerprint: string;
  receiptJson: string;
  observationJson: string;
}): OrchestratorActivityIngestionCandidate {
  const observation = admitOrchestratorActivityObservation(
    parseStoredActivityJson(row.observationJson, "Stored orchestrator activity observation"),
  );
  const receiptValue = parseStoredActivityJson(
    row.receiptJson,
    "Stored orchestrator activity receipt",
  );
  if (!receiptValue || typeof receiptValue !== "object" || Array.isArray(receiptValue)) {
    throw new Error("Stored orchestrator activity receipt is invalid");
  }
  const receipt = receiptValue as Record<string, unknown>;
  const reconstructed = compileOrchestratorActivityIngestionCandidate({
    deliveryId: receipt.deliveryId,
    deliveryFingerprint: receipt.deliveryFingerprint,
    acceptedAt: receipt.acceptedAt,
    observation: orchestratorActivityObservationInput(observation),
  });
  if (
    stableJson(reconstructed.receipt) !== row.receiptJson
    || reconstructed.deliveryId !== row.deliveryId
    || reconstructed.deliveryFingerprint !== row.deliveryFingerprint
    || reconstructed.requestFingerprint !== row.requestFingerprint
    || observation.observationId !== row.observationId
    || observation.observationFingerprint !== row.observationFingerprint
  ) {
    throw new Error("Stored orchestrator activity delivery is inconsistent");
  }
  return reconstructed;
}

export function admitStoredOrchestratorActivityObservation(row: {
  observationId: string;
  observationFingerprint: string;
  sourceClass: string;
  sourceId: string;
  observationJson: string;
  appendOrder: number;
}): OrchestratorActivityObservation {
  const observation = admitOrchestratorActivityObservation(
    parseStoredActivityJson(row.observationJson, "Stored orchestrator activity observation"),
  );
  if (
    observation.observationId !== row.observationId
    || observation.observationFingerprint !== row.observationFingerprint
    || observation.sourceClass !== row.sourceClass
    || observation.sourceId !== row.sourceId
    || !Number.isSafeInteger(row.appendOrder)
    || row.appendOrder < 1
    || row.appendOrder > maximumAppendOrder
  ) {
    throw new Error("Stored orchestrator activity observation is inconsistent");
  }
  return observation;
}

export function parseStoredActivityJson(value: unknown, label: string): unknown {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > maximumStoredJsonBytes
  ) {
    throw new Error(`${label} JSON is invalid`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} JSON is invalid`);
  }
}
