import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import {
  admitGitHubRepositoryObservationEnvelope,
  admitHostedGitHubRepositoryObservationInput,
} from "./github-repository-observation-admission.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import type {
  HostedGitHubRepositoryObservationInput,
  HostedGitHubRepositoryObservationResult,
  HostedGitHubRepositoryObservationSink,
} from "./hosted-provider-capacity-api.js";

const ingestRef = makeFunctionReference<"mutation">(
  "githubRepositoryObservations:ingest",
);
const listRecentRef = makeFunctionReference<"query">(
  "githubRepositoryObservations:listRecent",
);

const maximumRecentQueryStringBytes = 1024 * 1024;
const maximumMutationResultStringBytes = 128 * 1024;
const maximumStoredStringBytes = 64 * 1024;

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

interface ReturnAdmissionBudget {
  stringBytes: number;
  readonly maximumStringBytes: number;
  readonly maximumTotalStringBytes: number;
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
    const admitted = admitHostedGitHubRepositoryObservationInput(input);
    try {
      const rawResult = await this.client.mutation(ingestRef, this.args({
        deliveryId: admitted.deliveryId,
        eventType: admitted.eventType,
        payloadDigest: admitted.payloadDigest,
        receivedAt: admitted.receivedAt,
        observationJson: admitted.observationJson,
      }));
      const result = admitMutationResult(rawResult);
      validateStoredRecord(result.record);
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
    try {
      const rawRows = await this.client.query(listRecentRef, this.args({
        repository: canonicalRepository,
        limit,
      }));
      const rows = admitStoredRows(rawRows, limit);
      return Object.freeze(rows.map((row) => {
        const observation = validateStoredRecord(row);
        if (observation.repository !== canonicalRepository) {
          throw new GitHubRepositoryObservationStorageError();
        }
        return Object.freeze({
          id: row.id,
          observation,
          createdAt: new Date(row.createdAt).toISOString(),
        });
      }));
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
    };
  }
}

function admitMutationResult(value: unknown): {
  duplicate: boolean;
  record: ConvexObservationRecord;
} {
  const duplicate = dataProperty(value, "duplicate");
  if (typeof duplicate !== "boolean") {
    throw new GitHubRepositoryObservationStorageError();
  }
  return {
    duplicate,
    record: admitStoredRecord(
      dataProperty(value, "record"),
      returnAdmissionBudget(maximumMutationResultStringBytes),
    ),
  };
}

function admitStoredRows(value: unknown, limit: number): ConvexObservationRecord[] {
  if (!Array.isArray(value)) {
    throw new GitHubRepositoryObservationStorageError();
  }
  const rawLength = dataProperty(value, "length", false);
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 0
    || rawLength > limit
  ) {
    throw new GitHubRepositoryObservationStorageError();
  }
  const budget = returnAdmissionBudget(maximumRecentQueryStringBytes);
  const rows: ConvexObservationRecord[] = [];
  for (let index = 0; index < rawLength; index += 1) {
    rows.push(admitStoredRecord(dataProperty(value, String(index)), budget));
  }
  return rows;
}

function admitStoredRecord(
  value: unknown,
  budget: ReturnAdmissionBudget,
): ConvexObservationRecord {
  const actorValue = dataProperty(value, "actor");
  const actor = actorValue === null
    ? null
    : storageString(actorValue, budget);
  const sourceTimeSource = storageString(
    dataProperty(value, "sourceTimeSource"),
    budget,
  );
  if (sourceTimeSource !== "provider" && sourceTimeSource !== "received") {
    throw new GitHubRepositoryObservationStorageError();
  }
  return {
    id: storageString(dataProperty(value, "id"), budget),
    observationId: storageString(dataProperty(value, "observationId"), budget),
    deliveryId: storageString(dataProperty(value, "deliveryId"), budget),
    payloadDigest: storageString(dataProperty(value, "payloadDigest"), budget),
    semanticFingerprint: storageString(
      dataProperty(value, "semanticFingerprint"),
      budget,
    ),
    eventType: storageString(dataProperty(value, "eventType"), budget),
    action: storageString(dataProperty(value, "action"), budget),
    repository: storageString(dataProperty(value, "repository"), budget),
    actor,
    subjectKind: storageString(dataProperty(value, "subjectKind"), budget),
    subjectExternalId: storageString(
      dataProperty(value, "subjectExternalId"),
      budget,
    ),
    sourceTime: storageTimestamp(dataProperty(value, "sourceTime")),
    sourceTimeSource,
    receivedAt: storageTimestamp(dataProperty(value, "receivedAt")),
    observationJson: storageString(
      dataProperty(value, "observationJson"),
      budget,
    ),
    createdAt: storageTimestamp(dataProperty(value, "createdAt")),
  };
}

function validateStoredRecord(
  row: ConvexObservationRecord,
): GitHubRepositoryObservation {
  const admitted = admitGitHubRepositoryObservationEnvelope({
    deliveryId: row.deliveryId,
    eventType: row.eventType,
    payloadDigest: row.payloadDigest,
    receivedAt: row.receivedAt,
    observationJson: row.observationJson,
  });
  if (
    admitted.observationId !== row.observationId
    || admitted.semanticFingerprint !== row.semanticFingerprint
    || admitted.action !== row.action
    || admitted.repository !== row.repository
    || admitted.actor !== row.actor
    || admitted.subjectKind !== row.subjectKind
    || admitted.subjectExternalId !== row.subjectExternalId
    || admitted.sourceTime !== row.sourceTime
    || admitted.sourceTimeSource !== row.sourceTimeSource
  ) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return admitted.observation;
}

function mapStorageError(error: unknown): Error {
  if (error instanceof GitHubRepositoryObservationConflictError) return error;
  if (error instanceof GitHubRepositoryObservationStorageError) return error;
  const message = ownDataErrorMessage(error);
  if (
    message.includes("GITHUB_REPOSITORY_DELIVERY_CONFLICT")
    || message.includes("GITHUB_REPOSITORY_OBSERVATION_CONFLICT")
  ) {
    return new GitHubRepositoryObservationConflictError();
  }
  return new GitHubRepositoryObservationStorageError();
}

function ownDataErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : "";
}

function storageTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return value;
}

function storageString(value: unknown, budget: ReturnAdmissionBudget): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new GitHubRepositoryObservationStorageError();
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  budget.stringBytes += bytes;
  if (
    bytes > budget.maximumStringBytes
    || budget.stringBytes > budget.maximumTotalStringBytes
  ) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return value;
}

function returnAdmissionBudget(
  maximumTotalStringBytes: number,
): ReturnAdmissionBudget {
  return {
    stringBytes: 0,
    maximumStringBytes: maximumStoredStringBytes,
    maximumTotalStringBytes,
  };
}

function dataProperty(
  value: unknown,
  key: string,
  enumerable = true,
): unknown {
  if (!value || typeof value !== "object") {
    throw new GitHubRepositoryObservationStorageError();
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new GitHubRepositoryObservationStorageError();
  }
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.enumerable !== enumerable
  ) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return descriptor.value;
}

function required(value: string, label: string): string {
  if (value.length < 1 || value !== value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function normalizeWorkspace(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9-_]{0,79}$/u.test(value)) {
    throw new Error(
      "Workspace must be an exact lowercase slug up to 80 characters",
    );
  }
  return value;
}
