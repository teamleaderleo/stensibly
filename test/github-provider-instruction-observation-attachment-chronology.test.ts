import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
} from "../src/github-provider-instruction-observation-request.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
  resolveGitHubProviderInstructionObservationV1,
} from "../src/github-provider-instruction-observation-resolution.ts";
import {
  compileProjectContract,
  renderProjectContract,
  type ProjectAttachmentSnapshot,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";

const workspace = "default";
const project = "stensibly";
const repositoryFullName = "teamleaderleo/stensibly";
const attachmentId = "attach_instruction_chronology";
const attachmentRevision = "main@accepted";
const providerObservedAt = "2026-08-03T09:30:00.000Z";

describe("GitHub instruction observation accepted-attachment chronology", () => {
  test("rejects an attachment generation accepted after provider verification", () => {
    const attachment = attachmentRecord({
      acceptedAt: "2026-08-03T09:30:00.001Z",
    });
    const result = resolve(
      observationRequest(attachment),
      attachment,
      observed(attachment, "2026-08-03T09:31:00.000Z"),
    );

    expect(result).toMatchObject({
      outcome: "observation_chronology_conflict",
      nextAction: "reobserve_repository_instructions",
      instructionSet: null,
    });
  });

  test("rejects an observation made before the exact attachment generation was accepted", () => {
    const attachment = attachmentRecord({
      acceptedAt: "2026-08-03T09:30:30.000Z",
    });
    const result = resolve(
      observationRequest(attachment),
      attachment,
      observed(attachment, "2026-08-03T09:30:29.999Z"),
    );

    expect(result).toMatchObject({
      outcome: "observation_chronology_conflict",
      nextAction: "reobserve_repository_instructions",
      instructionSet: null,
      instructionObservedAt: "2026-08-03T09:30:29.999Z",
    });
  });

  test("accepts equality at attachment, provider, and instruction chronology boundaries", () => {
    const attachment = attachmentRecord({
      acceptedAt: providerObservedAt,
    });
    const result = resolve(
      observationRequest(attachment),
      attachment,
      observed(attachment, providerObservedAt),
    );

    expect(result).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      nextAction: "compose_context_acceptance",
      instructionObservedAt: providerObservedAt,
      observedBy: "actor_observer",
    });
    expect(result.instructionSet).not.toBeNull();
  });
});

function resolve(
  request: ReturnType<typeof observationRequest>,
  attachment: ProjectAttachmentRecord,
  observation: ReturnType<typeof observed>,
) {
  return resolveGitHubProviderInstructionObservationV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    request,
    attachment,
    observation,
  });
}

function observationRequest(attachment: ProjectAttachmentRecord) {
  const proposal = compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(attachment),
    current: null,
  });
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal,
  });
}

function receipt(attachment: ProjectAttachmentRecord): GitHubProviderReceipt {
  const snapshot = issueSnapshot();
  return {
    version: 1,
    id: "ghop_instruction_attachment_chronology",
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_morrow",
    clientId: "client_github_only",
    connectionId: "ghconn_instruction_chronology",
    installationId: "installation_instruction_chronology",
    bindingId: "ghbind_instruction_chronology",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "instruction-attachment-chronology",
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:29:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: "request-instruction-chronology",
    result: snapshot,
    verification: {
      state: "passed",
      checkedAt: providerObservedAt,
      sourceRevision: snapshot.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function issueSnapshot(): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 1006,
    title: "Accepted attachment chronology control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: providerObservedAt,
    providerNodeId: "I_instruction_attachment_chronology",
    sourceRevision: "github-rest:I_instruction_attachment_chronology:provider",
  });
}

function attachmentRecord(
  overrides: Partial<ProjectAttachmentRecord> = {},
): ProjectAttachmentRecord {
  const snapshot = overrides.snapshot ?? attachmentSnapshot();
  return {
    id: attachmentId,
    project: snapshot.contract.project,
    snapshot,
    sourceRevision: attachmentRevision,
    acceptedBy: "actor_human",
    authorityWidening: false,
    acceptedAt: "2026-08-03T09:00:00.000Z",
    ...overrides,
  };
}

function attachmentSnapshot(): ProjectAttachmentSnapshot {
  return compileProjectContract(renderProjectContract({
    version: 1,
    project,
    repositories: [repositoryFullName],
    runnerProfiles: ["chatgpt"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect"],
    approvalRequired: ["merge"],
    checks: ["typecheck"],
    tags: [],
    relatedProjects: [],
  }, {
    goal: "Private attachment goal prose",
    boundaries: "Private attachment boundary prose",
    evidenceAndHandoff: "Private attachment evidence prose",
    escalation: "Private attachment escalation prose",
  }));
}

function observed(
  attachment: ProjectAttachmentRecord,
  observedAt: string,
) {
  return {
    observedAt,
    observedBy: "actor_observer",
    sources: [
      attachmentSource(attachment),
      source("AGENTS.md", "main@agents", hash("b")),
    ],
  };
}

function attachmentSource(attachment: ProjectAttachmentRecord) {
  return source(
    attachment.snapshot.source.path,
    attachment.sourceRevision,
    attachment.snapshot.source.contentSha256,
  );
}

function source(path: string, revision: string, contentSha256: string) {
  return { path, revision, contentSha256 };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
