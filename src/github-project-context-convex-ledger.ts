import { z } from "zod";
import { convexApi } from "../convex/refs.js";
import {
  ConvexWorkLedger,
  type ConvexWorkLedgerOptions,
} from "./convex-ledger.js";
import type { GitHubIssueContext } from "./github-issue-context.js";
import type {
  GetGitHubProjectContextInput,
  GitHubIssueContextHistoryProjection,
  GitHubIssueContextProjection,
  GitHubProjectContextLedger,
  GitHubProjectContextProjection,
} from "./github-project-context.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export interface RepositoryInstructionSourceInput {
  path: string;
  revision: string;
  contentSha256: string;
}

export interface AcceptHostedGitHubIssueContextInput {
  project: string;
  snapshot: GitHubIssueContext;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  instructionSources: readonly RepositoryInstructionSourceInput[];
  syncStatus: "synchronized" | "degraded";
  syncCursor?: string | null;
  degradedReasonCode?: string | null;
  observationRef: string;
  observedAt: string;
  acceptedBy: string;
}

export interface HostedGitHubIssueContextAcceptance {
  recordId: string;
  externalId: string;
  outcome:
    | "initial"
    | "updated"
    | "stale"
    | "instruction_rebound"
    | "synchronization_updated";
  isCurrent: boolean;
  replayed: boolean;
}

const rawRecordSchema = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  externalId: z.string().min(1),
  snapshotJson: z.string().min(1),
  instructionSetJson: z.string().min(1),
  syncStatus: z.enum(["synchronized", "degraded"]),
  syncCursor: z.string().nullable(),
  degradedReasonCode: z.string().nullable(),
  observationRef: z.string().min(1),
  observedAt: z.string().datetime(),
  acceptedBy: z.string().min(1),
  acceptedAt: z.string().datetime(),
  isCurrent: z.boolean(),
  outcome: z.enum([
    "initial",
    "updated",
    "stale",
    "instruction_rebound",
    "synchronization_updated",
  ]),
}).strict();

const acceptanceSchema = z.object({
  record: rawRecordSchema,
  replayed: z.boolean(),
}).strict();

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

type RawRecord = z.infer<typeof rawRecordSchema>;

interface AcceptedInstructionSet {
  version: 1;
  id: string;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  sources: Array<{
    path: string;
    revision: string;
    contentSha256: string;
  }>;
  sha256: string;
}

const recoveryGuidance: GitHubProjectContextProjection["recovery"]["guidance"] = [
  {
    code: "use_normal_chat",
    instruction:
      "Use a normal ChatGPT conversation; agent mode and company knowledge do not expose the write-capable app combination used for GitHub and Stensibly dogfood.",
  },
  {
    code: "select_github_and_stensibly",
    instruction:
      "Explicitly select both GitHub and Stensibly before asking to continue the issue or repository workflow.",
  },
  {
    code: "start_new_conversation_on_host_binding_failure",
    instruction:
      "If schemas appear but GitHub calls are unavailable or forbidden before any Stensibly request receipt, start a new conversation because the failure is in conversation-host tool binding.",
  },
  {
    code: "refresh_stensibly_actions_on_manifest_drift",
    instruction:
      "If Stensibly reports a stale action manifest, refresh or recreate the Stensibly app before retrying.",
  },
  {
    code: "reconnect_oauth_on_worker_auth_failure",
    instruction:
      "If a request reaches Stensibly and reports authentication failure, reconnect OAuth and retry the same bounded read.",
  },
];

export class ConvexGitHubProjectContextLedger extends ConvexWorkLedger
  implements GitHubProjectContextLedger {
  constructor(options: ConvexWorkLedgerOptions) {
    super(options);
  }

  async acceptGitHubIssueContext(
    input: AcceptHostedGitHubIssueContextInput,
  ): Promise<HostedGitHubIssueContextAcceptance> {
    const project = boundedProject(input.project);
    validateSnapshot(input.snapshot);
    const instructionSet = buildInstructionSet({
      projectAttachmentId: input.projectAttachmentId,
      projectAttachmentSnapshotSha256: input.projectAttachmentSnapshotSha256,
      sources: input.instructionSources,
    });
    const raw = acceptanceSchema.parse(await this.client.mutation(
      convexApi.githubProjectContexts.accept,
      this.contextArgs({
        project,
        snapshotJson: JSON.stringify(input.snapshot),
        projectAttachmentId: instructionSet.projectAttachmentId,
        projectAttachmentSnapshotSha256: instructionSet.projectAttachmentSnapshotSha256,
        instructionSetJson: JSON.stringify(instructionSet),
        syncStatus: input.syncStatus,
        syncCursor: input.syncCursor ?? null,
        degradedReasonCode: input.degradedReasonCode ?? null,
        observationRef: input.observationRef,
        observedAt: canonicalTimestamp(input.observedAt, "GitHub observation time"),
        acceptedBy: input.acceptedBy,
      }),
    ));
    const mapped = mapRawRecord(raw.record);
    if (
      mapped.snapshot.reference.externalId !== input.snapshot.reference.externalId
      || mapped.snapshot.snapshotSha256 !== input.snapshot.snapshotSha256
      || mapped.instructionSet.id !== instructionSet.id
    ) {
      throw new Error("Hosted GitHub context response does not match the accepted request");
    }
    return {
      recordId: raw.record.id,
      externalId: raw.record.externalId,
      outcome: raw.record.outcome,
      isCurrent: raw.record.isCurrent,
      replayed: raw.replayed,
    };
  }

  async getGitHubProjectContext(
    input: GetGitHubProjectContextInput,
  ): Promise<GitHubProjectContextProjection> {
    const project = boundedProject(input.project);
    const limit = boundedLimit(input.limit, 20, 100, "GitHub project context limit");
    const historyLimit = boundedLimit(
      input.historyLimit,
      10,
      50,
      "GitHub issue context history limit",
    );
    const requestedExternalId = input.externalId === undefined
      ? null
      : canonicalExternalId(input.externalId);
    const rawRecords = requestedExternalId === null
      ? z.array(rawRecordSchema).parse(await this.client.query(
        convexApi.githubProjectContexts.listCurrent,
        this.contextArgs({ project, limit }),
      ))
      : await this.currentRecord(project, requestedExternalId);
    const records = rawRecords.map(mapRawRecord);
    const history = requestedExternalId === null
      ? []
      : z.array(rawRecordSchema).parse(await this.client.query(
        convexApi.githubProjectContexts.listHistory,
        this.contextArgs({ project, externalId: requestedExternalId, limit: historyLimit }),
      )).map(mapRawRecord);
    const issues = records.map(projectIssue);

    return {
      version: 1,
      workspace: this.workspace,
      project,
      mode: requestedExternalId === null ? "project" : "issue",
      requestedExternalId,
      issues,
      history: history.map(projectHistory),
      recovery: {
        canonicalSource: "github",
        stensiblyProjection: "last_known_accepted_context",
        incidentUrl: "https://github.com/teamleaderleo/stensibly/issues/490",
        directGitHubUrls: issues.map((issue) => issue.canonicalUrl),
        guidance: recoveryGuidance.map((entry) => ({ ...entry })),
      },
    };
  }

  private async currentRecord(project: string, externalId: string): Promise<RawRecord[]> {
    const raw = await this.client.query(
      convexApi.githubProjectContexts.getCurrent,
      this.contextArgs({ project, externalId }),
    );
    return raw === null ? [] : [rawRecordSchema.parse(raw)];
  }

  private contextArgs(input: object): Record<string, unknown> {
    return {
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
      ...input,
    };
  }
}

function mapRawRecord(raw: RawRecord): {
  raw: RawRecord;
  snapshot: GitHubIssueContext;
  instructionSet: AcceptedInstructionSet;
} {
  const snapshot = parseSnapshot(raw.snapshotJson, raw.id);
  const instructionSet = parseInstructionSet(raw.instructionSetJson, raw.id);
  if (snapshot.reference.externalId !== raw.externalId) {
    throw new Error(`Hosted GitHub context ${raw.id} issue identity does not match its snapshot`);
  }
  return { raw, snapshot, instructionSet };
}

function projectIssue(record: ReturnType<typeof mapRawRecord>): GitHubIssueContextProjection {
  const { raw, snapshot, instructionSet } = record;
  return {
    externalId: raw.externalId,
    canonicalUrl: snapshot.reference.canonicalUrl,
    repositoryFullName: snapshot.reference.repositoryFullName,
    issueNumber: snapshot.reference.number,
    title: snapshot.title,
    state: snapshot.state,
    stateReason: snapshot.stateReason,
    labels: [...snapshot.labels],
    assignees: [...snapshot.assignees],
    milestone: snapshot.milestone ? { ...snapshot.milestone } : null,
    relationships: snapshot.relationships.map((relationship) => ({
      kind: relationship.kind,
      externalId: relationship.target.externalId,
      canonicalUrl: relationship.target.canonicalUrl,
    })),
    provider: {
      sourceRevision: snapshot.sourceRevision,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    },
    synchronization: {
      status: raw.syncStatus,
      degradedReasonCode: raw.degradedReasonCode,
      observedAt: raw.observedAt,
      acceptedAt: raw.acceptedAt,
      acceptedBy: raw.acceptedBy,
      outcome: raw.outcome,
    },
    instructions: {
      id: instructionSet.id,
      sourcePaths: instructionSet.sources.map((source) => source.path),
    },
  };
}

function projectHistory(
  record: ReturnType<typeof mapRawRecord>,
): GitHubIssueContextHistoryProjection {
  const { raw, snapshot, instructionSet } = record;
  return {
    externalId: raw.externalId,
    sourceRevision: snapshot.sourceRevision,
    providerUpdatedAt: snapshot.updatedAt,
    synchronizationStatus: raw.syncStatus,
    degradedReasonCode: raw.degradedReasonCode,
    observedAt: raw.observedAt,
    acceptedAt: raw.acceptedAt,
    outcome: raw.outcome,
    isCurrent: raw.isCurrent,
    instructionSetId: instructionSet.id,
  };
}

function buildInstructionSet(input: {
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  sources: readonly RepositoryInstructionSourceInput[];
}): AcceptedInstructionSet {
  const projectAttachmentId = boundedIdentifier(input.projectAttachmentId, "Project attachment ID");
  const projectAttachmentSnapshotSha256 = boundedHash(
    input.projectAttachmentSnapshotSha256,
    "Project attachment snapshot fingerprint",
  );
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 32) {
    throw new RangeError("Repository instruction sources must contain 1-32 entries");
  }
  const paths = new Set<string>();
  const sources = input.sources.map((source) => {
    const path = boundedSourcePath(source.path);
    if (paths.has(path)) throw new RangeError("Repository instruction source paths must be unique");
    paths.add(path);
    return {
      path,
      revision: boundedIdentifier(
        source.revision,
        "Repository instruction source revision",
        512,
      ),
      contentSha256: boundedHash(
        source.contentSha256,
        "Repository instruction source fingerprint",
      ),
    };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const canonical = {
    version: 1 as const,
    projectAttachmentId,
    projectAttachmentSnapshotSha256,
    sources,
  };
  const sha256 = fingerprintCanonicalRequest(canonical);
  return {
    ...canonical,
    id: `instructions_${sha256.slice("sha256:".length)}`,
    sha256,
  };
}

function parseSnapshot(value: string, recordId: string): GitHubIssueContext {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`Hosted GitHub context ${recordId} snapshot is not valid JSON`);
  }
  validateSnapshot(decoded);
  return decoded;
}

function validateSnapshot(snapshot: unknown): asserts snapshot is GitHubIssueContext {
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, snapshotKeys)) {
    throw new Error("GitHub issue context snapshot must contain only canonical bounded fields");
  }
  const reference = snapshot.reference;
  if (!isRecord(reference) || !hasExactKeys(reference, referenceKeys)) {
    throw new Error("GitHub issue context snapshot reference is invalid");
  }
  const {
    snapshotSha256,
    contentSha256,
    sourceRevision,
    ...content
  } = snapshot;
  if (
    typeof snapshotSha256 !== "string"
    || typeof contentSha256 !== "string"
    || typeof sourceRevision !== "string"
    || fingerprintCanonicalRequest(content) !== contentSha256
    || fingerprintCanonicalRequest({ ...content, sourceRevision, contentSha256 }) !== snapshotSha256
    || snapshot.version !== 1
    || snapshot.provider !== "github"
    || snapshot.containsIssueBody !== false
    || reference.provider !== "github"
    || reference.host !== "github.com"
  ) {
    throw new Error("GitHub issue context snapshot fingerprint is invalid");
  }
  const owner = boundedGitHubOwner(reference.owner);
  const repository = boundedGitHubRepository(reference.repository);
  const issueNumber = positiveInteger(reference.number, "GitHub issue number");
  const repositoryFullName = `${owner}/${repository}`;
  if (
    reference.repositoryFullName !== repositoryFullName
    || canonicalExternalId(reference.externalId) !== `github:${repositoryFullName}#${issueNumber}`
    || reference.canonicalUrl
      !== `https://github.com/${repositoryFullName}/issues/${issueNumber}`
  ) {
    throw new Error("GitHub issue context snapshot reference is not canonical");
  }
  const createdAt = Date.parse(canonicalTimestamp(snapshot.createdAt, "GitHub issue created time"));
  const updatedAt = Date.parse(canonicalTimestamp(snapshot.updatedAt, "GitHub issue updated time"));
  if (updatedAt < createdAt) {
    throw new Error("GitHub issue updated time must not precede creation time");
  }
}

function parseInstructionSet(value: string, recordId: string): AcceptedInstructionSet {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`Hosted GitHub context ${recordId} instruction set is not valid JSON`);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`Hosted GitHub context ${recordId} instruction set is invalid`);
  }
  const raw = decoded as Record<string, unknown>;
  const parsed = buildInstructionSet({
    projectAttachmentId: raw.projectAttachmentId as string,
    projectAttachmentSnapshotSha256: raw.projectAttachmentSnapshotSha256 as string,
    sources: raw.sources as RepositoryInstructionSourceInput[],
  });
  if (raw.version !== 1 || raw.id !== parsed.id || raw.sha256 !== parsed.sha256) {
    throw new Error(`Hosted GitHub context ${recordId} instruction fingerprint is invalid`);
  }
  return parsed;
}

function canonicalExternalId(value: unknown): string {
  if (typeof value !== "string") throw new RangeError("GitHub issue external ID must be a string");
  const match = /^github:([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(value.trim());
  if (!match) throw new RangeError("GitHub issue external ID is invalid");
  return `github:${boundedGitHubOwner(match[1]!)}/${boundedGitHubRepository(match[2]!)}#${Number(match[3])}`;
}

function boundedGitHubOwner(value: unknown): string {
  if (typeof value !== "string") throw new RangeError("GitHub owner identity is invalid");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) {
    throw new RangeError("GitHub owner identity is invalid");
  }
  return normalized;
}

function boundedGitHubRepository(value: unknown): string {
  if (typeof value !== "string") throw new RangeError("GitHub repository identity is invalid");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new RangeError("GitHub repository identity is invalid");
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function boundedProject(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 80
    || !/^[a-z0-9][a-z0-9_-]*$/.test(value)
  ) {
    throw new RangeError("GitHub project context project is invalid");
  }
  return value;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
  }
  return resolved;
}

function boundedIdentifier(value: string, label: string, maximum = 240): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(normalized)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function boundedHash(value: string, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new RangeError(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function boundedSourcePath(value: string): string {
  if (typeof value !== "string") throw new RangeError("Repository instruction source path is invalid");
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (
    normalized.length < 1
    || normalized.length > 240
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new RangeError("Repository instruction source path is invalid");
  }
  return normalized;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new RangeError(`${label} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
