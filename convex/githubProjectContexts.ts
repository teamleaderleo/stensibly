import { v } from "convex/values";
import {
  admitAcceptedRepositoryInstructionSet,
  admitGitHubIssueContextAcceptanceSubject,
  admitGitHubIssueContextSnapshot,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
  classifyGitHubIssueContextAcceptance,
  type GitHubIssueContextAcceptanceOutcome,
  type GitHubIssueContextAcceptanceSubject,
} from "../src/github-project-context-admission";
import {
  fingerprintCanonicalRequest,
  fingerprintExactText,
} from "../src/idempotency-request-fingerprint";
import { parseStrictJson } from "../src/strict-json";
import {
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const maximumCurrent = 100;
const maximumHistory = 50;
const maximumObservationFutureSkewMs = 5 * 60_000;
const nullableString = v.union(v.string(), v.null());
const syncStatus = v.union(v.literal("synchronized"), v.literal("degraded"));
const outcome = v.union(
  v.literal("initial"),
  v.literal("updated"),
  v.literal("stale"),
  v.literal("instruction_rebound"),
  v.literal("synchronization_updated"),
);
const publicRecordValidator = v.object({
  id: v.string(),
  project: v.string(),
  externalId: v.string(),
  repositoryFullName: v.string(),
  sourceRevision: v.string(),
  snapshotSha256: v.string(),
  contentSha256: v.string(),
  providerUpdatedAt: v.string(),
  snapshotJson: v.string(),
  projectAttachmentId: v.string(),
  projectAttachmentSnapshotSha256: v.string(),
  instructionSetId: v.string(),
  instructionSetSha256: v.string(),
  instructionSetJson: v.string(),
  syncStatus,
  syncCursor: nullableString,
  degradedReasonCode: nullableString,
  observationRef: v.string(),
  observedAt: v.string(),
  acceptedBy: v.string(),
  acceptedAt: v.string(),
  isCurrent: v.boolean(),
  outcome,
});

type AcceptedSubject = GitHubIssueContextAcceptanceSubject;
type AcceptedOutcome = GitHubIssueContextAcceptanceOutcome;

export const accept = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    snapshotJson: v.string(),
    instructionSetJson: v.string(),
    syncStatus,
    syncCursor: nullableString,
    degradedReasonCode: nullableString,
    observationRef: v.string(),
    observedAt: v.string(),
    acceptedBy: v.string(),
  },
  returns: v.object({ record: publicRecordValidator, replayed: v.boolean() }),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("GITHUB_PROJECT_CONTEXT_WORKSPACE_NOT_FOUND");
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error("GITHUB_PROJECT_CONTEXT_PROJECT_NOT_FOUND");

    const subject = admitSubject(args);
    if (Date.parse(subject.observedAt) > Date.now() + maximumObservationFutureSkewMs) {
      throw new RangeError("GitHub observation time cannot be in the future");
    }
    const attachment = await ctx.db
      .query("projectAttachments")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (
      !attachment
      || attachment.externalId !== subject.instructionSet.projectAttachmentId
      || attachment.snapshotSha256
        !== subject.instructionSet.projectAttachmentSnapshotSha256
    ) {
      throw new Error(
        "GitHub issue context must bind the current accepted project attachment",
      );
    }
    if (!attachmentDeclaresRepository(
      attachment.snapshotJson,
      attachment.snapshotSha256,
      attachment.contentSha256,
      attachment.sourcePath,
      projectSlug,
      subject.snapshot.reference.repositoryFullName,
    )) {
      throw new Error(
        `Repository ${subject.snapshot.reference.repositoryFullName} is not declared by the accepted project attachment`,
      );
    }

    const existingObservation = await ctx.db
      .query("githubProjectContexts")
      .withIndex("by_project_observation", (q) =>
        q.eq("projectId", project._id).eq("observationRef", subject.observationRef)
      )
      .unique();
    if (existingObservation) {
      const existing = admitStoredRecord(existingObservation, workspaceSlug, projectSlug);
      if (!isExactReplay(existingObservation, subject)) {
        throw new Error("GITHUB_PROJECT_CONTEXT_OBSERVATION_CONFLICT");
      }
      return { record: existing, replayed: true };
    }

    const sourceRevisionBinding = await ctx.db
      .query("githubProjectContexts")
      .withIndex("by_project_issue_revision", (q) =>
        q.eq("projectId", project._id)
          .eq("issueExternalId", subject.snapshot.reference.externalId)
          .eq("sourceRevision", subject.snapshot.sourceRevision)
      )
      .order("asc")
      .first();
    const admittedSourceRevisionBinding = sourceRevisionBinding === null
      ? null
      : admitStoredRecord(sourceRevisionBinding, workspaceSlug, projectSlug);
    if (
      admittedSourceRevisionBinding
      && admittedSourceRevisionBinding.contentSha256
        !== subject.snapshot.contentSha256
    ) {
      throw new Error("GITHUB_PROJECT_CONTEXT_SOURCE_REVISION_CONFLICT");
    }

    const current = await ctx.db
      .query("githubProjectContexts")
      .withIndex("by_project_issue_current", (q) =>
        q.eq("projectId", project._id)
          .eq("issueExternalId", subject.snapshot.reference.externalId)
          .eq("isCurrent", true)
      )
      .unique();
    const classification = classifyGitHubIssueContextAcceptance(
      current === null
        ? null
        : {
          sourceRevision: current.sourceRevision,
          contentSha256: current.contentSha256,
          providerUpdatedAt: new Date(current.providerUpdatedAt).toISOString(),
          instructionSetId: current.instructionSetId,
          observedAt: new Date(current.observedAt).toISOString(),
        },
      {
        snapshot: subject.snapshot,
        instructionSetId: subject.instructionSet.id,
        observedAt: subject.observedAt,
      },
    );
    if (classification.isCurrent && current) {
      await ctx.db.patch(current._id, { isCurrent: false });
    }

    const acceptedAt = Date.now();
    const externalId = deterministicRecordId(
      workspaceSlug,
      projectSlug,
      subject.observationRef,
    );
    const id = await ctx.db.insert("githubProjectContexts", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId,
      issueExternalId: subject.snapshot.reference.externalId,
      repositoryFullName: subject.snapshot.reference.repositoryFullName,
      sourceRevision: subject.snapshot.sourceRevision,
      snapshotSha256: subject.snapshot.snapshotSha256,
      contentSha256: subject.snapshot.contentSha256,
      providerUpdatedAt: Date.parse(subject.snapshot.updatedAt),
      snapshotJson: canonicalGitHubIssueContextJson(subject.snapshot),
      projectAttachmentExternalId: subject.instructionSet.projectAttachmentId,
      projectAttachmentSnapshotSha256:
        subject.instructionSet.projectAttachmentSnapshotSha256,
      instructionSetId: subject.instructionSet.id,
      instructionSetSha256: subject.instructionSet.sha256,
      instructionSetJson: canonicalRepositoryInstructionSetJson(subject.instructionSet),
      syncStatus: subject.syncStatus,
      ...(subject.syncCursor === null ? {} : { syncCursor: subject.syncCursor }),
      ...(subject.degradedReasonCode === null
        ? {}
        : { degradedReasonCode: subject.degradedReasonCode }),
      observationRef: subject.observationRef,
      observedAt: Date.parse(subject.observedAt),
      acceptedBy: subject.acceptedBy,
      acceptedAt,
      isCurrent: classification.isCurrent,
      outcome: classification.outcome,
    });
    const inserted = await ctx.db.get("githubProjectContexts", id);
    if (!inserted) throw new Error("GITHUB_PROJECT_CONTEXT_MISSING");
    return {
      record: admitStoredRecord(inserted, workspaceSlug, projectSlug),
      replayed: false,
    };
  },
});

export const getCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    externalId: v.string(),
  },
  returns: v.union(publicRecordValidator, v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return null;
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return null;
    const externalId = canonicalIssueExternalId(args.externalId);
    const row = await ctx.db
      .query("githubProjectContexts")
      .withIndex("by_project_issue_current", (q) =>
        q.eq("projectId", project._id)
          .eq("issueExternalId", externalId)
          .eq("isCurrent", true)
      )
      .unique();
    return row ? admitStoredRecord(row, workspaceSlug, projectSlug) : null;
  },
});

export const listCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    limit: v.number(),
  },
  returns: v.array(publicRecordValidator),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return [];
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return [];
    const limit = boundedLimit(args.limit, maximumCurrent);
    const rows = await ctx.db
      .query("githubProjectContexts")
      .withIndex("by_project_current_issue", (q) =>
        q.eq("projectId", project._id).eq("isCurrent", true)
      )
      .take(limit);
    return rows.map((row) => admitStoredRecord(row, workspaceSlug, projectSlug));
  },
});

export const listHistory = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    externalId: v.string(),
    limit: v.number(),
  },
  returns: v.array(publicRecordValidator),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return [];
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) return [];
    const externalId = canonicalIssueExternalId(args.externalId);
    const limit = boundedLimit(args.limit, maximumHistory);
    const rows = await ctx.db
      .query("githubProjectContexts")
      .withIndex("by_project_issue_accepted", (q) =>
        q.eq("projectId", project._id).eq("issueExternalId", externalId)
      )
      .order("desc")
      .take(limit);
    return rows.reverse().map((row) =>
      admitStoredRecord(row, workspaceSlug, projectSlug)
    );
  },
});

function admitSubject(args: {
  snapshotJson: string;
  instructionSetJson: string;
  syncStatus: "synchronized" | "degraded";
  syncCursor: string | null;
  degradedReasonCode: string | null;
  observationRef: string;
  observedAt: string;
  acceptedBy: string;
}): AcceptedSubject {
  const snapshotValue = parseStrictJson(args.snapshotJson, {
    maxBytes: 512_000,
    maxDepth: 20,
    maxStringLength: 131_072,
    maxObjectKeys: 128,
    maxArrayLength: 128,
    prefix: "GITHUB_PROJECT_CONTEXT_SNAPSHOT",
  });
  const instructionValue = parseStrictJson(args.instructionSetJson, {
    maxBytes: 128_000,
    maxDepth: 8,
    maxStringLength: 4_096,
    maxObjectKeys: 64,
    maxArrayLength: 32,
    prefix: "GITHUB_PROJECT_CONTEXT_INSTRUCTIONS",
  });
  const snapshot = admitGitHubIssueContextSnapshot(snapshotValue);
  const instructionSet = admitAcceptedRepositoryInstructionSet(instructionValue);
  if (canonicalGitHubIssueContextJson(snapshot) !== args.snapshotJson) {
    throw new RangeError("GitHub issue context snapshot JSON must be canonical");
  }
  if (canonicalRepositoryInstructionSetJson(instructionSet) !== args.instructionSetJson) {
    throw new RangeError("Repository instruction set JSON must be canonical");
  }
  return admitGitHubIssueContextAcceptanceSubject({
    snapshot,
    instructionSet,
    syncStatus: args.syncStatus,
    syncCursor: args.syncCursor,
    degradedReasonCode: args.degradedReasonCode,
    observationRef: args.observationRef,
    observedAt: args.observedAt,
    acceptedBy: args.acceptedBy,
  });
}

function admitStoredRecord(
  row: {
    externalId: string;
    issueExternalId: string;
    repositoryFullName: string;
    sourceRevision: string;
    snapshotSha256: string;
    contentSha256: string;
    providerUpdatedAt: number;
    snapshotJson: string;
    projectAttachmentExternalId: string;
    projectAttachmentSnapshotSha256: string;
    instructionSetId: string;
    instructionSetSha256: string;
    instructionSetJson: string;
    syncStatus: "synchronized" | "degraded";
    syncCursor?: string;
    degradedReasonCode?: string;
    observationRef: string;
    observedAt: number;
    acceptedBy: string;
    acceptedAt: number;
    isCurrent: boolean;
    outcome: AcceptedOutcome;
  },
  workspace: string,
  project: string,
) {
  const subject = admitSubject({
    snapshotJson: row.snapshotJson,
    instructionSetJson: row.instructionSetJson,
    syncStatus: row.syncStatus,
    syncCursor: row.syncCursor ?? null,
    degradedReasonCode: row.degradedReasonCode ?? null,
    observationRef: row.observationRef,
    observedAt: exactStoredTimestamp(row.observedAt),
    acceptedBy: row.acceptedBy,
  });
  const acceptedAt = exactStoredTimestamp(row.acceptedAt);
  if (
    subject.snapshot.reference.externalId !== row.issueExternalId
    || subject.snapshot.reference.repositoryFullName !== row.repositoryFullName
    || subject.snapshot.sourceRevision !== row.sourceRevision
    || subject.snapshot.snapshotSha256 !== row.snapshotSha256
    || subject.snapshot.contentSha256 !== row.contentSha256
    || Date.parse(subject.snapshot.updatedAt) !== row.providerUpdatedAt
    || subject.instructionSet.projectAttachmentId !== row.projectAttachmentExternalId
    || subject.instructionSet.projectAttachmentSnapshotSha256
      !== row.projectAttachmentSnapshotSha256
    || subject.instructionSet.id !== row.instructionSetId
    || subject.instructionSet.sha256 !== row.instructionSetSha256
    || deterministicRecordId(workspace, project, row.observationRef) !== row.externalId
  ) {
    throw new Error("GITHUB_PROJECT_CONTEXT_STORED_RECORD_INVALID");
  }
  return {
    id: row.externalId,
    project,
    externalId: row.issueExternalId,
    repositoryFullName: row.repositoryFullName,
    sourceRevision: row.sourceRevision,
    snapshotSha256: row.snapshotSha256,
    contentSha256: row.contentSha256,
    providerUpdatedAt: subject.snapshot.updatedAt,
    snapshotJson: row.snapshotJson,
    projectAttachmentId: row.projectAttachmentExternalId,
    projectAttachmentSnapshotSha256: row.projectAttachmentSnapshotSha256,
    instructionSetId: row.instructionSetId,
    instructionSetSha256: row.instructionSetSha256,
    instructionSetJson: row.instructionSetJson,
    syncStatus: row.syncStatus,
    syncCursor: row.syncCursor ?? null,
    degradedReasonCode: row.degradedReasonCode ?? null,
    observationRef: row.observationRef,
    observedAt: subject.observedAt,
    acceptedBy: subject.acceptedBy,
    acceptedAt,
    isCurrent: row.isCurrent,
    outcome: row.outcome,
  };
}

function isExactReplay(
  row: {
    issueExternalId: string;
    snapshotSha256: string;
    projectAttachmentExternalId: string;
    projectAttachmentSnapshotSha256: string;
    instructionSetId: string;
    instructionSetSha256: string;
    syncStatus: "synchronized" | "degraded";
    syncCursor?: string;
    degradedReasonCode?: string;
    observedAt: number;
    acceptedBy: string;
  },
  subject: AcceptedSubject,
): boolean {
  return row.issueExternalId === subject.snapshot.reference.externalId
    && row.snapshotSha256 === subject.snapshot.snapshotSha256
    && row.projectAttachmentExternalId === subject.instructionSet.projectAttachmentId
    && row.projectAttachmentSnapshotSha256
      === subject.instructionSet.projectAttachmentSnapshotSha256
    && row.instructionSetId === subject.instructionSet.id
    && row.instructionSetSha256 === subject.instructionSet.sha256
    && row.syncStatus === subject.syncStatus
    && (row.syncCursor ?? null) === subject.syncCursor
    && (row.degradedReasonCode ?? null) === subject.degradedReasonCode
    && row.observedAt === Date.parse(subject.observedAt)
    && row.acceptedBy === subject.acceptedBy;
}

function deterministicRecordId(
  workspace: string,
  project: string,
  observationRef: string,
): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace,
    project,
    observationRef,
  });
  return `github_context_${digest.slice("sha256:".length)}`;
}

function attachmentDeclaresRepository(
  snapshotJson: string,
  snapshotSha256: string,
  contentSha256: string,
  sourcePath: string,
  project: string,
  repositoryFullName: string,
): boolean {
  const value = parseStrictJson(snapshotJson, {
    maxBytes: 256_000,
    maxDepth: 16,
    maxStringLength: 20_000,
    maxObjectKeys: 128,
    maxArrayLength: 64,
    prefix: "PROJECT_ATTACHMENT_SNAPSHOT",
  });
  if (!isRecord(value) || !hasExactKeys(value, [
    "contract",
    "context",
    "format",
    "schemaVersion",
    "snapshotSha256",
    "source",
  ])) return false;
  if (
    value.format !== "stensibly.project-attachment"
    || value.schemaVersion !== 1
    || value.snapshotSha256 !== snapshotSha256
    || !isRecord(value.contract)
    || !isRecord(value.context)
    || !isRecord(value.source)
    || !Array.isArray(value.contract.repositories)
    || value.contract.project !== project
    || value.source.contentSha256 !== contentSha256
    || value.source.path !== sourcePath
  ) return false;
  const base = { ...value };
  delete base.snapshotSha256;
  if (fingerprintExactText(JSON.stringify(base)) !== snapshotSha256) return false;
  const target = canonicalRepository(repositoryFullName);
  return target !== null && value.contract.repositories.some((entry) =>
    typeof entry === "string" && canonicalRepository(entry) === target
  );
}

function canonicalRepository(value: string): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  let owner: string | undefined;
  let repository: string | undefined;
  const plain = /^([^/:]+)\/([^/]+)$/u.exec(value);
  if (plain) {
    owner = plain[1];
    repository = plain[2];
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (
      url.hostname.toLowerCase() !== "github.com"
      || !["http:", "https:", "ssh:"].includes(url.protocol)
      || url.password
      || url.search
      || url.hash
      || ((url.protocol === "http:" || url.protocol === "https:") && url.username)
      || (url.protocol === "ssh:" && url.username && url.username !== "git")
      || (url.port && url.port !== "22")
    ) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    [owner, repository] = parts;
  }
  repository = repository?.replace(/\.git$/iu, "");
  if (
    !owner
    || !repository
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository)
    || repository === "."
    || repository === ".."
    || repository.includes("..")
  ) return null;
  return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function canonicalIssueExternalId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("GitHub issue external ID is invalid");
  }
  const match = /^github:([^/]+)\/([^#]+)#([1-9][0-9]*)$/u.exec(value);
  if (!match) throw new RangeError("GitHub issue external ID is invalid");
  const repository = canonicalRepository(`${match[1]}/${match[2]}`);
  if (repository === null) throw new RangeError("GitHub issue external ID is invalid");
  return `github:${repository}#${match[3]}`;
}

function exactStoredTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("GITHUB_PROJECT_CONTEXT_STORED_RECORD_INVALID");
  }
  return new Date(value).toISOString();
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`GitHub project context limit must be 1-${maximum}`);
  }
  return value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const sortedExpected = [...expected].sort(codeUnitCompare);
  return actual.length === sortedExpected.length
    && actual.every((entry, index) => entry === sortedExpected[index]);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
