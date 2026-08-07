import { sha256, stableJson } from "./canonical-json.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export const repositorySourceTransitionOperations = Object.freeze([
  "replay_exact_files",
] as const);

export type RepositorySourceTransitionOperation =
  typeof repositorySourceTransitionOperations[number];
export type RepositorySourceTransitionFileMode = "100644" | "100755";

export interface RepositorySourceTransitionFileInput {
  path: string;
  donorCommitSha: string;
  donorBlobSha: string;
  donorMode: RepositorySourceTransitionFileMode;
}

export interface RepositorySourceTransitionPlanInput {
  version: 1;
  operation: RepositorySourceTransitionOperation;
  repositoryFullName: string;
  targetBranch: string;
  expectedTargetHead: string;
  expectedSourceBase: string;
  files: readonly RepositorySourceTransitionFileInput[];
  validationProfile: string;
}

export interface RepositorySourceTransitionFile {
  path: string;
  donorCommitSha: string;
  donorBlobSha: string;
  donorMode: RepositorySourceTransitionFileMode;
}

export interface RepositorySourceTransitionPlan {
  version: 1;
  operation: RepositorySourceTransitionOperation;
  repositoryFullName: string;
  targetBranch: string;
  expectedTargetHead: string;
  expectedSourceBase: string;
  objectIdLength: 40 | 64;
  files: readonly RepositorySourceTransitionFile[];
  validationProfile: string;
  expectedChangedPaths: readonly string[];
  changedPathFence: string;
  planFingerprint: string;
  requiresWorkflowFreeFinalHead: true;
  requiresNonDefaultTargetBranch: true;
  allowsArbitraryCommands: false;
  grantsAuthority: false;
}

const maximumFiles = 128;
const maximumPathBytes = 512;
const maximumBranchBytes = 240;
const maximumProfileBytes = 64;
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const validationProfilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const forbiddenRefCharacters = Object.freeze([
  " ",
  "~",
  "^",
  ":",
  "?",
  "*",
  "[",
  "]",
  "\\",
]);
const planKeys = Object.freeze([
  "version",
  "operation",
  "repositoryFullName",
  "targetBranch",
  "expectedTargetHead",
  "expectedSourceBase",
  "files",
  "validationProfile",
] as const);
const fileKeys = Object.freeze([
  "path",
  "donorCommitSha",
  "donorBlobSha",
  "donorMode",
] as const);

/**
 * Compiles a source-only exact-file replay plan. This contract is intentionally
 * narrower than the future transition runner: it carries identities and a
 * repository-owned validation profile ID, never commands or publication
 * authority.
 */
export function compileRepositorySourceTransitionPlan(
  input: unknown,
): RepositorySourceTransitionPlan {
  const snapshot = snapshotExactRecord(
    input,
    planKeys,
    "Repository source transition plan",
  );
  if (snapshot.version !== 1) {
    throw new RangeError("Repository source transition plan version is invalid");
  }
  if (snapshot.operation !== "replay_exact_files") {
    throw new RangeError("Repository source transition operation is invalid");
  }

  const repositoryFullName = admitRepository(snapshot.repositoryFullName);
  const targetBranch = admitBranch(snapshot.targetBranch);
  const expectedTargetHead = admitObjectId(
    snapshot.expectedTargetHead,
    "Expected target head",
  );
  const expectedSourceBase = admitObjectId(
    snapshot.expectedSourceBase,
    "Expected source base",
  );
  if (expectedTargetHead.length !== expectedSourceBase.length) {
    throw new RangeError("Repository source transition object-ID widths must match");
  }
  const objectIdLength = expectedTargetHead.length as 40 | 64;
  const validationProfile = admitValidationProfile(snapshot.validationProfile);
  const files = snapshotFiles(snapshot.files, objectIdLength);
  if (files.length === 0) {
    throw new RangeError("Repository source transition requires at least one file");
  }

  const sortedFiles = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const expectedChangedPaths = Object.freeze(
    sortedFiles.map((entry) => entry.path),
  );
  const changedPathFence = sha256(stableJson(expectedChangedPaths));
  const payload = {
    version: 1 as const,
    operation: "replay_exact_files" as const,
    repositoryFullName,
    targetBranch,
    expectedTargetHead,
    expectedSourceBase,
    objectIdLength,
    files: Object.freeze(sortedFiles),
    validationProfile,
    expectedChangedPaths,
    changedPathFence,
    requiresWorkflowFreeFinalHead: true as const,
    requiresNonDefaultTargetBranch: true as const,
    allowsArbitraryCommands: false as const,
    grantsAuthority: false as const,
  };
  const planFingerprint = sha256(stableJson(payload));
  return deepFreeze({ ...payload, planFingerprint });
}

function snapshotFiles(
  value: unknown,
  objectIdLength: 40 | 64,
): RepositorySourceTransitionFile[] {
  const length = admitArrayLength(
    value,
    maximumFiles,
    "Repository source transition files",
  );
  const result: RepositorySourceTransitionFile[] = [];
  const paths = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new RangeError("Repository source transition files could not be inspected");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError("Repository source transition files must be dense data entries");
    }
    const file = snapshotExactRecord(
      descriptor.value,
      fileKeys,
      `Repository source transition file ${index + 1}`,
    );
    const path = admitPath(file.path);
    if (paths.has(path)) {
      throw new RangeError("Repository source transition file paths must be unique");
    }
    paths.add(path);
    const donorCommitSha = admitObjectId(file.donorCommitSha, "Donor commit SHA");
    const donorBlobSha = admitObjectId(file.donorBlobSha, "Donor blob SHA");
    if (
      donorCommitSha.length !== objectIdLength
      || donorBlobSha.length !== objectIdLength
    ) {
      throw new RangeError("Repository source transition object-ID widths must match");
    }
    result.push(Object.freeze({
      path,
      donorCommitSha,
      donorBlobSha,
      donorMode: admitDonorMode(file.donorMode),
    }));
  }
  return result;
}

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new RangeError(`${label} must be an object`);
  }
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new RangeError(`${label} could not be inspected`);
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    throw new RangeError(`${label} must be a plain or null-prototype object`);
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new RangeError(`${label} could not be inspected`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} must contain enumerable data field ${key}`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function admitArrayLength(
  value: unknown,
  maximumLength: number,
  label: string,
): number {
  let isArray: boolean;
  let prototype: object | null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = isArray && value !== null ? Object.getPrototypeOf(value) : null;
    descriptor = isArray && value !== null
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
  } catch {
    throw new RangeError(`${label} could not be inspected`);
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new RangeError(`${label} must be an ordinary array`);
  }
  const length = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maximumLength
  ) {
    throw new RangeError(`${label} exceeds its entry limit`);
  }
  return length;
}

function admitRepository(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim().toLowerCase()) {
    throw new RangeError("Repository source transition repository is invalid");
  }
  let normalized: string;
  try {
    normalized = normalizeGitHubRepository(value);
  } catch {
    throw new RangeError("Repository source transition repository is invalid");
  }
  if (normalized !== value || !/^[^/]+\/[^/]+$/u.test(value)) {
    throw new RangeError("Repository source transition repository is invalid");
  }
  return normalized;
}

function admitObjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !objectIdPattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function admitDonorMode(value: unknown): RepositorySourceTransitionFileMode {
  if (value !== "100644" && value !== "100755") {
    throw new RangeError("Repository source transition donor mode is invalid");
  }
  return value;
}

function admitValidationProfile(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumProfileBytes
    || !validationProfilePattern.test(value)
  ) {
    throw new RangeError("Repository source transition validation profile is invalid");
  }
  return value;
}

function admitBranch(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumBranchBytes
    || value.length === 0
    || value === "@"
    || value === "main"
    || value.startsWith("refs/")
    || value.startsWith("-")
    || unsafeTextPattern.test(value)
    || forbiddenRefCharacters.some((character) => value.includes(character))
    || value.startsWith("/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
  ) {
    throw new RangeError("Repository source transition target branch is invalid");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0
      || segment.startsWith(".")
      || segment.endsWith(".lock")
    )
  ) {
    throw new RangeError("Repository source transition target branch is invalid");
  }
  return value;
}

function admitPath(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumPathBytes
    || value.length === 0
    || unsafeTextPattern.test(value)
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.includes("//")
  ) {
    throw new RangeError("Repository source transition path is invalid");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.toLowerCase() === ".git"
    )
  ) {
    throw new RangeError("Repository source transition path is invalid");
  }
  if (value === ".github/workflows" || value.startsWith(".github/workflows/")) {
    throw new RangeError("Repository source transition final paths must be workflow-free");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
