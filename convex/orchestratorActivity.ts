import { v } from "convex/values";
import { stableJson } from "../src/canonical-json";
import { containsRealisticRetainedCredential } from "../src/github-retained-credential-policy";
import {
  compileOrchestratorActivityIngestionCandidate,
} from "../src/orchestrator-activity-ingestion-candidate";
import {
  assertSlug,
  ensureProject,
  ensureWorkspace,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import {
  admitStoredOrchestratorActivityDelivery,
  admitStoredOrchestratorActivityObservation,
  parseStoredActivityJson,
  persistOrchestratorActivityCandidate,
} from "./lib/orchestratorActivityStore";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,239}$/u;
const maximumListLimit = 256;

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
      parseStoredActivityJson(args.ingestionJson, "Orchestrator activity ingestion"),
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
    return await persistOrchestratorActivityCandidate(ctx, {
      workspaceId: workspace._id,
      projectId: project._id,
      workspace: workspaceSlug,
      project: projectSlug,
    }, candidate);
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
    const stored = admitStoredOrchestratorActivityDelivery(row);
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
      const observation = admitStoredOrchestratorActivityObservation(row);
      if (
        observation.workspace !== workspaceSlug
        || observation.project !== projectSlug
      ) {
        throw new Error("Orchestrator activity durable observation escaped list scope");
      }
      return {
        appendOrder: row.appendOrder,
        observationJson: stableJson(observation),
      };
    });
    return { observations, truncated };
  },
});

function activityIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new Error(`${label} cannot contain credential material`);
  }
  return value;
}
