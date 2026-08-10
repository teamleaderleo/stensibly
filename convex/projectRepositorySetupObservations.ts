import { v } from "convex/values";
import {
  createProjectRepositorySetupObservationRecord,
  prepareProjectRepositorySetupObservation,
} from "../src/project-repository-setup-observation";
import {
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const sourceKind = v.union(
  v.literal("operator_supplied"),
  v.literal("github_conversation_context"),
);

const observationRecord = v.object({
  version: v.literal(1),
  id: v.string(),
  project: v.string(),
  repositoryFullName: v.string(),
  defaultBranch: v.string(),
  sourceKind,
  semanticFingerprint: v.string(),
  observedAt: v.string(),
  authorizesProviderEffect: v.literal(false),
  containsSecrets: v.literal(false),
});

export const getCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
  },
  returns: v.union(observationRecord, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const project = await findProject(
      ctx,
      workspace._id,
      assertSlug(args.project, "Project"),
    );
    if (!project) return null;
    const row = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    return row ? publicRecord(row, project.slug) : null;
  },
});

export const record = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    repositoryFullName: v.string(),
    defaultBranch: v.string(),
    sourceKind,
    externalId: v.string(),
  },
  returns: v.object({
    observation: observationRecord,
    replayed: v.boolean(),
    replacedObservationId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Workspace does not exist");
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error("Project does not exist");

    const currentRow = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    const current = currentRow ? publicRecord(currentRow, projectSlug) : null;
    const prepared = prepareProjectRepositorySetupObservation(current, {
      project: projectSlug,
      repositoryFullName: args.repositoryFullName,
      defaultBranch: args.defaultBranch,
      sourceKind: args.sourceKind,
    });
    if (prepared.replay) {
      return {
        observation: prepared.replay,
        replayed: true,
        replacedObservationId: null,
      };
    }

    const observedAt = new Date(Date.now()).toISOString();
    const observation = createProjectRepositorySetupObservationRecord({
      id: args.externalId,
      project: prepared.project,
      repositoryFullName: prepared.repositoryFullName,
      defaultBranch: prepared.defaultBranch,
      sourceKind: prepared.sourceKind,
      semanticFingerprint: prepared.semanticFingerprint,
      observedAt,
    });
    await ctx.db.insert("projectRepositorySetupObservations", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId: observation.id,
      repositoryFullName: observation.repositoryFullName,
      defaultBranch: observation.defaultBranch,
      sourceKind: observation.sourceKind,
      semanticFingerprint: observation.semanticFingerprint,
      observedAt: Date.parse(observation.observedAt),
    });
    return {
      observation,
      replayed: false,
      replacedObservationId: current?.id ?? null,
    };
  },
});

function publicRecord(
  row: {
    externalId: string;
    repositoryFullName: string;
    defaultBranch: string;
    sourceKind: "operator_supplied" | "github_conversation_context";
    semanticFingerprint: string;
    observedAt: number;
  },
  project: string,
) {
  return createProjectRepositorySetupObservationRecord({
    id: row.externalId,
    project,
    repositoryFullName: row.repositoryFullName,
    defaultBranch: row.defaultBranch,
    sourceKind: row.sourceKind,
    semanticFingerprint: row.semanticFingerprint,
    observedAt: new Date(row.observedAt).toISOString(),
  });
}
