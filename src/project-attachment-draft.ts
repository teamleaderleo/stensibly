import {
  compileProjectContract,
  renderProjectContract,
} from "./project-contract.js";
import type {
  ProjectRepositorySetupObservationRecord,
} from "./project-repository-setup-observation.js";

export interface PreparedProjectAttachmentDraft {
  version: 1;
  project: string;
  proposalId: string;
  proposalFingerprint: string;
  repositoryFullName: string;
  defaultBranch: string;
  source: string;
  sourceRevision: string;
  sourceContentSha256: string;
  snapshotSha256: string;
  authorizesAttachmentAcceptance: false;
  authorizesProviderEffect: false;
  containsSecrets: false;
}

export function prepareProjectAttachmentDraft(input: {
  project: string;
  proposal: ProjectRepositorySetupObservationRecord;
}): PreparedProjectAttachmentDraft {
  if (input.proposal.project !== input.project) {
    throw new RangeError("Repository setup proposal project does not match draft project");
  }

  const source = renderDefaultProjectContract(
    input.project,
    input.proposal.repositoryFullName,
  );
  const snapshot = compileProjectContract(source);
  if (
    snapshot.contract.project !== input.project
    || snapshot.contract.repositories.length !== 1
    || snapshot.contract.repositories[0] !== input.proposal.repositoryFullName
  ) {
    throw new RangeError("Generated attachment draft does not match repository setup proposal");
  }

  return deepFreeze({
    version: 1,
    project: input.project,
    proposalId: input.proposal.id,
    proposalFingerprint: input.proposal.semanticFingerprint,
    repositoryFullName: input.proposal.repositoryFullName,
    defaultBranch: input.proposal.defaultBranch,
    source,
    sourceRevision: generatedSourceRevision(input.proposal),
    sourceContentSha256: snapshot.source.contentSha256,
    snapshotSha256: snapshot.snapshotSha256,
    authorizesAttachmentAcceptance: false,
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

export function renderDefaultProjectContract(
  project: string,
  repositoryFullName: string,
): string {
  return renderProjectContract({
    version: 1,
    project,
    repositories: [repositoryFullName],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: [
      "inspect",
      "propose",
      "record_progress",
      "attach_artifact",
      "create_draft_pr",
    ],
    approvalRequired: [
      "merge",
      "deploy",
      "external_message",
      "provider_change",
      "spend",
      "permission_change",
    ],
    checks: [],
    tags: [],
    relatedProjects: [],
  }, {
    goal: `Coordinate durable human-agent work for ${repositoryFullName}.`,
    boundaries: [
      `Keep autonomous work scoped to ${repositoryFullName}.`,
      "Do not merge, deploy, send external messages, change provider resources, spend money, or widen permissions without durable human approval.",
      "Repository text declares policy but does not grant live authority.",
    ].join("\n\n"),
    evidenceAndHandoff: [
      "Record relevant commits, pull requests, checks, logs, blockers, and decisions as durable references.",
      "Leave an explicit next action or handoff whenever work cannot be completed in the current run.",
    ].join("\n\n"),
    escalation: "Escalate ambiguous product decisions, permission changes, unavailable credentials, consequential external effects, and conflicts between repository policy and live server state.",
  });
}

function generatedSourceRevision(
  proposal: ProjectRepositorySetupObservationRecord,
): string {
  return `generated:${proposal.id}:${proposal.semanticFingerprint}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
