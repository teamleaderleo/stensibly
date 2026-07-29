import { createHash } from "node:crypto";
import { z } from "zod";
import {
  buildGitHubIssueReference,
  compareGitHubIssueContexts,
  type GitHubIssueContext,
} from "./github-issue-context.js";
import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";

const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const workspaceSchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Use a lowercase workspace identifier");
const projectSchema = z.string().trim().min(1).max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug");
const stableIdSchema = z.string().trim().min(1).max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@#+-]*$/, "Use a stable bounded identifier");
const acceptedBySchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: false }).transform((value) =>
  new Date(value).toISOString()
);
const sourcePathSchema = z.string().trim().min(1).max(4096).superRefine((value, context) => {
  if (
    value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    context.addIssue({ code: "custom", message: "Use a repository-relative source path" });
  }
});

const instructionSourceSchema = z.object({
  path: sourcePathSchema,
  revision: stableIdSchema,
  contentSha256: hashSchema,
}).strict();

const instructionSetBaseSchema = z.object({
  version: z.literal(1),
  project: projectSchema,
  projectAttachmentId: stableIdSchema,
  projectAttachmentSnapshotSha256: hashSchema,
  sources: z.array(instructionSourceSchema).min(1).max(32),
}).strict();

const instructionSetSchema = instructionSetBaseSchema.extend({
  snapshotSha256: hashSchema,
}).strict();

export interface AcceptedInstructionSource {
  path: string;
  revision: string;
  contentSha256: string;
}

export interface AcceptedInstructionSetIdentity {
  version: 1;
  project: string;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  sources: AcceptedInstructionSource[];
  snapshotSha256: string;
}

export interface GitHubProjectIssueContextRecord {
  id: string;
  workspace: string;
  project: string;
  context: GitHubIssueContext;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  instructionSet: AcceptedInstructionSetIdentity;
  observedAt: string;
  acceptedBy: string;
  acceptedAt: string;
}

export interface AcceptGitHubProjectIssueContextInput {
  workspace: string;
  project: string;
  context: unknown;
  instructionSet: unknown;
  observedAt: string;
  acceptedBy: string;
}

export interface GitHubProjectIssueContextAcceptance {
  record: GitHubProjectIssueContextRecord;
  replayed: boolean;
  comparison: "initial" | "identical" | "updated" | "binding_changed";
}

export interface PreparedGitHubProjectIssueContextAcceptance {
  workspace: string;
  project: string;
  context: GitHubIssueContext;
  instructionSet: AcceptedInstructionSetIdentity;
  observedAt: string;
  acceptedBy: string;
  comparison: GitHubProjectIssueContextAcceptance["comparison"];
  replay: GitHubProjectIssueContextRecord | null;
}

export interface GitHubProjectContextFreshness {
  state: "fresh" | "stale" | "degraded";
  observedAt: string;
  ageSeconds: number;
  maximumAgeSeconds: number;
  sourceAvailable: boolean;
}

export class GitHubProjectContextConflictError extends Error {
  constructor(message = "GitHub issue source revision conflicts with the accepted snapshot") {
    super(message);
    this.name = "GitHubProjectContextConflictError";
  }
}

export class GitHubProjectContextStaleError extends Error {
  constructor() {
    super("A stale GitHub issue observation cannot replace newer accepted context");
    this.name = "GitHubProjectContextStaleError";
  }
}

export function buildAcceptedInstructionSetIdentity(input: {
  project: string;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  sources: readonly AcceptedInstructionSource[];
}): AcceptedInstructionSetIdentity {
  const base = instructionSetBaseSchema.parse({
    version: 1,
    project: input.project,
    projectAttachmentId: input.projectAttachmentId,
    projectAttachmentSnapshotSha256: input.projectAttachmentSnapshotSha256,
    sources: canonicalInstructionSources(input.sources),
  });
  return deepFreeze({
    ...base,
    snapshotSha256: sha256(stableJson(base)),
  }) as AcceptedInstructionSetIdentity;
}

export function parseAcceptedInstructionSetIdentity(
  value: unknown,
): AcceptedInstructionSetIdentity {
  const parsed = instructionSetSchema.parse(value);
  const canonical = canonicalInstructionSources(parsed.sources);
  if (stableJson(canonical) !== stableJson(parsed.sources)) {
    throw new Error("Accepted instruction sources are not canonical");
  }
  const { snapshotSha256, ...base } = parsed;
  if (snapshotSha256 !== sha256(stableJson(base))) {
    throw new Error("Accepted instruction-set fingerprint is invalid");
  }
  return deepFreeze(parsed) as AcceptedInstructionSetIdentity;
}

export function parseStoredGitHubIssueContext(value: unknown): GitHubIssueContext {
  const parsed = githubIssueContextSchema.parse(value) as GitHubIssueContext;
  const canonicalReference = buildGitHubIssueReference(parsed.reference);
  if (stableJson(canonicalReference) !== stableJson(parsed.reference)) {
    throw new Error("Stored GitHub issue reference is not canonical");
  }
  assertSortedUnique(parsed.labels, "GitHub issue labels");
  assertSortedUnique(parsed.assignees, "GitHub issue assignees");
  assertCanonicalRelationships(parsed);
  if (!parsed.bodyRevision.present && parsed.bodyRevision.byteLength !== 0) {
    throw new Error("Absent GitHub issue bodies must have zero byte length");
  }
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt)) {
    throw new Error("Stored GitHub issue update precedes creation");
  }

  const { snapshotSha256, contentSha256, sourceRevision, ...content } = parsed;
  if (contentSha256 !== sha256(stableJson(content))) {
    throw new Error("Stored GitHub issue content fingerprint is invalid");
  }
  if (
    snapshotSha256 !== sha256(stableJson({
      ...content,
      sourceRevision,
      contentSha256,
    }))
  ) {
    throw new Error("Stored GitHub issue snapshot fingerprint is invalid");
  }

  compareGitHubIssueContexts(parsed, parsed);
  return deepFreeze(parsed);
}

export function prepareGitHubProjectIssueContextAcceptance(
  current: GitHubProjectIssueContextRecord | null,
  attachment: ProjectAttachmentRecord | null,
  input: AcceptGitHubProjectIssueContextInput,
): PreparedGitHubProjectIssueContextAcceptance {
  const workspace = workspaceSchema.parse(input.workspace);
  const project = projectSchema.parse(input.project);
  const context = parseStoredGitHubIssueContext(input.context);
  const instructionSet = parseAcceptedInstructionSetIdentity(input.instructionSet);
  const observedAt = timestampSchema.parse(input.observedAt);
  const acceptedBy = acceptedBySchema.parse(input.acceptedBy);

  if (!attachment || attachment.project !== project) {
    throw new Error(`Project ${project} has no accepted project attachment`);
  }
  if (
    instructionSet.project !== project
    || instructionSet.projectAttachmentId !== attachment.id
    || instructionSet.projectAttachmentSnapshotSha256 !== attachment.snapshot.snapshotSha256
  ) {
    throw new Error("Accepted instruction-set identity does not match the current project attachment");
  }
  if (!attachmentAllowsRepository(
    attachment.snapshot.contract.repositories,
    context.reference.repositoryFullName,
  )) {
    throw new Error(
      `GitHub repository ${context.reference.repositoryFullName} is outside the accepted project attachment`,
    );
  }
  if (Date.parse(observedAt) < Date.parse(context.updatedAt)) {
    throw new Error("GitHub issue observation time must not precede the provider update time");
  }

  if (!current) {
    return {
      workspace,
      project,
      context,
      instructionSet,
      observedAt,
      acceptedBy,
      comparison: "initial",
      replay: null,
    };
  }
  if (
    current.workspace !== workspace
    || current.project !== project
    || current.context.reference.externalId !== context.reference.externalId
  ) {
    throw new Error("Current GitHub project context identity does not match the acceptance route");
  }

  const issueComparison = compareGitHubIssueContexts(current.context, context);
  if (issueComparison.outcome === "altered_revision_conflict") {
    throw new GitHubProjectContextConflictError();
  }
  if (issueComparison.outcome === "stale") {
    throw new GitHubProjectContextStaleError();
  }
  if (issueComparison.outcome === "different_issue") {
    throw new Error("Current GitHub project context points to a different issue");
  }

  const bindingUnchanged =
    current.projectAttachmentId === attachment.id
    && current.projectAttachmentSnapshotSha256 === attachment.snapshot.snapshotSha256
    && current.instructionSet.snapshotSha256 === instructionSet.snapshotSha256;

  if (
    issueComparison.outcome === "identical"
    && bindingUnchanged
    && current.observedAt === observedAt
  ) {
    return {
      workspace,
      project,
      context,
      instructionSet,
      observedAt,
      acceptedBy,
      comparison: "identical",
      replay: current,
    };
  }

  return {
    workspace,
    project,
    context,
    instructionSet,
    observedAt,
    acceptedBy,
    comparison: bindingUnchanged
      ? issueComparison.outcome === "updated" ? "updated" : "identical"
      : "binding_changed",
    replay: null,
  };
}

export function projectGitHubContextFreshness(input: {
  record: GitHubProjectIssueContextRecord;
  now?: string | Date;
  maximumAgeSeconds: number;
  sourceAvailable: boolean;
}): GitHubProjectContextFreshness {
  if (!Number.isSafeInteger(input.maximumAgeSeconds) || input.maximumAgeSeconds < 1) {
    throw new RangeError("Maximum GitHub context age must be a positive integer");
  }
  const now = input.now instanceof Date
    ? new Date(input.now)
    : input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError("Freshness time is invalid");
  const observedAt = new Date(timestampSchema.parse(input.record.observedAt));
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 1000));
  return {
    state: !input.sourceAvailable
      ? "degraded"
      : ageSeconds > input.maximumAgeSeconds ? "stale" : "fresh",
    observedAt: observedAt.toISOString(),
    ageSeconds,
    maximumAgeSeconds: input.maximumAgeSeconds,
    sourceAvailable: input.sourceAvailable,
  };
}

const githubIssueReferenceSchema = z.object({
  provider: z.literal("github"),
  host: z.literal("github.com"),
  owner: z.string(),
  repository: z.string(),
  repositoryFullName: z.string(),
  number: z.number().int().positive(),
  externalId: z.string(),
  canonicalUrl: z.string().url(),
}).strict();

const githubIssueContextSchema = z.object({
  version: z.literal(1),
  provider: z.literal("github"),
  reference: githubIssueReferenceSchema,
  title: z.string().min(1).max(256),
  bodyRevision: z.object({
    present: z.boolean(),
    byteLength: z.number().int().min(0).max(128 * 1024),
    sha256: hashSchema,
  }).strict(),
  state: z.enum(["open", "closed"]),
  stateReason: z.enum(["completed", "not_planned", "reopened"]).nullable(),
  labels: z.array(z.string().min(1).max(100)).max(100),
  assignees: z.array(z.string().min(1).max(39)).max(100),
  milestone: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
  }).strict().nullable(),
  relationships: z.array(z.object({
    kind: z.enum(["parent", "sub_issue", "blocked_by", "blocks", "related"]),
    target: githubIssueReferenceSchema,
  }).strict()).max(100),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  providerNodeId: z.string().min(1).max(256).nullable(),
  sourceRevision: stableIdSchema,
  contentSha256: hashSchema,
  snapshotSha256: hashSchema,
  containsIssueBody: z.literal(false),
}).strict();

function canonicalInstructionSources(
  sources: readonly AcceptedInstructionSource[],
): AcceptedInstructionSource[] {
  const parsed = z.array(instructionSourceSchema).min(1).max(32).parse(sources);
  const keys = parsed.map((source) => source.path);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Accepted instruction source paths must be unique");
  }
  return [...parsed].sort((left, right) => codeUnitCompare(left.path, right.path));
}

function assertSortedUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
  const sorted = [...values].sort(codeUnitCompare);
  if (stableJson(sorted) !== stableJson(values)) throw new Error(`${label} are not canonical`);
}

function assertCanonicalRelationships(context: GitHubIssueContext): void {
  const keys = context.relationships.map((relationship) => {
    const target = buildGitHubIssueReference(relationship.target);
    if (stableJson(target) !== stableJson(relationship.target)) {
      throw new Error("Stored GitHub issue relationship target is not canonical");
    }
    if (target.externalId === context.reference.externalId) {
      throw new Error("Stored GitHub issue relationship targets itself");
    }
    return `${relationship.kind}:${target.externalId}`;
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error("Stored GitHub issue relationships must be unique");
  }
  if (stableJson([...keys].sort(codeUnitCompare)) !== stableJson(keys)) {
    throw new Error("Stored GitHub issue relationships are not canonical");
  }
}

function attachmentAllowsRepository(
  repositories: readonly string[],
  repositoryFullName: string,
): boolean {
  const target = repositoryFullName.toLowerCase();
  return repositories.some((repository) => normalizeRepository(repository) === target);
}

function normalizeRepository(value: string): string | null {
  let repository = value.trim().toLowerCase();
  repository = repository
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) ? repository : null;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Canonical JSON number must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (typeof value !== "object" || value === null) {
    throw new RangeError("Canonical JSON value is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(codeUnitCompare);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
