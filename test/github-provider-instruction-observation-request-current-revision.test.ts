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
const observedAt = "2026-08-03T08:10:00.000Z";

describe("GitHub provider instruction observation request current-revision semantics", () => {
  test("accepts a proposal whose current revision differs from provider readback", () => {
    const proposal = actionableProposal();
    expect(proposal).toMatchObject({
      operation: "github_update_issue",
      outcome: "propose_context_acceptance",
      nextAction: "submit_context_acceptance",
      currentSourceRevision: "github-rest:I_semantic_958:previous",
      providerSourceRevision: "github-rest:I_semantic_958:provider",
    });

    expect(compile(proposal)).toMatchObject({
      outcome: "ready_for_repository_instruction_observation",
      nextAction: "load_attachment_and_observe_repository_instructions",
      requestId: expect.stringMatching(
        /^github_instruction_observation_[a-f0-9]{64}$/u,
      ),
    });
  });

  test("rejects a refingerprinted already-current proposal before request identity", () => {
    const original = actionableProposal();
    const forgedBody = {
      ...structuredClone(original),
      currentSourceRevision: original.providerSourceRevision,
    };
    const forged = {
      ...forgedBody,
      proposalFingerprint: fingerprintCanonicalRequest(
        withoutProposalFingerprint(forgedBody),
      ),
    } as GitHubProviderContextReconciliationProposalV1;

    expect(() => compile(forged)).toThrow(
      "GitHub reconciliation proposal semantics are invalid",
    );
  });
});

function compile(proposal: GitHubProviderContextReconciliationProposalV1) {
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
      sourceRevision: "github-rest:I_semantic_958:previous",
    },
  });
}

function receipt(snapshot: GitHubIssueContext): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_observation_semantic_958",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#958`,
    actorId: "actor_loom",
    clientId: "client_github_only",
    connectionId: "ghconn_observation_semantic",
    installationId: "installation_observation_semantic",
    bindingId: "ghbind_observation_semantic",
    attachmentId: "attachment_observation_semantic",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "observation-semantic-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T08:09:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "request-observation-semantic-958",
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
    title: "Observation request semantic control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T08:09:50.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_semantic_958",
    sourceRevision: "github-rest:I_semantic_958:provider",
  });
}

function withoutProposalFingerprint(
  proposal: GitHubProviderContextReconciliationProposalV1,
): Omit<
  GitHubProviderContextReconciliationProposalV1,
  "proposalFingerprint"
> {
  const { proposalFingerprint: _proposalFingerprint, ...body } = proposal;
  return body;
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
