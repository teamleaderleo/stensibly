import { normalizeGitHubBranchName } from "./github-branch-name.js";
import { normalizeGitHubRepository, sha256, stableJson } from "./github-provider-validation.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";

export const projectRepositorySetupObservationSourceKinds = [
  "operator_supplied",
  "github_conversation_context",
] as const;
export type ProjectRepositorySetupObservationSourceKind =
  typeof projectRepositorySetupObservationSourceKinds[number];

export interface ProjectRepositorySetupObservationRecord {
  version: 1;
  id: string;
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: ProjectRepositorySetupObservationSourceKind;
  semanticFingerprint: string;
  observedAt: string;
  authorizesProviderEffect: false;
  containsSecrets: false;
}

export interface RecordProjectRepositorySetupObservationInput {
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: ProjectRepositorySetupObservationSourceKind;
}

export interface ProjectRepositorySetupObservationResult {
  observation: ProjectRepositorySetupObservationRecord;
  replayed: boolean;
  replacedObservationId: string | null;
}

export interface ProjectRepositorySetupObservationLedger {
  getProjectRepositorySetupObservation(
    project: string,
  ): Promise<ProjectRepositorySetupObservationRecord | null>;
  recordProjectRepositorySetupObservation(
    input: RecordProjectRepositorySetupObservationInput,
  ): Promise<ProjectRepositorySetupObservationResult>;
}

export interface PreparedProjectRepositorySetupObservation {
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: ProjectRepositorySetupObservationSourceKind;
  semanticFingerprint: string;
  replay: ProjectRepositorySetupObservationRecord | null;
}

export function prepareProjectRepositorySetupObservation(
  current: ProjectRepositorySetupObservationRecord | null,
  input: RecordProjectRepositorySetupObservationInput,
): PreparedProjectRepositorySetupObservation {
  const project = normalizeProject(input.project);
  const repositoryFullName = normalizeGitHubRepository(
    exactText(input.repositoryFullName, "Repository full name", 140),
  );
  const defaultBranch = normalizeGitHubBranchName(
    input.defaultBranch,
    "Repository default branch",
  );
  const sourceKind = normalizeSourceKind(input.sourceKind);
  const semanticFingerprint = projectRepositorySetupObservationFingerprint({
    project,
    repositoryFullName,
    defaultBranch,
    sourceKind,
  });
  return {
    project,
    repositoryFullName,
    defaultBranch,
    sourceKind,
    semanticFingerprint,
    replay: current?.semanticFingerprint === semanticFingerprint ? current : null,
  };
}

export function createProjectRepositorySetupObservationRecord(input: {
  id: string;
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: ProjectRepositorySetupObservationSourceKind;
  semanticFingerprint: string;
  observedAt: string;
}): ProjectRepositorySetupObservationRecord {
  const prepared = prepareProjectRepositorySetupObservation(null, input);
  const id = normalizeObservationId(input.id);
  const observedAt = normalizeTimestamp(input.observedAt);
  if (prepared.semanticFingerprint !== input.semanticFingerprint) {
    throw new RangeError("Repository setup observation fingerprint is invalid");
  }
  return deepFreeze({
    version: 1,
    id,
    project: prepared.project,
    repositoryFullName: prepared.repositoryFullName,
    defaultBranch: prepared.defaultBranch,
    sourceKind: prepared.sourceKind,
    semanticFingerprint: prepared.semanticFingerprint,
    observedAt,
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

export function projectRepositorySetupObservationFingerprint(input: {
  project: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceKind: ProjectRepositorySetupObservationSourceKind;
}): string {
  return sha256(stableJson({
    version: 1,
    project: normalizeProject(input.project),
    repositoryFullName: normalizeGitHubRepository(input.repositoryFullName),
    defaultBranch: normalizeGitHubBranchName(
      input.defaultBranch,
      "Repository default branch",
    ),
    sourceKind: normalizeSourceKind(input.sourceKind),
    authorizesProviderEffect: false,
  }));
}

function normalizeProject(value: string): string {
  const project = exactText(value, "Project", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(project)) {
    throw new RangeError("Project is invalid");
  }
  return project;
}

function normalizeSourceKind(value: string): ProjectRepositorySetupObservationSourceKind {
  if (
    value === "operator_supplied"
    || value === "github_conversation_context"
  ) return value;
  throw new RangeError("Repository setup observation source kind is invalid");
}

function normalizeObservationId(value: string): string {
  const id = exactText(value, "Repository setup observation id", 160);
  if (!/^repo_setup_[A-Za-z0-9-]{8,120}$/u.test(id)) {
    throw new RangeError("Repository setup observation id is invalid");
  }
  return id;
}

function normalizeTimestamp(value: string): string {
  const text = exactText(value, "Repository setup observation time", 64);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) {
    throw new RangeError("Repository setup observation time is invalid");
  }
  const canonical = new Date(millis).toISOString();
  if (canonical !== text) {
    throw new RangeError("Repository setup observation time is invalid");
  }
  return text;
}

function exactText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/u.test(value)
    || containsRealisticRetainedCredential(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
