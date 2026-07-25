import { v } from "convex/values";
import {
  assertSlug,
  assertText,
  ensureProject,
  ensureWorkspace,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const nullableHash = v.union(v.string(), v.null());
const attachmentRecord = v.object({
  id: v.string(),
  project: v.string(),
  snapshotJson: v.string(),
  snapshotSha256: v.string(),
  contentSha256: v.string(),
  sourcePath: v.string(),
  sourceRevision: v.string(),
  acceptedBy: v.string(),
  authorityWidening: v.boolean(),
  acceptedAt: v.string(),
});

export const getCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
  },
  returns: v.union(attachmentRecord, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const project = await findProject(ctx, workspace._id, assertSlug(args.project, "Project"));
    if (!project) return null;
    const record = await ctx.db
      .query("projectAttachments")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    return record ? publicRecord(record, project.slug) : null;
  },
});

export const accept = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    expectedCurrentSnapshotSha256: nullableHash,
    externalId: v.string(),
    snapshotJson: v.string(),
    snapshotSha256: v.string(),
    contentSha256: v.string(),
    sourcePath: v.string(),
    sourceRevision: v.string(),
    acceptedBy: v.string(),
    authorityWidening: v.boolean(),
  },
  returns: attachmentRecord,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await ensureWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Failed to create workspace");
    const projectSlug = assertSlug(args.project, "Project");
    const project = await ensureProject(ctx, workspace._id, workspaceSlug, projectSlug);
    if (!project) throw new Error("Failed to create project");
    const snapshotSha256 = assertHash(args.snapshotSha256, "Snapshot hash");
    const contentSha256 = assertHash(args.contentSha256, "Content hash");
    const expected = args.expectedCurrentSnapshotSha256 === null
      ? null
      : assertHash(args.expectedCurrentSnapshotSha256, "Expected snapshot hash");
    const current = await ctx.db
      .query("projectAttachments")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    const currentHash = current?.snapshotSha256 ?? null;
    if (currentHash !== expected) {
      throw new Error("Project attachment changed while importing; reload and review the new diff");
    }

    const sourceRevision = assertText(args.sourceRevision, "Source revision", 240);
    if (current && current.snapshotSha256 === snapshotSha256 && current.sourceRevision === sourceRevision) {
      return publicRecord(current, projectSlug);
    }

    const snapshotJson = assertText(args.snapshotJson, "Project attachment snapshot", 256_000);
    const sourcePath = assertText(args.sourcePath, "Source path", 4096);
    assertSnapshotMetadata(
      snapshotJson,
      projectSlug,
      snapshotSha256,
      contentSha256,
      sourcePath,
    );
    const acceptedBy = assertText(args.acceptedBy, "Attachment importer", 240);
    const externalId = assertText(args.externalId, "Attachment id", 160);
    const duplicate = await ctx.db
      .query("projectAttachments")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .unique();
    if (duplicate) throw new Error(`Project attachment ${externalId} already exists`);

    const acceptedAt = Date.now();
    const id = await ctx.db.insert("projectAttachments", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId,
      snapshotJson,
      snapshotSha256,
      contentSha256,
      sourcePath,
      sourceRevision,
      acceptedBy,
      authorityWidening: args.authorityWidening,
      acceptedAt,
    });
    const record = await ctx.db.get("projectAttachments", id);
    if (!record) throw new Error("Accepted project attachment disappeared");
    return publicRecord(record, projectSlug);
  },
});

function assertHash(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 identifier`);
  }
  return normalized;
}

function assertSnapshotMetadata(
  snapshotJson: string,
  project: string,
  snapshotSha256: string,
  contentSha256: string,
  sourcePath: string,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(snapshotJson);
  } catch {
    throw new Error("Project attachment snapshot must be valid JSON");
  }
  if (!isRecord(decoded)) throw new Error("Project attachment snapshot must be an object");
  if (
    decoded.format !== "stensibly.project-attachment"
    || decoded.schemaVersion !== 1
    || decoded.snapshotSha256 !== snapshotSha256
  ) {
    throw new Error("Project attachment snapshot metadata does not match the import request");
  }
  const contract = isRecord(decoded.contract) ? decoded.contract : null;
  const source = isRecord(decoded.source) ? decoded.source : null;
  if (
    contract?.project !== project
    || source?.contentSha256 !== contentSha256
    || source?.path !== sourcePath
  ) {
    throw new Error("Project attachment snapshot metadata does not match the import request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicRecord(
  record: {
    externalId: string;
    snapshotJson: string;
    snapshotSha256: string;
    contentSha256: string;
    sourcePath: string;
    sourceRevision: string;
    acceptedBy: string;
    authorityWidening: boolean;
    acceptedAt: number;
  },
  project: string,
) {
  return {
    id: record.externalId,
    project,
    snapshotJson: record.snapshotJson,
    snapshotSha256: record.snapshotSha256,
    contentSha256: record.contentSha256,
    sourcePath: record.sourcePath,
    sourceRevision: record.sourceRevision,
    acceptedBy: record.acceptedBy,
    authorityWidening: record.authorityWidening,
    acceptedAt: new Date(record.acceptedAt).toISOString(),
  };
}
