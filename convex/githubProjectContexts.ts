import { v } from "convex/values";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import {
  assertSlug,
  assertText,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const syncStatus = v.union(v.literal("synchronized"), v.literal("degraded"));
const acceptanceOutcome = v.union(
  v.literal("initial"),
  v.literal("updated"),
  v.literal("stale"),
  v.literal("instruction_rebound"),
  v.literal("synchronization_updated"),
);
const nullableString = v.union(v.string(), v.null());
const record = v.object({
  id: v.string(),
  project: v.string(),
  externalId: v.string(),
  snapshotJson: v.string(),
  instructionSetJson: v.string(),
  syncStatus,
  syncCursor: nullableString,
  degradedReasonCode: nullableString,
  observationRef: v.string(),
  observedAt: v.string(),
  acceptedBy: v.string(),
  acceptedAt: v.string(),
  isCurrent: v.boolean(),
  outcome: acceptanceOutcome,
});

const snapshotKeys = [
  "assignees",
  "bodyRevision",
  "containsIssueBody",
  "contentSha256",
  "createdAt",
  "labels",
  "milestone",
  "provider",
  "providerNodeId",
  "reference",
  "relationships",
  "snapshotSha256",
  "sourceRevision",
  "state",
  "stateReason",
  "title",
  "updatedAt",
  "version",
] as const;
const referenceKeys = [
  "canonicalUrl",
  "externalId",
  "host",
  "number",
  "owner",
  "provider",
  "repository",
  "repositoryFullName",
] as const;
const bodyRevisionKeys = ["byteLength", "present", "sha256"] as const;

export const accept = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    snapshotJson: v.string(),
    projectAttachmentId: v.string(),
    projectAttachmentSnapshotSha256: v.string(),
    instructionSetJson: v.string(),
    syncStatus,
    syncCursor: nullableString,
    degradedReasonCode: nullableString,
    observationRef: v.string(),
    observedAt: v.string(),
    acceptedBy: v.string(),
  },
  returns: v.object({ record, replayed: v.boolean() }),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Workspace has no accepted project context");
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error(`Project ${projectSlug} does not exist`);

    const snapshot = parseSnapshot(args.snapshotJson);
    const instructionSet = parseInstructionSet(args.instructionSetJson);
    const projectAttachmentId = assertIdentifier(args.projectAttachmentId, "Project attachment ID");
    const projectAttachmentSnapshotSha256 = assertHash(
      args.projectAttachmentSnapshotSha256,
      "Project attachment snapshot fingerprint",
    );
    if (
      instructionSet.projectAttachmentId !== projectAttachmentId
      || instructionSet.projectAttachmentSnapshotSha256 !== projectAttachmentSnapshotSha256
    ) {
      throw new Error("GitHub issue instruction binding does not match the accepted attachment request");
    }

    const attachment = await ctx.db
      .query("projectAttachments")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (
      !attachment
      || attachment.externalId !== projectAttachmentId
      || attachment.snapshotSha256 !== projectAttachmentSnapshotSha256
    ) {
      throw new Error("GitHub issue context must bind the current accepted project attachment");
    }
    if (!attachmentDeclaresRepository(attachment.snapshotJson, snapshot.repositoryFullName)) {
      throw new Error(
        `Repository ${snapshot.repositoryFullName} is not declared by the accepted project attachment`,
      );
    }

    const normalizedSyncStatus = args.syncStatus;
    const degradedReasonCode = args.degradedReasonCode === null
      ? null
      : assertReasonCode(args.degradedReasonCode);
    if (normalizedSyncStatus === "degraded" && degradedReasonCode === null) {
      throw new Error("Degraded GitHub issue synchronization requires a reason code");
    }
    if (normalizedSyncStatus === "synchronized" && degradedReasonCode !== null) {
      throw new Error("Synchronized GitHub issue context cannot carry a degraded reason");
    }
    const syncCursor = args.syncCursor === null
      ? null
      : assertIdentifier(args.syncCursor, "GitHub synchronization cursor", 512);
    const observationRef = assertIdentifier(args.observationRef, "GitHub observation reference");
    const observedAt = timestamp(args.observedAt, "GitHub observation time");
    if (observedAt > Date.now() + 5 * 60_000) {
      throw new Error("GitHub observation time cannot be in the future");
    }
    const acceptedBy = assertIdentifier(args.acceptedBy, "GitHub context accepting actor");

    const observed = await ctx.db
      .query("githubIssueContexts")
      .withIndex("by_project_observation", (q) =>
        q.eq("projectId", project._id).eq("observationRef", observationRef)
      )
      .unique();
    if (observed) {
      if (!isExactReplay(observed, {
        issueExternalId: snapshot.externalId,
        snapshotSha256: snapshot.snapshotSha256,
        instructionSetId: instructionSet.id,
        syncStatus: normalizedSyncStatus,
        syncCursor,
        degradedReasonCode,
        observedAt,
        acceptedBy,
      })) {
        throw new Error(`GitHub observation reference ${observationRef} was reused with altered content`);
      }
      return { record: publicRecord(observed, projectSlug), replayed: true };
    }

    const sameRevision = await ctx.db
      .query("githubIssueContexts")
      .withIndex("by_project_issue_revision", (q) =>
        q.eq("projectId", project._id)
          .eq("issueExternalId", snapshot.externalId)
          .eq("sourceRevision", snapshot.sourceRevision)
      )
      .collect();
    if (sameRevision.some((candidate) => candidate.contentSha256 !== snapshot.contentSha256)) {
      throw new Error(
        `GitHub issue source revision ${snapshot.sourceRevision} was reused with altered content`,
      );
    }

    const current = await ctx.db
      .query("githubIssueContexts")
      .withIndex("by_project_issue_current", (q) =>
        q.eq("projectId", project._id)
          .eq("issueExternalId", snapshot.externalId)
          .eq("isCurrent", true)
      )
      .unique();
    const classification = classifyAcceptance(
      current,
      snapshot,
      instructionSet.id,
      observedAt,
    );
    if (classification.isCurrent && current) {
      await ctx.db.patch(current._id, { isCurrent: false });
    }

    const acceptedAt = Date.now();
    const externalId = `github_context_${fingerprintCanonicalRequest({
      version: 1,
      workspace: workspaceSlug,
      project: projectSlug,
      observationRef,
    }).slice("sha256:".length)}`;
    const rowId = await ctx.db.insert("githubIssueContexts", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId,
      issueExternalId: snapshot.externalId,
      repositoryFullName: snapshot.repositoryFullName,
      sourceRevision: snapshot.sourceRevision,
      snapshotSha256: snapshot.snapshotSha256,
      contentSha256: snapshot.contentSha256,
      providerUpdatedAt: snapshot.providerUpdatedAt,
      snapshotJson: JSON.stringify(snapshot.value),
      projectAttachmentExternalId: projectAttachmentId,
      projectAttachmentSnapshotSha256,
      instructionSetId: instructionSet.id,
      instructionSetSha256: instructionSet.sha256,
      instructionSetJson: JSON.stringify(instructionSet.value),
      syncStatus: normalizedSyncStatus,
      ...(syncCursor === null ? {} : { syncCursor }),
      ...(degradedReasonCode === null ? {} : { degradedReasonCode }),
      observationRef,
      observedAt,
      acceptedBy,
      acceptedAt,
      isCurrent: classification.isCurrent,
      outcome: classification.outcome,
    });
    const inserted = await ctx.db.get(rowId);
    if (!inserted) throw new Error("Accepted GitHub issue context disappeared");
    return { record: publicRecord(inserted, projectSlug), replayed: false };
  },
});

export const getCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    externalId: v.string(),
  },
  returns: v.union(record, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return null;
    const externalId = assertCanonicalExternalId(args.externalId);
    const current = await ctx.db
      .query("githubIssueContexts")
      .withIndex("by_project_issue_current", (q) =>
        q.eq("projectId", project._id).eq("issueExternalId", externalId).eq("isCurrent", true)
      )
      .unique();
    return current ? publicRecord(current, projectSlug) : null;
  },
});

export const listCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    limit: v.number(),
  },
  returns: v.array(record),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return [];
    const limit = boundedLimit(args.limit, 100);
    const rows = await ctx.db
      .query("githubIssueContexts")
      .withIndex("by_project_current_issue", (q) =>
        q.eq("projectId", project._id).eq("isCurrent", true)
      )
      .take(limit);
    return rows.map((row) => publicRecord(row, projectSlug));
  },
});

export const listHistory = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    externalId: v.string(),
    limit: v.number(),
  },
  returns: v.array(record),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return [];
    const externalId = assertCanonicalExternalId(args.externalId);
    const limit = boundedLimit(args.limit, 50);
    const rows = await ctx.db
      .query("githubIssueContexts")
      .withIndex("by_project_issue_accepted", (q) =>
        q.eq("projectId", project._id).eq("issueExternalId", externalId)
      )
      .order("desc")
      .take(limit);
    return rows.reverse().map((row) => publicRecord(row, projectSlug));
  },
});

function classifyAcceptance(
  current: any | null,
  snapshot: ParsedSnapshot,
  instructionSetId: string,
  observedAt: number,
): { outcome: "initial" | "updated" | "stale" | "instruction_rebound" | "synchronization_updated"; isCurrent: boolean } {
  if (!current) return { outcome: "initial", isCurrent: true };
  if (current.sourceRevision === snapshot.sourceRevision) {
    if (current.contentSha256 !== snapshot.contentSha256) {
      throw new Error(
        `GitHub issue source revision ${snapshot.sourceRevision} was reused with altered content`,
      );
    }
    if (current.instructionSetId !== instructionSetId) {
      return { outcome: "instruction_rebound", isCurrent: true };
    }
    return observedAt < current.observedAt
      ? { outcome: "stale", isCurrent: false }
      : { outcome: "synchronization_updated", isCurrent: true };
  }
  return snapshot.providerUpdatedAt < current.providerUpdatedAt
    ? { outcome: "stale", isCurrent: false }
    : { outcome: "updated", isCurrent: true };
}

function isExactReplay(
  current: any,
  candidate: {
    issueExternalId: string;
    snapshotSha256: string;
    instructionSetId: string;
    syncStatus: "synchronized" | "degraded";
    syncCursor: string | null;
    degradedReasonCode: string | null;
    observedAt: number;
    acceptedBy: string;
  },
): boolean {
  return current.issueExternalId === candidate.issueExternalId
    && current.snapshotSha256 === candidate.snapshotSha256
    && current.instructionSetId === candidate.instructionSetId
    && current.syncStatus === candidate.syncStatus
    && (current.syncCursor ?? null) === candidate.syncCursor
    && (current.degradedReasonCode ?? null) === candidate.degradedReasonCode
    && current.observedAt === candidate.observedAt
    && current.acceptedBy === candidate.acceptedBy;
}

interface ParsedSnapshot {
  value: Record<string, unknown>;
  externalId: string;
  repositoryFullName: string;
  sourceRevision: string;
  contentSha256: string;
  snapshotSha256: string;
  providerUpdatedAt: number;
}

function parseSnapshot(snapshotJson: string): ParsedSnapshot {
  const text = assertText(snapshotJson, "GitHub issue context snapshot", 512_000);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("GitHub issue context snapshot must be valid JSON");
  }
  if (!isRecord(decoded) || !hasExactKeys(decoded, snapshotKeys)) {
    throw new Error("GitHub issue context snapshot must contain only canonical bounded fields");
  }
  if (!isRecord(decoded.reference) || !hasExactKeys(decoded.reference, referenceKeys)) {
    throw new Error("GitHub issue snapshot reference is invalid");
  }
  if (!isRecord(decoded.bodyRevision) || !hasExactKeys(decoded.bodyRevision, bodyRevisionKeys)) {
    throw new Error("GitHub issue body revision metadata is invalid");
  }
  const snapshotSha256 = assertHash(decoded.snapshotSha256, "GitHub issue snapshot fingerprint");
  const contentSha256 = assertHash(decoded.contentSha256, "GitHub issue content fingerprint");
  const sourceRevision = assertIdentifier(
    decoded.sourceRevision,
    "GitHub issue source revision",
    512,
  );
  const { snapshotSha256: _snapshot, contentSha256: _content, sourceRevision: _revision, ...content } = decoded;
  if (fingerprintCanonicalRequest(content) !== contentSha256) {
    throw new Error("GitHub issue content fingerprint does not match the snapshot");
  }
  if (fingerprintCanonicalRequest({ ...content, sourceRevision, contentSha256 }) !== snapshotSha256) {
    throw new Error("GitHub issue snapshot fingerprint does not match its content");
  }
  if (
    decoded.version !== 1
    || decoded.provider !== "github"
    || decoded.containsIssueBody !== false
    || decoded.reference.provider !== "github"
    || decoded.reference.host !== "github.com"
  ) {
    throw new Error("GitHub issue snapshot metadata is invalid");
  }
  assertBoundedText(decoded.title, "GitHub issue title", 256);
  if (decoded.state !== "open" && decoded.state !== "closed") {
    throw new Error("GitHub issue state is invalid");
  }
  if (
    decoded.stateReason !== null
    && decoded.stateReason !== "completed"
    && decoded.stateReason !== "not_planned"
    && decoded.stateReason !== "reopened"
  ) {
    throw new Error("GitHub issue state reason is invalid");
  }
  boundedStringArray(decoded.labels, "GitHub issue labels", 100, 100);
  boundedStringArray(decoded.assignees, "GitHub issue assignees", 100, 39);
  if (!Array.isArray(decoded.relationships) || decoded.relationships.length > 100) {
    throw new Error("GitHub issue relationships are invalid");
  }
  if (
    typeof decoded.bodyRevision.present !== "boolean"
    || !Number.isSafeInteger(decoded.bodyRevision.byteLength)
    || (decoded.bodyRevision.byteLength as number) < 0
    || (decoded.bodyRevision.byteLength as number) > 128 * 1024
  ) {
    throw new Error("GitHub issue body revision metadata is invalid");
  }
  assertHash(decoded.bodyRevision.sha256, "GitHub issue body revision fingerprint");

  const owner = assertGitHubOwner(decoded.reference.owner);
  const repository = assertGitHubRepository(decoded.reference.repository);
  const repositoryFullName = `${owner}/${repository}`;
  const issueNumber = positiveInteger(decoded.reference.number, "GitHub issue number");
  const externalId = `github:${repositoryFullName}#${issueNumber}`;
  if (
    decoded.reference.repositoryFullName !== repositoryFullName
    || decoded.reference.externalId !== externalId
    || decoded.reference.canonicalUrl !== `https://github.com/${repositoryFullName}/issues/${issueNumber}`
  ) {
    throw new Error("GitHub issue snapshot reference is not canonical");
  }
  const createdAt = timestamp(decoded.createdAt, "GitHub issue created time");
  const providerUpdatedAt = timestamp(decoded.updatedAt, "GitHub issue updated time");
  if (providerUpdatedAt < createdAt) {
    throw new Error("GitHub issue updated time must not precede creation time");
  }
  return {
    value: decoded,
    externalId,
    repositoryFullName,
    sourceRevision,
    contentSha256,
    snapshotSha256,
    providerUpdatedAt,
  };
}

function parseInstructionSet(instructionSetJson: string) {
  const text = assertText(instructionSetJson, "Repository instruction set", 256_000);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Repository instruction set must be valid JSON");
  }
  if (!isRecord(decoded) || decoded.version !== 1 || !Array.isArray(decoded.sources)) {
    throw new Error("Repository instruction set metadata is invalid");
  }
  const projectAttachmentId = assertIdentifier(decoded.projectAttachmentId, "Project attachment ID");
  const projectAttachmentSnapshotSha256 = assertHash(
    decoded.projectAttachmentSnapshotSha256,
    "Project attachment snapshot fingerprint",
  );
  if (decoded.sources.length < 1 || decoded.sources.length > 32) {
    throw new Error("Repository instruction sources must contain 1-32 entries");
  }
  const paths = new Set<string>();
  const sources = decoded.sources.map((source) => {
    if (!isRecord(source)) throw new Error("Repository instruction source must be an object");
    const path = assertSourcePath(source.path);
    if (paths.has(path)) throw new Error("Repository instruction source paths must be unique");
    paths.add(path);
    return {
      path,
      revision: assertIdentifier(source.revision, "Repository instruction source revision", 512),
      contentSha256: assertHash(source.contentSha256, "Repository instruction source fingerprint"),
    };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const canonical = {
    version: 1 as const,
    projectAttachmentId,
    projectAttachmentSnapshotSha256,
    sources,
  };
  const sha256 = fingerprintCanonicalRequest(canonical);
  const id = `instructions_${sha256.slice("sha256:".length)}`;
  if (decoded.sha256 !== sha256 || decoded.id !== id) {
    throw new Error("Repository instruction set fingerprint is invalid");
  }
  return { value: { ...canonical, id, sha256 }, ...canonical, id, sha256 };
}

function attachmentDeclaresRepository(snapshotJson: string, repositoryFullName: string): boolean {
  let decoded: unknown;
  try {
    decoded = JSON.parse(snapshotJson);
  } catch {
    return false;
  }
  const contract = isRecord(decoded) && isRecord(decoded.contract) ? decoded.contract : null;
  const repositories = contract && Array.isArray(contract.repositories) ? contract.repositories : [];
  const target = canonicalRepository(repositoryFullName);
  return target !== null && repositories.some((value) =>
    typeof value === "string" && canonicalRepository(value) === target
  );
}

function canonicalRepository(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  const plain = /^([^/:]+)\/([^/]+)$/.exec(normalized);
  if (plain) return canonicalRepositoryParts(plain[1]!, plain[2]!);
  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== "github.com" || url.search || url.hash || url.password) {
      return null;
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return null;
    return canonicalRepositoryParts(parts[0]!, parts[1]!);
  } catch {
    return null;
  }
}

function canonicalRepositoryParts(owner: string, repository: string): string | null {
  try {
    return `${assertGitHubOwner(owner).toLowerCase()}/${assertGitHubRepository(
      repository.replace(/\.git$/i, ""),
    ).toLowerCase()}`;
  } catch {
    return null;
  }
}

function publicRecord(row: any, project: string) {
  return {
    id: row.externalId,
    project,
    externalId: row.issueExternalId,
    snapshotJson: row.snapshotJson,
    instructionSetJson: row.instructionSetJson,
    syncStatus: row.syncStatus,
    syncCursor: row.syncCursor ?? null,
    degradedReasonCode: row.degradedReasonCode ?? null,
    observationRef: row.observationRef,
    observedAt: new Date(row.observedAt).toISOString(),
    acceptedBy: row.acceptedBy,
    acceptedAt: new Date(row.acceptedAt).toISOString(),
    isCurrent: row.isCurrent,
    outcome: row.outcome,
  };
}

function assertCanonicalExternalId(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub issue external ID must be a string");
  const match = /^github:([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(value.trim());
  if (!match) throw new Error("GitHub issue external ID is invalid");
  return `github:${assertGitHubOwner(match[1]!)}/${assertGitHubRepository(match[2]!)}#${Number(match[3])}`;
}

function assertIdentifier(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(normalized)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function assertReasonCode(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/.test(normalized)) {
    throw new Error("GitHub synchronization degraded reason is invalid");
  }
  return normalized;
}

function assertGitHubOwner(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub owner identity is invalid");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) {
    throw new Error("GitHub owner identity is invalid");
  }
  return normalized;
}

function assertGitHubRepository(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub repository identity is invalid");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("GitHub repository identity is invalid");
  }
  return normalized;
}

function assertSourcePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("Repository instruction source path is invalid");
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (
    normalized.length < 1
    || normalized.length > 240
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Repository instruction source path is invalid");
  }
  return normalized;
}

function timestamp(value: unknown, label: string): number {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`GitHub context limit must be between 1 and ${maximum}`);
  }
  return value;
}

function boundedStringArray(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new Error(`${label} is invalid`);
  }
  const result = value.map((entry) => assertBoundedText(entry, label, maximumLength));
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
}

function assertBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.replace(/\r\n?/g, "\n");
  if (
    normalized.length < 1
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(normalized)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
