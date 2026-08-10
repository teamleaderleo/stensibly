import { v } from "convex/values";
import {
  admitProjectRepositorySetupObservation,
  compileProjectRepositorySetupObservation,
} from "../src/project-repository-setup-observation";
import {
  prepareProjectRepositorySetupObservationReplacement,
} from "../src/project-repository-setup-ledger";
import {
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const fingerprint = v.union(v.string(), v.null());
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
  observedAt: v.string(),
  fingerprint: v.string(),
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
    const rows = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project_current", (q) =>
        q.eq("projectId", project._id).eq("isCurrent", true)
      )
      .order("desc")
      .take(2);
    if (rows.length > 1) {
      throw new Error("Repository setup observation has multiple current records");
    }
    return rows[0] ? publicRecord(rows[0], project.slug) : null;
  },
});

export const listHistory = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    limit: v.number(),
  },
  returns: v.array(observationRecord),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      throw new Error("Repository setup observation history limit is invalid");
    }
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const project = await findProject(
      ctx,
      workspace._id,
      assertSlug(args.project, "Project"),
    );
    if (!project) return [];
    const rows = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project_recorded", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(args.limit);
    return rows.map((row) => publicRecord(row, project.slug));
  },
});

export const record = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    repositoryFullName: v.string(),
    defaultBranch: v.string(),
    sourceKind,
    observedAt: v.string(),
    expectedCurrentFingerprint: fingerprint,
  },
  returns: v.object({
    observation: observationRecord,
    replayed: v.boolean(),
    replacedFingerprint: fingerprint,
  }),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Workspace does not exist");
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error("Project does not exist");

    const currentRows = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project_current", (q) =>
        q.eq("projectId", project._id).eq("isCurrent", true)
      )
      .order("desc")
      .take(2);
    if (currentRows.length > 1) {
      throw new Error("Repository setup observation has multiple current records");
    }
    const current = currentRows[0]
      ? publicRecord(currentRows[0], projectSlug)
      : null;
    const prepared = prepareProjectRepositorySetupObservationReplacement(current, {
      project: projectSlug,
      repositoryFullName: args.repositoryFullName,
      defaultBranch: args.defaultBranch,
      sourceKind: args.sourceKind,
      observedAt: args.observedAt,
      expectedCurrentFingerprint: args.expectedCurrentFingerprint,
    });
    if (prepared.replay) {
      return {
        observation: prepared.replay,
        replayed: true,
        replacedFingerprint: prepared.replacedFingerprint,
      };
    }

    const duplicate = await ctx.db
      .query("projectRepositorySetupObservations")
      .withIndex("by_project_fingerprint", (q) =>
        q.eq("projectId", project._id).eq("fingerprint", prepared.observation.fingerprint)
      )
      .unique();
    if (duplicate) {
      throw new Error("Repository setup observation fingerprint already exists in history");
    }

    if (currentRows[0]) {
      await ctx.db.patch(currentRows[0]._id, { isCurrent: false });
    }
    const recordedAt = Date.now();
    const id = await ctx.db.insert("projectRepositorySetupObservations", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId: prepared.observation.id,
      repositoryFullName: prepared.observation.repositoryFullName,
      defaultBranch: prepared.observation.defaultBranch,
      sourceKind: prepared.observation.sourceKind,
      observedAt: Date.parse(prepared.observation.observedAt),
      fingerprint: prepared.observation.fingerprint,
      recordedAt,
      isCurrent: true,
    });
    const stored = await ctx.db.get("projectRepositorySetupObservations", id);
    if (!stored) throw new Error("Recorded repository setup observation disappeared");
    const observation = publicRecord(stored, projectSlug);
    if (observation.fingerprint !== prepared.observation.fingerprint) {
      throw new Error("Recorded repository setup observation does not match request");
    }
    return {
      observation,
      replayed: false,
      replacedFingerprint: prepared.replacedFingerprint,
    };
  },
});

function publicRecord(
  row: {
    externalId: string;
    repositoryFullName: string;
    defaultBranch: string;
    sourceKind: "operator_supplied" | "github_conversation_context";
    observedAt: number;
    fingerprint: string;
  },
  project: string,
) {
  const observation = compileProjectRepositorySetupObservation({
    project,
    repositoryFullName: row.repositoryFullName,
    defaultBranch: row.defaultBranch,
    sourceKind: row.sourceKind,
    observedAt: new Date(row.observedAt).toISOString(),
  });
  return admitProjectRepositorySetupObservation({
    ...observation,
    id: row.externalId,
    fingerprint: row.fingerprint,
  });
}
