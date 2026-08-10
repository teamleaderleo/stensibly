import { normalizeGitHubBranchName } from "./github-branch-name.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
import { sha256, stableJson } from "./github-provider-validation.js";

export function withObservedRepositoryDefaultBranch(
  observation: GitHubRepositoryObservation | null,
  verifiedPayload: unknown,
): GitHubRepositoryObservation | null {
  if (!observation) return null;
  const defaultBranch = repositoryDefaultBranch(verifiedPayload);
  if (defaultBranch === null) return observation;

  const facts = deepFreeze({
    ...observation.facts,
    defaultBranch,
  });
  const canonicalSemantics = {
    version: observation.version,
    provider: observation.provider,
    sourceSchema: observation.sourceSchema,
    sourceSchemaVersion: observation.sourceSchemaVersion,
    eventType: observation.eventType,
    action: observation.action,
    repository: observation.repository,
    actor: observation.actor,
    subject: observation.subject,
    relationships: observation.relationships,
    facts,
    contentRevisions: observation.contentRevisions,
    sourceTime: observation.sourceTime,
    sourceTimeSource: observation.sourceTimeSource,
    containsRawContent: observation.containsRawContent,
  };
  return deepFreeze({
    ...canonicalSemantics,
    observationId: observation.observationId,
    deliveryId: observation.deliveryId,
    payloadDigest: observation.payloadDigest,
    semanticFingerprint: sha256(stableJson(canonicalSemantics)),
    receivedAt: observation.receivedAt,
  });
}

export function observedRepositoryDefaultBranch(
  observation: GitHubRepositoryObservation,
): string | null {
  const value = observation.facts.defaultBranch;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RangeError("Observed repository default branch is invalid");
  }
  return normalizeGitHubBranchName(value, "Observed repository default branch");
}

function repositoryDefaultBranch(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RangeError("GitHub webhook payload is invalid");
  }
  const repository = dataProperty(payload, "repository");
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    throw new RangeError("GitHub webhook repository is invalid");
  }
  const value = dataProperty(repository, "default_branch");
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RangeError("GitHub webhook repository default branch is invalid");
  }
  return normalizeGitHubBranchName(value, "GitHub webhook repository default branch");
}

function dataProperty(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new RangeError("GitHub webhook payload is invalid");
  }
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
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
