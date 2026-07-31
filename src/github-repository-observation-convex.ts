import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import type {
  HostedGitHubRepositoryObservationInput,
  HostedGitHubRepositoryObservationResult,
  HostedGitHubRepositoryObservationSink,
} from "./hosted-provider-capacity-api.js";
import {
  canonicalJsonString,
  fingerprintCanonicalRequest,
} from "./idempotency-request-fingerprint.js";

const ingestRef = makeFunctionReference<"mutation">(
  "githubRepositoryObservations:ingest",
);
const listRecentRef = makeFunctionReference<"query">(
  "githubRepositoryObservations:listRecent",
);

const inputKeys = [
  "deliveryId",
  "eventType",
  "observation",
  "payloadDigest",
  "receivedAt",
] as const;
const mutationResultKeys = ["duplicate", "record"] as const;
const storedRecordKeys = [
  "action",
  "actor",
  "createdAt",
  "deliveryId",
  "eventType",
  "id",
  "observationId",
  "observationJson",
  "payloadDigest",
  "receivedAt",
  "repository",
  "semanticFingerprint",
  "sourceTime",
  "sourceTimeSource",
  "subjectExternalId",
  "subjectKind",
] as const;
const observationKeys = [
  "action",
  "actor",
  "containsRawContent",
  "contentRevisions",
  "deliveryId",
  "eventType",
  "facts",
  "observationId",
  "payloadDigest",
  "provider",
  "receivedAt",
  "relationships",
  "repository",
  "semanticFingerprint",
  "sourceSchema",
  "sourceSchemaVersion",
  "sourceTime",
  "sourceTimeSource",
  "subject",
  "version",
] as const;
const maximumAdmissionDepth = 24;
const maximumAdmissionValues = 1_024;
const maximumArrayLength = 256;
const maximumObjectKeys = 128;
const maximumStringBytes = 64 * 1_024;
const maximumTotalStringBytes = 128 * 1_024;

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

interface CanonicalObservationInput {
  deliveryId: string;
  eventType: string;
  payloadDigest: string;
  receivedAt: number;
  observationJson: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface SnapshotState {
  readonly active: WeakSet<object>;
  visited: number;
  stringBytes: number;
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
    const admitted = canonicalInput(input);
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
    let rows: ConvexObservationRecord[];
    try {
      const rawRows = await this.client.query(listRecentRef, this.args({
        repository: canonicalRepository,
        limit,
      }));
      rows = admitStoredRows(rawRows, limit);
    } catch (error) {
      throw mapStorageError(error);
    }
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
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
    };
  }
}

function canonicalInput(inputValue: unknown): CanonicalObservationInput {
  const snapshot = snapshotBoundedJson(
    inputValue,
    "GitHub repository observation input",
  );
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, inputKeys)) {
    throw new RangeError("GitHub repository observation input has noncanonical fields");
  }

  const deliveryId = exactString(
    snapshot.deliveryId,
    "GitHub repository observation delivery ID",
  );
  const eventType = exactString(
    snapshot.eventType,
    "GitHub repository observation event type",
  );
  const payloadDigest = exactString(
    snapshot.payloadDigest,
    "GitHub repository observation payload digest",
  );
  const receivedAtText = exactString(
    snapshot.receivedAt,
    "GitHub repository observation receipt time",
  );
  const observation = snapshot.observation;
  if (!isRecord(observation)) {
    throw new RangeError("GitHub repository observation must be a plain data record");
  }
  if (
    observation.deliveryId !== deliveryId
    || observation.eventType !== eventType
    || observation.payloadDigest !== payloadDigest
    || observation.receivedAt !== receivedAtText
    || observation.containsRawContent !== false
  ) {
    throw new RangeError("GitHub repository observation input is inconsistent");
  }
  return {
    deliveryId,
    eventType,
    payloadDigest,
    receivedAt: canonicalTimestamp(
      receivedAtText,
      "GitHub webhook received time",
    ),
    observationJson: canonicalJsonString(observation),
  };
}

function admitMutationResult(value: unknown): {
  duplicate: boolean;
  record: ConvexObservationRecord;
} {
  const snapshot = snapshotBoundedJson(
    value,
    "GitHub repository observation mutation result",
  );
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, mutationResultKeys)) {
    throw new GitHubRepositoryObservationStorageError();
  }
  if (typeof snapshot.duplicate !== "boolean") {
    throw new GitHubRepositoryObservationStorageError();
  }
  return {
    duplicate: snapshot.duplicate,
    record: admitStoredRecord(snapshot.record),
  };
}

function admitStoredRows(value: unknown, limit: number): ConvexObservationRecord[] {
  const snapshot = snapshotBoundedJson(
    value,
    "GitHub repository observation query result",
  );
  if (!Array.isArray(snapshot) || snapshot.length > limit) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return snapshot.map(admitStoredRecord);
}

function admitStoredRecord(value: unknown): ConvexObservationRecord {
  if (!isRecord(value) || !hasExactKeys(value, storedRecordKeys)) {
    throw new GitHubRepositoryObservationStorageError();
  }
  const actor = value.actor === null
    ? null
    : storageString(value.actor);
  const sourceTimeSource = value.sourceTimeSource;
  if (sourceTimeSource !== "provider" && sourceTimeSource !== "received") {
    throw new GitHubRepositoryObservationStorageError();
  }
  return {
    id: storageString(value.id),
    observationId: storageString(value.observationId),
    deliveryId: storageString(value.deliveryId),
    payloadDigest: storageString(value.payloadDigest),
    semanticFingerprint: storageString(value.semanticFingerprint),
    eventType: storageString(value.eventType),
    action: storageString(value.action),
    repository: storageString(value.repository),
    actor,
    subjectKind: storageString(value.subjectKind),
    subjectExternalId: storageString(value.subjectExternalId),
    sourceTime: storageTimestamp(value.sourceTime),
    sourceTimeSource,
    receivedAt: storageTimestamp(value.receivedAt),
    observationJson: storageString(value.observationJson),
    createdAt: storageTimestamp(value.createdAt),
  };
}

function snapshotBoundedJson(value: unknown, label: string): JsonValue {
  return snapshotJsonValue(
    value,
    label,
    {
      active: new WeakSet<object>(),
      visited: 0,
      stringBytes: 0,
    },
    0,
  );
}

function snapshotJsonValue(
  value: unknown,
  label: string,
  state: SnapshotState,
  depth: number,
): JsonValue {
  state.visited += 1;
  if (state.visited > maximumAdmissionValues || depth > maximumAdmissionDepth) {
    throw new RangeError(`${label} exceeds the bounded data envelope`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value).byteLength;
    state.stringBytes += bytes;
    if (
      bytes > maximumStringBytes
      || state.stringBytes > maximumTotalStringBytes
    ) {
      throw new RangeError(`${label} contains oversized text`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new RangeError(`${label} contains an invalid number`);
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new RangeError(`${label} contains a non-JSON value`);
  }
  if (state.active.has(value)) {
    throw new RangeError(`${label} contains a cycle`);
  }
  state.active.add(value);
  try {
    return Array.isArray(value)
      ? snapshotArray(value, label, state, depth)
      : snapshotRecord(value, label, state, depth);
  } finally {
    state.active.delete(value);
  }
}

function snapshotArray(
  value: unknown[],
  label: string,
  state: SnapshotState,
  depth: number,
): JsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} arrays must use the default prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const lengthDescriptor = descriptors["length"];
  const rawLength = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : null;
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 0
    || rawLength > maximumArrayLength
  ) {
    throw new RangeError(`${label} has an invalid array length`);
  }
  const length = rawLength;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new RangeError(`${label} arrays cannot contain symbol fields`);
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
      throw new RangeError(`${label} arrays cannot contain decorated fields`);
    }
  }
  const output: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new RangeError(`${label} arrays must contain dense enumerable data slots`);
    }
    output.push(snapshotJsonValue(
      descriptor.value,
      `${label}[${index}]`,
      state,
      depth + 1,
    ));
  }
  return output;
}

function snapshotRecord(
  value: object,
  label: string,
  state: SnapshotState,
  depth: number,
): { [key: string]: JsonValue } {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} records must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new RangeError(`${label} records cannot contain symbol fields`);
    }
    keys.push(key);
  }
  if (keys.length > maximumObjectKeys) {
    throw new RangeError(`${label} contains too many fields`);
  }
  keys.sort(codeUnitCompare);
  const output: { [key: string]: JsonValue } = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new RangeError(`${label}.${key} must be an enumerable data property`);
    }
    output[key] = snapshotJsonValue(
      descriptor.value,
      `${label}.${key}`,
      state,
      depth + 1,
    );
  }
  return output;
}

function validateStoredRecord(row: ConvexObservationRecord): GitHubRepositoryObservation {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.observationJson);
  } catch {
    throw new GitHubRepositoryObservationStorageError();
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, observationKeys)
    || canonicalJsonString(decoded) !== row.observationJson
  ) {
    throw new GitHubRepositoryObservationStorageError();
  }
  const {
    observationId: _observationId,
    deliveryId: _deliveryId,
    payloadDigest: _payloadDigest,
    semanticFingerprint: _semanticFingerprint,
    receivedAt: _receivedAt,
    ...canonicalSemantics
  } = decoded;
  if (
    decoded.version !== 1
    || decoded.provider !== "github"
    || decoded.sourceSchema !== "github-webhook"
    || decoded.sourceSchemaVersion !== "2022-11-28"
    || decoded.containsRawContent !== false
    || decoded.observationId !== row.observationId
    || decoded.deliveryId !== row.deliveryId
    || decoded.payloadDigest !== row.payloadDigest
    || decoded.semanticFingerprint !== row.semanticFingerprint
    || fingerprintCanonicalRequest(canonicalSemantics) !== row.semanticFingerprint
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

function storageTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return value;
}

function storageString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new GitHubRepositoryObservationStorageError();
  }
  return value;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new RangeError(`${label} is invalid`);
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

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort(codeUnitCompare);
  const expected = [...expectedKeys].sort(codeUnitCompare);
  return actualKeys.length === expected.length
    && actualKeys.every((key, index) => key === expected[index]);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
