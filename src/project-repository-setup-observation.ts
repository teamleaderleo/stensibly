import { normalizeGitHubBranchName } from "./github-branch-name.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const PROJECT_REPOSITORY_SETUP_OBSERVATION_VERSION = 1 as const;

export const projectRepositorySetupSourceKinds = [
  "operator_supplied",
  "github_conversation_context",
] as const;

export type ProjectRepositorySetupSourceKind =
  typeof projectRepositorySetupSourceKinds[number];

export interface ProjectRepositorySetupObservationInput {
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: ProjectRepositorySetupSourceKind;
  observedAt: string;
}

export interface ProjectRepositorySetupObservation {
  readonly version: typeof PROJECT_REPOSITORY_SETUP_OBSERVATION_VERSION;
  readonly id: string;
  readonly project: string;
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly sourceKind: ProjectRepositorySetupSourceKind;
  readonly observedAt: string;
  readonly fingerprint: string;
  readonly authorizesProviderEffect: false;
  readonly containsSecrets: false;
}

const inputKeys = [
  "project",
  "repositoryFullName",
  "defaultBranch",
  "sourceKind",
  "observedAt",
] as const;

const observationKeys = [
  "version",
  "id",
  ...inputKeys,
  "fingerprint",
  "authorizesProviderEffect",
  "containsSecrets",
] as const;

const projectPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;

export function compileProjectRepositorySetupObservation(
  value: unknown,
): ProjectRepositorySetupObservation {
  const input = exactDataRecord(value, inputKeys, "repository setup observation input");
  const project = exactProject(input.project);
  const repositoryFullName = normalizeGitHubRepository(exactString(
    input.repositoryFullName,
    "Repository full name",
  ));
  const defaultBranch = normalizeGitHubBranchName(
    exactString(input.defaultBranch, "Default branch"),
    "Default branch",
  );
  const sourceKind = exactSourceKind(input.sourceKind);
  const observedAt = exactTimestamp(input.observedAt);
  const semantics = {
    version: PROJECT_REPOSITORY_SETUP_OBSERVATION_VERSION,
    project,
    repositoryFullName,
    defaultBranch,
    sourceKind,
    observedAt,
    authorizesProviderEffect: false as const,
    containsSecrets: false as const,
  };
  const fingerprint = fingerprintCanonicalRequest(semantics);
  return Object.freeze({
    ...semantics,
    id: `repo_setup_${fingerprint.slice("sha256:".length)}`,
    fingerprint,
  });
}

export function admitProjectRepositorySetupObservation(
  value: unknown,
): ProjectRepositorySetupObservation {
  const record = exactDataRecord(
    value,
    observationKeys,
    "repository setup observation",
  );
  if (
    record.version !== PROJECT_REPOSITORY_SETUP_OBSERVATION_VERSION
    || record.authorizesProviderEffect !== false
    || record.containsSecrets !== false
  ) {
    throw new RangeError("Repository setup observation metadata is invalid");
  }
  const compiled = compileProjectRepositorySetupObservation({
    project: record.project,
    repositoryFullName: record.repositoryFullName,
    defaultBranch: record.defaultBranch,
    sourceKind: record.sourceKind,
    observedAt: record.observedAt,
  });
  if (
    typeof record.id !== "string"
    || record.id !== compiled.id
    || typeof record.fingerprint !== "string"
    || !fingerprintPattern.test(record.fingerprint)
    || record.fingerprint !== compiled.fingerprint
  ) {
    throw new RangeError("Repository setup observation identity is invalid");
  }
  return compiled;
}

function exactProject(value: unknown): string {
  const project = exactString(value, "Project");
  if (!projectPattern.test(project)) {
    throw new RangeError("Project must be an exact lowercase slug up to 80 characters");
  }
  return project;
}

function exactSourceKind(value: unknown): ProjectRepositorySetupSourceKind {
  if (
    typeof value !== "string"
    || !(projectRepositorySetupSourceKinds as readonly string[]).includes(value)
  ) {
    throw new RangeError("Repository setup observation source kind is invalid");
  }
  return value as ProjectRepositorySetupSourceKind;
}

function exactTimestamp(value: unknown): string {
  const timestamp = exactString(value, "Observation time");
  if (!timestampPattern.test(timestamp)) {
    throw new RangeError("Observation time must be canonical UTC");
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new RangeError("Observation time must be canonical UTC");
  }
  return timestamp;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim()) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactDataRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} is invalid`);
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) =>
      typeof key !== "string" || !(keys as readonly string[]).includes(key)
    )
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new RangeError(`${label} is invalid`);
    }
    output[key] = descriptor.value;
  }
  return output;
}
