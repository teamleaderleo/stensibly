import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import type {
  HostedGitHubRepositoryObservationInput,
  HostedGitHubRepositoryObservationResult,
  HostedGitHubRepositoryObservationSink,
} from "./hosted-provider-capacity-api.js";
import { canonicalJsonString } from "./idempotency-request-fingerprint.js";

const ingestRef = makeFunctionReference<"mutation">(
  "githubRepositoryObservations:ingest",
);
const listRecentRef = makeFunctionReference<"query">(
  "githubRepositoryObservations:listRecent",
);

export class GitHubRepositoryObservationConflictError extends Error {
  readonly code = "github_repository_observation_conflict";

  constructor() {
    super("GitHub delivery identity was reused with different repository observation content");
    this.name = "GitHubRepositoryObservationConflictError";
  }
}

export class GitHubRepositoryObservationStorageError extends Error {
  readonly code = "github_repository_observation_storage_failed";

  constructor() {
    super("GitHub repository observation storage failed");
    this.name = "GitHubRepositoryObservationStorageError";
  }
}

export interface ConvexGitHubRepositoryObservationServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

interface ConvexObservationRecord {
  id: string;
  observationId: string;
  deliveryId: string;
  payloadDigest: string;
  semanticFingerprint: string;
  eventType: string;
  action: string;
  repository: string;
  actor: string | null;
  subjectKind: string;
  subjectExternalId: string;
  sourceTime: number;
  sourceTimeSource: "provider" | "received";
  receivedAt: number;
  observationJson: string;
  createdAt: number;
}

export interface HostedGitHubRepositoryObservationRecord {
  readonly id: string;
  readonly observation: GitHubRepositoryObservation;
  readonly createdAt: string;
}

export interface HostedGitHubRepositoryObservationReader {
  listRecentRepositoryObservations(
    repository: string,
    limit?: number,
  ): Promise<readonly HostedGitHubRepositoryObservationRecord[]>;
}

export class ConvexGitHubRepositoryObservationService
  implements HostedGitHubRepositoryObservationSink,
    HostedGitHubRepositoryObservationReader {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexGitHubRepositoryObservationServiceOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = normalizeWorkspace(options.workspace ?? "default");
  }

  async ingestRepositoryObservation(
    input: HostedGitHubRepositoryObservationInput,
  ): Promise<HostedGitHubRepositoryObservationResult> {
    const observationJson = canonicalInput(input);
    try {
      const result = await this.client.mutation(ingestRef, this.args({
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        payloadDigest: input.payloadDigest,
        receivedAt: canonicalTimestamp(input.receivedAt, "GitHub webhook received time"),
        observationJson,
      })) as { duplicate: boolean; record: ConvexObservationRecord };
      validateStoredRecord(result.record);
      if (typeof result.duplicate !== "boolean") {
        throw new GitHubRepositoryObservationStorageError();
      }
      return Object.freeze({ duplicate: result.duplicate });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listRecentRepositoryObservations(
    repository: string,
    limit = 50,
  ): Promise<readonly HostedGitHubRepositoryObservationRecord[]> {
    const canonicalRepository = normalizeGitHubRepository(repository);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("GitHub repository observation limit must be 1-100");
    }
    let rows: ConvexObservationRecord[];
    try {
      rows = await this.client.query(listRecentRef, this.args({
        repository: canonicalRepository,
        limit,
      })) as ConvexObservationRecord[];
    } catch (error) {
      throw mapStorageError(error);
    }
    if (!Array.isArray(rows) || rows.length > limit) {
      throw new GitHubRepositoryObservationStorageError();
    }
    return Object.freeze(rows.map((row) => {
      const observation = validateStoredRecord(row);
      if (observation.repository !== canonicalRepository) {
        throw new GitHubRepositoryObservationStorageError();
      }
      return Object.freeze({
        id: row.id,
        observation,
        createdAt: new Date(exactTimestamp(row.createdAt)).toISOString(),
      });
    }));
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
    };
  }
}

function canonicalInput(input: HostedGitHubRepositoryObservationInput): string {
  const observation = input.observation;
  if (
    input.deliveryId !== observation.deliveryId
    || input.eventType !== observation.eventType
    || input.payloadDigest !== observation.payloadDigest
    || input.receivedAt !== observation.receivedAt
    || observation.containsRawContent !== false
  ) {
    throw new RangeError("GitHub repository observation input is inconsistent");
  }
  return canonicalJsonString(observation);
}

function validateStoredRecord(row: ConvexObservationRecord): GitHubRepositoryObservation {
  if (!row || typeof row !== "object") {
    throw new GitHubRepositoryObservationStorageError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.observationJson);
  } catch {
    throw new GitHubRepositoryObservationStorageError();
  }
  if (!isRecord(decoded)) throw new GitHubRepositoryObservationStorageError();
  if (
    canonicalJsonString(decoded) !== row.observationJson
    || decoded.version !== 1
    || decoded.provider !== "github"
    || decoded.sourceSchema !== "github-webhook"
    || decoded.sourceSchemaVersion !== "2022-11-28"
    || decoded.containsRawContent !== false
    || decoded.observationId !== row.observationId
    || decoded.deliveryId !== row.deliveryId
    || decoded.payloadDigest !== row.payloadDigest
    || decoded.semanticFingerprint !== row.semanticFingerprint
    || decoded.eventType !== row.eventType
    || decoded.action !== row.action
    || decoded.repository !== row.repository
    || decoded.actor !== row.actor
    || decoded.sourceTimeSource !== row.sourceTimeSource
    || canonicalTimestamp(decoded.sourceTime, "Stored GitHub source time") !== row.sourceTime
    || canonicalTimestamp(decoded.receivedAt, "Stored GitHub receipt time") !== row.receivedAt
    || !isRecord(decoded.subject)
    || decoded.subject.kind !== row.subjectKind
    || decoded.subject.externalId !== row.subjectExternalId
  ) {
    throw new GitHubRepositoryObservationStorageError();
  }
  exactTimestamp(row.createdAt);
  return decoded as unknown as GitHubRepositoryObservation;
}

function mapStorageError(error: unknown): Error {
  if (error instanceof GitHubRepositoryObservationConflictError) return error;
  if (error instanceof GitHubRepositoryObservationStorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("GITHUB_REPOSITORY_DELIVERY_CONFLICT")
    || message.includes("GITHUB_REPOSITORY_OBSERVATION_CONFLICT")
  ) {
    return new GitHubRepositoryObservationConflictError();
  }
  return new GitHubRepositoryObservationStorageError();
}

function canonicalTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") throw new RangeError(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new RangeError(`${label} must be an exact UTC timestamp`);
  }
  return milliseconds;
}

function exactTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return value;
}

function required(value: string, label: string): string {
  if (value.length < 1 || value !== value.trim()) throw new Error(`${label} is required`);
  return value;
}

function normalizeWorkspace(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9-_]{0,79}$/u.test(value)) {
    throw new Error("Workspace must be an exact lowercase slug up to 80 characters");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
