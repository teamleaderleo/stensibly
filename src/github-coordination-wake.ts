import {
  compileCoordinationWakeIntentV1,
  parseCoordinationEventSubscriptionV1,
  type CoordinationEventObservationV1,
  type CoordinationEventSubscriptionV1,
  type CoordinationRoutingLevel,
  type CoordinationWakeDecisionV1,
} from "./coordination-wake-intent.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";

export interface GitHubCoordinationWakeCompilationV1 {
  readonly sourceIdentity: string;
  readonly event: CoordinationEventObservationV1;
  readonly decision: CoordinationWakeDecisionV1;
}

/**
 * Compile one already-admitted GitHub repository observation through #327's
 * authority-free relation contract. The caller supplies the explicit target
 * subscription and the owning materiality classification. No project, item,
 * worker, or repository scan occurs here.
 */
export function compileGitHubCoordinationWakeV1(input: {
  readonly project: string;
  readonly observation: GitHubRepositoryObservation;
  readonly subscription: CoordinationEventSubscriptionV1;
  readonly routingLevel: CoordinationRoutingLevel;
}): Readonly<GitHubCoordinationWakeCompilationV1> {
  const subscription = parseCoordinationEventSubscriptionV1(input.subscription);
  const sourceIdentity = githubCoordinationSourceIdentity(input.observation);
  const event = Object.freeze({
    eventId: input.observation.observationId,
    project: input.project,
    sourceItemId: sourceIdentity,
    correlationId: sourceIdentity,
    eventType: `github.${input.observation.eventType}.${input.observation.action}`,
    routingLevel: input.routingLevel,
    sourceRunId: null,
    observedAt: input.observation.sourceTime,
    sourceRefs: Object.freeze(githubObservationSourceRefs(input.observation)),
  }) satisfies CoordinationEventObservationV1;
  return Object.freeze({
    sourceIdentity,
    event,
    decision: compileCoordinationWakeIntentV1(subscription, event),
  });
}

export function githubCoordinationSourceIdentity(
  observation: GitHubRepositoryObservation,
): string {
  const relationships = observation.relationships;
  if (relationships.pullRequestNumber !== null) {
    return `github:${observation.repository}#pull/${relationships.pullRequestNumber}`;
  }
  if (relationships.issueNumber !== null) {
    return `github:${observation.repository}#issue/${relationships.issueNumber}`;
  }
  if (relationships.ref !== null) {
    return `github:${observation.repository}#ref/${relationships.ref}`;
  }
  return `github:${observation.repository}`;
}

function githubObservationSourceRefs(
  observation: GitHubRepositoryObservation,
): string[] {
  const refs = [
    `github-observation:${observation.observationId}`,
    `github-semantic:${observation.semanticFingerprint}`,
  ];
  if (observation.relationships.revision !== null) {
    refs.push(`git:${observation.repository}@${observation.relationships.revision}`);
  }
  return refs.sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
