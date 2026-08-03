import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
  type GitHubProviderContextReconciliationProposalV1,
} from "../src/github-provider-context-reconciliation.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
} from "../src/github-provider-instruction-observation-request.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const observedAt = "2026-08-03T09:20:00.000Z";
const currentRevision = "github-rest:I_retained_identity_958:previous";

describe("GitHub provider retained proposal identity privacy", () => {
  test("rejects a refingerprinted credential-shaped project", () => {
    const hostile = `projectxgithub_pat_${"a".repeat(20)}`;
    const proposal = refingerprinted(actionableProposal(), { project: hostile });

    expectFixedRejection(
      () => compileObservation(proposal),
      "GitHub reconciliation project is invalid",
      hostile,
    );
  });

  test("rejects a refingerprinted credential-shaped repository on a non-actionable proposal", () => {
    const hostile = `teamleaderleo/repositoryxgithub_pat_${"a".repeat(20)}`;
    const proposal = refingerprinted(actionableProposal(), {
      repositoryFullName: hostile,
      verificationCheckedAt: null,
      externalId: null,
      currentSourceRevision: null,
      providerSourceRevision: null,
      outcome: "await_provider_result",
      nextAction: "await_provider_result",
      providerSnapshot: null,
    });

    expectFixedRejection(
      () => compileObservation(proposal),
      "GitHub repository identity is invalid",
      hostile,
    );
  });

  test("rejects a refingerprinted credential-shaped provider source revision", () => {
    const hostile = `revisionxsk-proj-${"a".repeat(20)}`;
    const proposal = refingerprinted(actionableProposal(), {
      providerSourceRevision: hostile,
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      providerSnapshot: null,
    });

    expectFixedRejection(
      () => compileObservation(proposal),
      "GitHub context source revision is invalid",
      hostile,
    );
  });

  test("preserves benign short project, repository, and provider revision aliases", () => {
    const projectAlias = "projectxgithub_pat_review";
    const projectResult = compileObservation(refingerprinted(actionableProposal(), {
      project: projectAlias,
    }));
    expect(projectResult).toMatchObject({
      project: projectAlias,
      outcome: "ready_for_repository_instruction_observation",
    });

    const repositoryAlias = "teamleaderleo/repositoryxgithub_pat_review";
    const repositoryResult = compileObservation(refingerprinted(actionableProposal(), {
      repositoryFullName: repositoryAlias,
      verificationCheckedAt: null,
      externalId: null,
      currentSourceRevision: null,
      providerSourceRevision: null,
      outcome: "await_provider_result",
      nextAction: "await_provider_result",
      providerSnapshot: null,
    }));
    expect(repositoryResult).toMatchObject({
      repositoryFullName: repositoryAlias,
      outcome: "proposal_not_actionable",
    });

    const providerRevisionAlias = "revisionxghp_review";
    const providerResult = compileObservation(refingerprinted(actionableProposal(), {
      providerSourceRevision: providerRevisionAlias,
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      providerSnapshot: null,
    }));
    expect(providerResult).toMatchObject({
      providerSourceRevision: providerRevisionAlias,
      outcome: "proposal_not_actionable",
    });
  });
});

function compileObservation(
  proposal: GitHubProviderContextReconciliationProposalV1,
) {
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace: "default",
    proposal,
  });
}

function actionableProposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot),
    current: {
      externalId: snapshot.reference.externalId,
      sourceRevision: currentRevision,
    },
  });
}

function refingerprinted(
  proposal: GitHubProviderContextReconciliationProposalV1,
  overrides: Partial<GitHubProviderContextReconciliationProposalV1>,
): GitHubProviderContextReconciliationProposalV1 {
  const body = structuredClone(proposal) as unknown as Record<string, unknown>;
  delete body.proposalFingerprint;
  Object.assign(body, overrides);
  return {
    ...body,
    proposalFingerprint: fingerprintCanonicalRequest(body),
  } as unknown as GitHubProviderContextReconciliationProposalV1;
}

function expectFixedRejection(
  run: () => unknown,
  message: string,
  rejectedText: string,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect((thrown as Error).message).toBe(message);
  expect((thrown as Error).message).not.toContain(rejectedText);
  expect(JSON.stringify(thrown)).not.toContain(rejectedText);
}

function receipt(snapshot: GitHubIssueContext): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_retained_identity_958",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#958`,
    actorId: "actor_morrow",
    clientId: "client_github_only",
    connectionId: "ghconn_retained_identity",
    installationId: "installation_retained_identity",
    bindingId: "ghbind_retained_identity",
    attachmentId: "attachment_retained_identity",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "retained-identity-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:19:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "request-retained-identity-958",
    result: snapshot,
    verification: {
      state: "passed",
      checkedAt: observedAt,
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
    number: 958,
    title: "Retained proposal identity privacy control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_retained_identity_958",
    sourceRevision: "github-rest:I_retained_identity_958:provider",
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
