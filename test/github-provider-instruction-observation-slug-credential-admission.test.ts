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
const observedAt = "2026-08-03T20:56:00.000Z";

describe("GitHub instruction-observation slug credential admission", () => {
  test("rejects grammar-valid embedded credential workspace and project slugs", () => {
    const proposal = actionableProposal();
    const token = "a".repeat(20);
    const workspace = `workspacexgithub_pat_${token}`;
    const project = `projectxgithub_pat_${token}`;

    expectFixedRejection(
      () => compileObservation(proposal, workspace),
      "GitHub provider instruction observation workspace is invalid",
      workspace,
    );

    expectFixedRejection(
      () => compileObservation(refingerprintedProject(proposal, project)),
      "GitHub reconciliation project is invalid",
      project,
    );
  });

  test("preserves benign short token-like workspace and project slugs", () => {
    const workspace = "workspacexgithub_pat_review";
    const project = "projectxgithub_pat_review";
    const result = compileObservation(
      refingerprintedProject(actionableProposal(), project),
      workspace,
    );

    expect(result).toMatchObject({
      workspace,
      project,
      outcome: "ready_for_repository_instruction_observation",
      nextAction: "load_attachment_and_observe_repository_instructions",
    });
  });
});

function compileObservation(
  proposal: GitHubProviderContextReconciliationProposalV1,
  workspace = "default",
) {
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
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
      sourceRevision: "github-rest:I_slug_credential_958:previous",
    },
  });
}

function refingerprintedProject(
  proposal: GitHubProviderContextReconciliationProposalV1,
  project: string,
): GitHubProviderContextReconciliationProposalV1 {
  const body = structuredClone(proposal) as unknown as Record<string, unknown>;
  delete body.proposalFingerprint;
  body.project = project;
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
    id: "ghop_slug_credential_958",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#${issueNumber}`,
    actorId: "actor_cicada",
    clientId: "client_github_only",
    connectionId: "ghconn_slug_credential",
    installationId: "installation_slug_credential",
    bindingId: "ghbind_slug_credential",
    attachmentId: "attachment_slug_credential",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "slug-credential-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T20:55:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-SLUG-CREDENTIAL-958",
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
    title: "Instruction observation slug credential controls",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T20:50:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_slug_credential_958",
    sourceRevision: "github-rest:I_slug_credential_958:provider",
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
