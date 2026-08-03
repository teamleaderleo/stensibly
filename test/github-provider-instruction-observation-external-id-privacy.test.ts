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
const issueNumber = 958;
const observedAt = "2026-08-03T09:35:00.000Z";

describe("GitHub provider instruction-observation external ID admission", () => {
  test("rejects a credential-shaped canonical external ID without echo", () => {
    const hostileExternalId =
      `github:teamleaderleo/projectxgithub_pat_${"a".repeat(20)}#${issueNumber}`;

    expectFixedRejection(
      () => compileObservation(identityConflictProposal(hostileExternalId)),
      "GitHub issue external ID is invalid",
      hostileExternalId,
    );
  });

  test("rejects an external ID outside the proposal repository", () => {
    const foreignExternalId = `github:example/project#${issueNumber}`;

    expectFixedRejection(
      () => compileObservation(identityConflictProposal(foreignExternalId)),
      "GitHub reconciliation proposal external ID is outside the bound repository",
      foreignExternalId,
    );
  });

  test("preserves same-repository identity-conflict evidence as non-actionable", () => {
    const proposal = actionableProposal();
    const conflict = identityConflictProposal(proposal.externalId!);

    expect(compileObservation(conflict)).toMatchObject({
      repositoryFullName,
      externalId: proposal.externalId,
      outcome: "proposal_not_actionable",
      nextAction: "none",
      requestId: null,
      observationRef: null,
      authorizesProviderRead: false,
      authorizesProviderMutation: false,
      authorizesContextAcceptance: false,
      authorizesApproval: false,
      authorizesAuthority: false,
    });
  });
});

function identityConflictProposal(
  externalId: string,
): GitHubProviderContextReconciliationProposalV1 {
  const proposal = actionableProposal();
  const body = structuredClone(proposal) as unknown as Record<string, unknown>;
  delete body.proposalFingerprint;
  Object.assign(body, {
    outcome: "identity_conflict",
    nextAction: "inspect_issue_identity_conflict",
    providerSnapshot: null,
    externalId,
  });
  return {
    ...body,
    proposalFingerprint: fingerprintCanonicalRequest(body),
  } as unknown as GitHubProviderContextReconciliationProposalV1;
}

function actionableProposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot),
    current: {
      externalId: snapshot.reference.externalId,
      sourceRevision: "github-rest:I_external_id_privacy:previous",
    },
  });
}

function compileObservation(
  proposal: GitHubProviderContextReconciliationProposalV1,
) {
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace: "default",
    proposal,
  });
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
    id: "ghop_external_id_privacy",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#${issueNumber}`,
    actorId: "actor_cedar",
    clientId: "client_github_only",
    connectionId: "ghconn_external_id_privacy",
    installationId: "installation_external_id_privacy",
    bindingId: "ghbind_external_id_privacy",
    attachmentId: "attachment_external_id_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "external-id-privacy-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:34:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-EXTERNAL-ID-PRIVACY",
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
    number: issueNumber,
    title: "Bind retained reconciliation external IDs",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:30:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_external_id_privacy",
    sourceRevision: "github-rest:I_external_id_privacy:provider",
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
