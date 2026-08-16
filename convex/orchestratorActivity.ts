import { v } from "convex/values";
import { stableJson } from "../src/canonical-json";
import { containsRealisticRetainedCredential } from "../src/github-retained-credential-policy";
import {
  compileOrchestratorActivityIngestionCandidate,
} from "../src/orchestrator-activity-ingestion-candidate";
import {
  admitOrchestratorActivityObservation,
  orchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation-admission";
import type {
  OrchestratorActivityObservation,
} from "../src/orchestrator-activity-observation";
import {
  assertSlug,
  ensureProject,
  ensureWorkspace,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,239}$/u;
const maximumIngestionBytes = 64 * 1024;
const maximumListLimit = 256;
const maximumAppendOrder = 2_147_483_647;

export const ingest = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    ingestionJson: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const projectSlug = assertSlug(args.project, "Project");
    const candidate = compileOrchestratorActivityIngestionCandidate(
      parseBoundedJson(args.ingestionJson, "Orchestrator activity ingestion"),
    );
    if (
      candidate.observation.workspace !== workspaceSlug
      || candidate.observation.project !== projectSlug
    ) {
      throw new Error("Orchestrator activity ingestion scope mismatch");
    }

    const workspace = await ensureWorkspace(ctx, workspaceSlug);
    if (!workspace) {
      throw new Error("Orchestrator activity workspace could not be ensured");
    }
    const project = await ensureProject(ctx, workspace._id, workspaceSlug, projectSlug);
    if (!project) {
      throw new Error("Orchestrator activity project could not be ensured");
    }
    const existingDelivery = await ctx.db
      .query("orchestratorActivityDeliveries")
      .withIndex("by_project_delivery", (q) => q
        .eq("projectId", project._id)
        .eq("deliveryId", candidate.deliveryId))
      .unique();
    if (existingDelivery) {
      if (existingDelivery.requestFingerprint !== candidate.requestFingerprint) {
        throw new Error("Orchestrator activity delivery identity conflict");
      }
      const stored = admitStoredDelivery(existingDelivery);
      return {
        receiptJson: stableJson(stored.receipt),
        observationJson: stableJson(stored.observation),
        replayed: true,
        observationAppended: false,
      };
    }

    const sourceRow = await ctx.db
      .query("orchestratorActivityObservations")
      .withIndex("by_project_source", (q) => q
        .eq("projectId", project._id)
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
        .eq("projectId", project._id)
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
      canonicalObservation = admitStoredObservation(canonicalRow);
      if (stableJson(canonicalObservation) !== stableJson(candidate.observation)) {
        throw new Error("Orchestrator activity durable observation conflict");
      }
    } else {
      const latest = await ctx.db
        .query("orchestratorActivityObservations")
        .withIndex("by_project_append_order", (q) => q.eq("projectId", project._id))
        .order("desc")
        .take(1);
      const appendOrder = (latest[0]?.appendOrder ?? 0) + 1;
      if (!Number.isSafeInteger(appendOrder) || appendOrder > maximumAppendOrder) {
        throw new Error("Orchestrator activity append order exhausted");
      }
      const acceptedAt = Date.parse(candidate.acceptedAt);
      const now = Date.now();
      await ctx.db.insert("orchestratorActivityObservations", {
        workspaceId: workspace._id,
        projectId: project._id,
        observationId: candidate.observation.observationId,
        observationFingerprint: candidate.observation.observationFingerprint,
        sourceClass: candidate.observation.sourceClass,
        sourceId: candidate.observation.sourceId,
        observationJson: stableJson(candidate.observation),
        appendOrder,
        firstAcceptedAt: acceptedAt,
        createdAt: now,
      });
      observationAppended = true;
    }

    const now = Date.now();
    await ctx.db.insert("orchestratorActivityDeliveries", {
      workspaceId: workspace._id,
      projectId: project._id,
      deliveryId: candidate.deliveryId,
      deliveryFingerprint: candidate.deliveryFingerprint,
      requestFingerprint: candidate.requestFingerprint,
      observationId: canonicalObservation.observationId,
      observationFingerprint: canonicalObservation.observationFingerprint,
      receiptJson: stableJson(candidate.receipt),
      observationJson: stableJson(canonicalObservation),
      acceptedAt: Date.parse(candidate.acceptedAt),
      createdAt: now,
    });

    return {
      receiptJson: stableJson(candidate.receipt),
      observationJson: stableJson(canonicalObservation),
      replayed: false,
      observationAppended,
    };
  },
});

export const getReceipt = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    deliveryId: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const projectSlug = assertSlug(args.project, "Project");
    const deliveryId = activityIdentifier(args.deliveryId, "delivery ID");
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return null;
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return null;
    const row = await ctx.db
      .query("orchestratorActivityDeliveries")
      .withIndex("by_project_delivery", (q) => q
        .eq("projectId", project._id)
        .eq("deliveryId", deliveryId))
      .unique();
    if (!row) return null;
    const stored = admitStoredDelivery(row);
    return { receiptJson: stableJson(stored.receipt) };
  },
});

export const listObservations = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const projectSlug = assertSlug(args.project, "Project");
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > maximumListLimit) {
      throw new RangeError("Orchestrator activity list limit is invalid");
    }
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return { observations: [], truncated: false };
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return { observations: [], truncated: false };
    const rows = await ctx.db
      .query("orchestratorActivityObservations")
      .withIndex("by_project_append_order", (q) => q.eq("projectId", project._id))
      .order("asc")
      .take(args.limit + 1);
    const truncated = rows.length > args.limit;
    const observations = rows.slice(0, args.limit).map((row) => {
      const observation = admitStoredObservation(row);
      if (
        observation.workspace !== workspaceSlug
        || observation.project !== projectSlug
      ) {
        throw new Error("Orchestrator activity durable scope conflict");
      }
      return {
        appendOrder: row.appendOrder,
        observationJson: stableJson(observation),
      };
    });
    return { observations, truncated };
  },
});

function admitStoredDelivery(row: {
  deliveryId: string;
  deliveryFingerprint: string;
  requestFingerprint: string;
  observationId: string;
  observationFingerprint: string;
  receiptJson: string;
  observationJson: string;
}) {
  const observation = admitOrchestratorActivityObservation(
    parseBoundedJson(row.observationJson, "Stored orchestrator activity observation"),
  );
  const receiptValue = parseBoundedJson(row.receiptJson, "Stored orchestrator activity receipt");
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

function admitStoredObservation(row: {
  observationId: string;
  observationFingerprint: string;
  sourceClass: string;
  sourceId: string;
  observationJson: string;
  appendOrder: number;
}): OrchestratorActivityObservation {
  const observation = admitOrchestratorActivityObservation(
    parseBoundedJson(row.observationJson, "Stored orchestrator activity observation"),
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

function parseBoundedJson(value: unknown, label: string): unknown {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > maximumIngestionBytes
  ) {
    throw new Error(`${label} JSON is invalid`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} JSON is invalid`);
  }
}

function activityIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new Error(`${label} cannot contain credential material`);
  }
  return value;
}
