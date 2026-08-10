import { v } from "convex/values";
import {
  getOrCreateProject,
  getOrCreateWorkspace,
  getProjectByExternalId,
  getWorkspaceBySlug,
  requireServiceSecret,
  serviceSecretArg,
} from "./_shared";
import { mutation, query } from "./_generated/server";
import {
  prepareProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservationSourceKind,
} from "../src/project-repository-setup-observation";

const sourceKind = v.union(
  v.literal("operator_supplied"),
  v.literal("github_conversation_context"),
);

export const getCurrent = query({
  args: {
    serviceSecret: serviceSecretArg,
    workspace: v.string(),
    project: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await getWorkspaceBySlug(ctx, args.workspace);
    if (!workspace) return null;
    const project = await getProjectByExternalId(ctx, args.project);
    if (!project || project.workspaceId !== workspace._id) return null;
    const row = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project_observed", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    return row ? publicObservation(row, project.externalId) : null;
  },
});

export const record = mutation({
  args: {
    serviceSecret: serviceSecretArg,
    workspace: v.string(),
    project: v.string(),
    externalId: v.string(),
    repositoryFullName: v.string(),
    defaultBranch: v.string(),
    sourceKind,
    semanticFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const prepared = prepareProjectRepositorySetupObservation(null, {
      project: args.project,
      repositoryFullName: args.repositoryFullName,
      defaultBranch: args.defaultBranch,
      sourceKind: args.sourceKind as ProjectRepositorySetupObservationSourceKind,
    });
    if (prepared.semanticFingerprint !== args.semanticFingerprint) {
      throw new Error("Repository setup observation fingerprint mismatch");
    }
    const externalId = observationExternalId(args.externalId);
    const workspaceId = await getOrCreateWorkspace(ctx, args.workspace);
    const projectId = await getOrCreateProject(ctx, workspaceId, prepared.project);
    const current = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project_observed", (q) => q.eq("projectId", projectId))
      .order("desc")
      .first();
    if (current?.semanticFingerprint === prepared.semanticFingerprint) {
      return {
        observation: publicObservation(current, prepared.project),
        replayed: true,
        replacedObservationId: null,
      };
    }
    const existingId = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (existingId) {
      throw new Error("Repository setup observation identity already exists");
    }

    const observedAt = Date.now();
    await ctx.db.insert("projectRepositorySetupObservations", {
      workspaceId,
      projectId,
      externalId,
      repositoryFullName: prepared.repositoryFullName,
      defaultBranch: prepared.defaultBranch,
      sourceKind: prepared.sourceKind,
      semanticFingerprint: prepared.semanticFingerprint,
      observedAt,
    });
    const inserted = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (!inserted) throw new Error("Recorded repository setup observation disappeared");
    return {
      observation: publicObservation(inserted, prepared.project),
      replayed: false,
      replacedObservationId: current?.externalId ?? null,
    };
  },
});

function publicObservation(
  row: {
    externalId: string;
    repositoryFullName: string;
    defaultBranch: string;
    sourceKind: ProjectRepositorySetupObservationSourceKind;
    semanticFingerprint: string;
    observedAt: number;
  },
  project: string,
) {
  return {
    id: row.externalId,
    project,
    repositoryFullName: row.repositoryFullName,
    defaultBranch: row.defaultBranch,
    sourceKind: row.sourceKind,
    semanticFingerprint: row.semanticFingerprint,
    observedAt: new Date(row.observedAt).toISOString(),
  };
}

function observationExternalId(value: string): string {
  if (!/^repo_setup_[A-Za-z0-9-]{8,120}$/u.test(value)) {
    throw new Error("Repository setup observation identity is invalid");
  }
  return value;
}
