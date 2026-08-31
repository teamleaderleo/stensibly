import { sha256, stableJson } from "./canonical-json.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";

export const GITHUB_PR_MATERIALITY_V1 = 1 as const;

export const githubPrActionClasses = [
  "routine",
  "review_eligible",
  "exact_head_changed",
  "review_suspended",
  "repair_requested",
  "integration_eligible",
  "review_invalidated",
  "candidate_closed",
  "candidate_merged",
] as const;

export type GitHubPrActionClass = typeof githubPrActionClasses[number];
export type GitHubPrRoutingLevel = "record" | "attention";

export interface GitHubPrMaterialityV1 {
  readonly version: typeof GITHUB_PR_MATERIALITY_V1;
  readonly sourceObservationId: string;
  readonly sourceSemanticFingerprint: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly sourceEventType: "pull_request" | "pull_request_review";
  readonly sourceAction: string;
  readonly actionClass: GitHubPrActionClass;
  readonly routingLevel: GitHubPrRoutingLevel;
  readonly revision: string | null;
  readonly invalidatesExactHeadEvidence: boolean;
  readonly invalidatesReviewEvidence: boolean;
  readonly makesReviewEligible: boolean;
  readonly makesRepairEligible: boolean;
  readonly makesIntegrationEligible: boolean;
  readonly settlesCandidate: boolean;
  readonly merged: boolean | null;
  readonly grantsAuthority: false;
  readonly authorizesDispatch: false;
  readonly fingerprint: string;
}

/**
 * Classify one already-admitted GitHub pull-request lifecycle observation.
 *
 * This is only event materiality. It does not discover a work relation, decide
 * responsibility, accept a review, merge a candidate, or dispatch a runner. A
 * later owner must bind the exact PR to current work and re-read its generation.
 */
export function classifyGitHubPrMaterialityV1(
  observation: GitHubRepositoryObservation,
): Readonly<GitHubPrMaterialityV1> | null {
  if (
    observation.eventType !== "pull_request"
    && observation.eventType !== "pull_request_review"
  ) {
    return null;
  }
  const pullRequestNumber = observation.relationships.pullRequestNumber;
  if (pullRequestNumber === null) {
    throw new RangeError("Pull-request lifecycle observation has no pull request number");
  }

  const classification = observation.eventType === "pull_request"
    ? classifyPullRequest(observation)
    : classifyReview(observation);
  const body = {
    version: GITHUB_PR_MATERIALITY_V1,
    sourceObservationId: observation.observationId,
    sourceSemanticFingerprint: observation.semanticFingerprint,
    repository: observation.repository,
    pullRequestNumber,
    sourceEventType: observation.eventType,
    sourceAction: observation.action,
    actionClass: classification.actionClass,
    routingLevel: classification.routingLevel,
    revision: observation.relationships.revision,
    invalidatesExactHeadEvidence: classification.actionClass === "exact_head_changed",
    invalidatesReviewEvidence: classification.actionClass === "exact_head_changed"
      || classification.actionClass === "review_invalidated",
    makesReviewEligible: classification.actionClass === "review_eligible",
    makesRepairEligible: classification.actionClass === "repair_requested",
    makesIntegrationEligible: classification.actionClass === "integration_eligible",
    settlesCandidate: classification.actionClass === "candidate_closed"
      || classification.actionClass === "candidate_merged",
    merged: classification.merged,
    grantsAuthority: false as const,
    authorizesDispatch: false as const,
  };
  return deepFreeze({ ...body, fingerprint: sha256(stableJson(body)) });
}

function classifyPullRequest(
  observation: GitHubRepositoryObservation,
): Readonly<{
  actionClass: GitHubPrActionClass;
  routingLevel: GitHubPrRoutingLevel;
  merged: boolean | null;
}> {
  const merged = factBoolean(observation, "merged");
  const draft = factBoolean(observation, "draft");
  switch (observation.action) {
    case "opened":
    case "reopened":
      return draft
        ? result("routine", "record", merged)
        : result("review_eligible", "attention", merged);
    case "ready_for_review":
      return result("review_eligible", "attention", merged);
    case "synchronize":
      return result("exact_head_changed", "attention", merged);
    case "converted_to_draft":
      return result("review_suspended", "attention", merged);
    case "closed":
      return merged
        ? result("candidate_merged", "attention", true)
        : result("candidate_closed", "attention", false);
    default:
      return result("routine", "record", merged);
  }
}

function classifyReview(
  observation: GitHubRepositoryObservation,
): Readonly<{
  actionClass: GitHubPrActionClass;
  routingLevel: GitHubPrRoutingLevel;
  merged: null;
}> {
  if (observation.action === "dismissed") {
    return result("review_invalidated", "attention", null);
  }
  if (observation.action !== "submitted") {
    return result("routine", "record", null);
  }
  const state = factString(observation, "state");
  if (state === "changes_requested") {
    return result("repair_requested", "attention", null);
  }
  if (state === "approved") {
    return result("integration_eligible", "attention", null);
  }
  return result("routine", "record", null);
}

function result<Merged extends boolean | null>(
  actionClass: GitHubPrActionClass,
  routingLevel: GitHubPrRoutingLevel,
  merged: Merged,
): Readonly<{
  actionClass: GitHubPrActionClass;
  routingLevel: GitHubPrRoutingLevel;
  merged: Merged;
}> {
  return Object.freeze({ actionClass, routingLevel, merged });
}

function factBoolean(
  observation: GitHubRepositoryObservation,
  name: string,
): boolean {
  const value = observation.facts[name];
  if (typeof value !== "boolean") {
    throw new RangeError(`Pull-request observation fact ${name} is invalid`);
  }
  return value;
}

function factString(
  observation: GitHubRepositoryObservation,
  name: string,
): string {
  const value = observation.facts[name];
  if (typeof value !== "string") {
    throw new RangeError(`Pull-request review fact ${name} is invalid`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
