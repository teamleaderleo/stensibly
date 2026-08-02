import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  admitAcceptedRepositoryInstructionSet,
  admitGitHubIssueContextSnapshot,
  type AcceptedRepositoryInstructionSet,
  type GitHubIssueContextAcceptanceOutcome,
} from "./github-project-context-admission.js";
import {
  parseGitHubIssueExternalId,
  type GitHubIssueContext,
} from "./github-issue-context.js";
import {
  ConvexGitHubProjectContextService,
  GitHubProjectContextStorageError,
} from "./github-project-context-convex-ledger.js";
import { snapshotBoundedJson } from "./github-repository-observation-admission.js";
import { parseStrictJson } from "./strict-json.js";

export const HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1 = 1 as const;

export interface GetHostedGitHubIssueContextBindingInput {
  project: string;
  externalId: string;
}

export interface HostedGitHubIssueContextBindingV1 {
  readonly version: typeof HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1;
  readonly workspace: string;
  readonly recordId: string;
  readonly project: string;
  readonly externalId: string;
  readonly repositoryFullName: string;
  readonly snapshot: GitHubIssueContext;
  readonly instructionSet: AcceptedRepositoryInstructionSet;
  readonly synchronization: {
    readonly status: "synchronized" | "degraded";
    readonly cursor: string | null;
    readonly degradedReasonCode: string | null;
    readonly observationRef: string;
    readonly observedAt: string;
    readonly acceptedBy: string;
    readonly acceptedAt: string;
    readonly outcome: GitHubIssueContextAcceptanceOutcome;
    readonly isCurrent: true;
  };
}

export interface HostedGitHubIssueContextBindingReader {
  getCurrentGitHubIssueContextBinding(
    input: GetHostedGitHubIssueContextBindingInput,
  ): Promise<HostedGitHubIssueContextBindingV1 | null>;
}

export interface ConvexGitHubProjectContextBindingReaderOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
  now?: () => number;
}

const listProjectsRef = makeFunctionReference<"query">("projects:list");
const getCurrentRef = makeFunctionReference<"query">(
  "githubProjectContexts:getCurrent",
);
const requestKeys = ["project", "externalId"] as const;
const projectRecordKeys = ["id", "slug", "name", "createdAt", "updatedAt"] as const;
const maximumProjects = 1_000;

type StoredRecord = {
  id: string;
  project: string;
  externalId: string;
  repositoryFullName: string;
  snapshotJson: string;
  instructionSetJson: string;
  syncStatus: "synchronized" | "degraded";
  syncCursor: string | null;
  degradedReasonCode: string | null;
  observationRef: string;
  observedAt: string;
  acceptedBy: string;
  acceptedAt: string;
  isCurrent: true;
  outcome: GitHubIssueContextAcceptanceOutcome;
};

export class ConvexGitHubProjectContextBindingReader
  implements HostedGitHubIssueContextBindingReader {
  readonly #client: ConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;
  readonly #now: () => number;

  constructor(options: ConvexGitHubProjectContextBindingReaderOptions) {
    this.#client = options.client;
    this.#serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.#workspace = exactWorkspace(options.workspace ?? "default");
    this.#now = options.now ?? Date.now;
  }

  async getCurrentGitHubIssueContextBinding(
    input: GetHostedGitHubIssueContextBindingInput,
  ): Promise<HostedGitHubIssueContextBindingV1 | null> {
    const { project, externalId } = admitBindingRequest(input);
    try {
      const projects = await this.#client.query(listProjectsRef, {
        serviceSecret: this.#serviceSecret,
        workspace: this.#workspace,
      });
      assertKnownProject(projects, project);

      const raw = await this.#client.query(getCurrentRef, {
        serviceSecret: this.#serviceSecret,
        workspace: this.#workspace,
        project,
        externalId,
      });
      if (raw === null) return null;

      const detached = snapshotBoundedJson(
        raw,
        "Hosted GitHub project context binding",
      );
      await validateThroughCanonicalService({
        record: detached,
        project,
        externalId,
        serviceSecret: this.#serviceSecret,
        workspace: this.#workspace,
        now: this.#now,
      });
      const record = detached as unknown as StoredRecord;
      if (record.isCurrent !== true || record.outcome === "stale") {
        throw new GitHubProjectContextStorageError();
      }
      const snapshot = admitSnapshotJson(record.snapshotJson);
      const instructionSet = admitInstructionJson(record.instructionSetJson);

      return deepFreeze({
        version: HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1,
        workspace: this.#workspace,
        recordId: record.id,
        project,
        externalId,
        repositoryFullName: record.repositoryFullName,
        snapshot,
        instructionSet,
        synchronization: {
          status: record.syncStatus,
          cursor: record.syncCursor,
          degradedReasonCode: record.degradedReasonCode,
          observationRef: record.observationRef,
          observedAt: record.observedAt,
          acceptedBy: record.acceptedBy,
          acceptedAt: record.acceptedAt,
          outcome: record.outcome,
          isCurrent: true as const,
        },
      });
    } catch (error) {
      if (error instanceof GitHubProjectContextStorageError) throw error;
      throw new GitHubProjectContextStorageError();
    }
  }
}

function admitBindingRequest(
  value: unknown,
): GetHostedGitHubIssueContextBindingInput {
  try {
    const input = exactDataRecord(value, requestKeys);
    return Object.freeze({
      project: exactProject(input.project),
      externalId: exactIssueExternalId(input.externalId),
    });
  } catch {
    throw new RangeError("GitHub project context binding request is invalid");
  }
}

function assertKnownProject(value: unknown, requestedProject: string): void {
  let snapshot: unknown;
  try {
    snapshot = snapshotBoundedJson(value, "Hosted GitHub project scope");
  } catch {
    throw new GitHubProjectContextStorageError();
  }
  if (!Array.isArray(snapshot) || snapshot.length > maximumProjects) {
    throw new GitHubProjectContextStorageError();
  }

  const ids = new Set<string>();
  const slugs = new Set<string>();
  let matches = 0;
  for (const entry of snapshot) {
    const project = exactStoredProject(entry);
    if (ids.has(project.id) || slugs.has(project.slug)) {
      throw new GitHubProjectContextStorageError();
    }
    ids.add(project.id);
    slugs.add(project.slug);
    if (project.slug === requestedProject) matches += 1;
  }
  if (matches !== 1) throw new GitHubProjectContextStorageError();
}

function exactStoredProject(value: unknown): {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
} {
  try {
    const project = exactDataRecord(value, projectRecordKeys);
    return {
      id: boundedStoredText(project.id, 160),
      slug: exactProject(project.slug),
      name: boundedStoredText(project.name, 2_000),
      createdAt: storedTimestamp(project.createdAt),
      updatedAt: storedTimestamp(project.updatedAt),
    };
  } catch {
    throw new GitHubProjectContextStorageError();
  }
}

async function validateThroughCanonicalService(input: {
  record: unknown;
  project: string;
  externalId: string;
  serviceSecret: string;
  workspace: string;
  now: () => number;
}): Promise<void> {
  let queryCount = 0;
  const validationClient: ConvexCaller = {
    query: async (_reference, args) => {
      queryCount += 1;
      if (queryCount === 1) {
        assertValidationArgs(args, input, false);
        return structuredClone(input.record);
      }
      if (queryCount === 2) {
        assertValidationArgs(args, input, true);
        return [];
      }
      throw new GitHubProjectContextStorageError();
    },
    mutation: async () => {
      throw new GitHubProjectContextStorageError();
    },
  };
  const validator = new ConvexGitHubProjectContextService({
    client: validationClient,
    serviceSecret: input.serviceSecret,
    workspace: input.workspace,
    now: input.now,
  });
  const projection = await validator.getGitHubProjectContext({
    project: input.project,
    externalId: input.externalId,
    historyLimit: 1,
  });
  if (
    queryCount !== 2
    || projection.issues.length !== 1
    || projection.issues[0]?.externalId !== input.externalId
  ) {
    throw new GitHubProjectContextStorageError();
  }
}

function assertValidationArgs(
  value: Record<string, unknown>,
  input: {
    project: string;
    externalId: string;
    serviceSecret: string;
    workspace: string;
  },
  history: boolean,
): void {
  if (
    value.serviceSecret !== input.serviceSecret
    || value.workspace !== input.workspace
    || value.project !== input.project
    || value.externalId !== input.externalId
    || (history ? value.limit !== 1 : "limit" in value)
  ) {
    throw new GitHubProjectContextStorageError();
  }
}

function admitSnapshotJson(value: unknown): GitHubIssueContext {
  if (typeof value !== "string") throw new GitHubProjectContextStorageError();
  try {
    return admitGitHubIssueContextSnapshot(parseStrictJson(value, {
      maxBytes: 512_000,
      maxDepth: 20,
      maxStringLength: 131_072,
      maxObjectKeys: 128,
      maxArrayLength: 128,
      prefix: "GITHUB_PROJECT_CONTEXT_BINDING_STORED_SNAPSHOT",
    }));
  } catch {
    throw new GitHubProjectContextStorageError();
  }
}

function admitInstructionJson(value: unknown): AcceptedRepositoryInstructionSet {
  if (typeof value !== "string") throw new GitHubProjectContextStorageError();
  try {
    return admitAcceptedRepositoryInstructionSet(parseStrictJson(value, {
      maxBytes: 128_000,
      maxDepth: 8,
      maxStringLength: 4_096,
      maxObjectKeys: 64,
      maxArrayLength: 32,
      prefix: "GITHUB_PROJECT_CONTEXT_BINDING_STORED_INSTRUCTIONS",
    }));
  } catch {
    throw new GitHubProjectContextStorageError();
  }
}

function exactDataRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) =>
      typeof key !== "string" || !(keys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError();
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactWorkspace(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError(
      "Workspace must be an exact lowercase slug up to 80 characters",
    );
  }
  return value;
}

function exactProject(value: unknown): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)
  ) {
    throw new RangeError("GitHub project context project is invalid");
  }
  return value;
}

function exactIssueExternalId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("GitHub issue external ID is invalid");
  }
  const externalId = parseGitHubIssueExternalId(value).externalId;
  if (externalId !== value) {
    throw new RangeError("GitHub issue external ID must be canonical");
  }
  return externalId;
}

function boundedStoredText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
  ) {
    throw new GitHubProjectContextStorageError();
  }
  return value;
}

function storedTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    throw new GitHubProjectContextStorageError();
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new GitHubProjectContextStorageError();
  }
  return value;
}

function required(value: string, label: string): string {
  if (value.length < 1 || value !== value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
