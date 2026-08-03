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
const observedAt = "2026-08-03T08:30:00.000Z";
const currentRevision = "github-rest:I_embedded_privacy_958:previous";

type ProposalField =
  | "project"
  | "repositoryFullName"
  | "receiptId"
  | "actorId"
  | "attachmentId"
  | "currentSourceRevision"
  | "providerSourceRevision";

describe("GitHub provider retained-identity embedded credential privacy", () => {
  test("rejects realistic credential families embedded in current source revision", () => {
    const hostile = [
      `revisionxgithub_pat_${"a".repeat(20)}`,
      `revisionxghp_${"a".repeat(20)}`,
      `revisionxsk-proj-${"a".repeat(20)}`,
      `revisionxstn.tok_${"a".repeat(20)}`,
      `revisionxxoxb-${"a".repeat(16)}`,
      "revisionxsecret://github/source-revision",
      `revisionxeyJ${"a".repeat(8)}.eyJ${"b".repeat(8)}.${"c".repeat(8)}`,
    ];

    for (const sourceRevision of hostile) {
      expectFixedRejection(
        () => actionableProposal(sourceRevision),
        "Current GitHub issue source revision cannot be credential-shaped",
        sourceRevision,
      );
    }
  });

  test("rejects refingerprinted embedded credential identities", () => {
    const original = actionableProposal(currentRevision);
    const variants: Array<{
      field: ProposalField;
      value: string;
      message: string;
    }> = [
      {
        field: "receiptId",
        value: `receiptxgithub_pat_${"a".repeat(20)}`,
        message: "GitHub reconciliation receipt ID is invalid",
      },
      {
        field: "actorId",
        value: `actorxghp_${"a".repeat(20)}`,
        message: "GitHub reconciliation actor ID is invalid",
      },
      {
        field: "actorId",
        value: `actorxxoxb-${"a".repeat(16)}`,
        message: "GitHub reconciliation actor ID is invalid",
      },
      {
        field: "attachmentId",
        value: `attachmentxsk-proj-${"a".repeat(20)}`,
        message: "GitHub reconciliation attachment ID is invalid",
      },
      {
        field: "currentSourceRevision",
        value: `revisionxstn.tok_${"a".repeat(20)}`,
        message: "GitHub context source revision is invalid",
      },
    ];

    for (const variant of variants) {
      const forged = refingerprinted(original, variant.field, variant.value);
      expectFixedRejection(
        () => compileObservation(forged),
        variant.message,
        variant.value,
      );
    }
  });

  test("rejects embedded credential families in workspace and project slugs", () => {
    const original = actionableProposal(currentRevision);
    const workspaces = [
      `workspacexghp_${"a".repeat(20)}`,
      `workspacexxoxb-${"a".repeat(16)}`,
    ];
    for (const workspace of workspaces) {
      expectFixedRejection(
        () => compileObservation(original, workspace),
        "GitHub provider instruction observation workspace is invalid",
        workspace,
      );
    }

    const projects = [
      `projectxgithub_pat_${"a".repeat(20)}`,
      `projectxxoxb-${"a".repeat(16)}`,
    ];
    for (const project of projects) {
      const forged = refingerprinted(original, "project", project);
      expectFixedRejection(
        () => compileObservation(forged),
        "GitHub reconciliation project is invalid",
        project,
      );
    }
  });

  test("rejects an embedded credential canonical repository on a non-actionable proposal", () => {
    const hostileRepository =
      `teamleaderleo/projectxgithub_pat_${"a".repeat(20)}`;
    const proposal = refingerprintedWith(actionableProposal(currentRevision), {
      repositoryFullName: hostileRepository,
      outcome: "await_provider_result",
      nextAction: "await_provider_result",
      providerSnapshot: null,
      externalId: null,
      providerSourceRevision: null,
      verificationCheckedAt: null,
    });

    expectFixedRejection(
      () => compileObservation(proposal),
      "GitHub repository identity is invalid",
      hostileRepository,
    );
  });

  test("rejects an embedded credential provider revision on identity-conflict evidence", () => {
    const hostileRevision = `providerxsk-proj-${"a".repeat(20)}`;
    const proposal = refingerprintedWith(actionableProposal(currentRevision), {
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      providerSnapshot: null,
      providerSourceRevision: hostileRevision,
    });

    expectFixedRejection(
      () => compileObservation(proposal),
      "GitHub context source revision is invalid",
      hostileRevision,
    );
  });

  test("preserves benign short token-like aliases below realistic thresholds", () => {
    const proposal = actionableProposal("revisionxghp_review");
    expect(proposal.outcome).toBe("propose_context_acceptance");
    expect(proposal.currentSourceRevision).toBe("revisionxghp_review");

    const aliases = [
      {
        actorId: "actorxghp_review",
        workspace: "workspacexghp_review",
      },
      {
        actorId: "actorxxoxb-review",
        workspace: "workspacexoxb-review",
      },
    ];
    for (const alias of aliases) {
      const request = compileObservation(
        refingerprinted(proposal, "actorId", alias.actorId),
        alias.workspace,
      );
      expect(request).toMatchObject({
        actorId: alias.actorId,
        workspace: alias.workspace,
        outcome: "ready_for_repository_instruction_observation",
        nextAction: "load_attachment_and_observe_repository_instructions",
      });
    }

    const nonActionable = refingerprintedWith(proposal, {
      project: "projectxghp_review",
      repositoryFullName: "teamleaderleo/projectxghp_review",
      outcome: "await_provider_result",
      nextAction: "await_provider_result",
      providerSnapshot: null,
      externalId: null,
      providerSourceRevision: null,
      verificationCheckedAt: null,
    });
    expect(compileObservation(nonActionable)).toMatchObject({
      project: "projectxghp_review",
      repositoryFullName: "teamleaderleo/projectxghp_review",
      outcome: "proposal_not_actionable",
      nextAction: "none",
    });

    const conflict = refingerprintedWith(proposal, {
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      providerSnapshot: null,
      providerSourceRevision: "providerxghp_review",
    });
    expect(compileObservation(conflict)).toMatchObject({
      providerSourceRevision: "providerxghp_review",
      outcome: "proposal_not_actionable",
      nextAction: "none",
    });
  });
});

function actionableProposal(
  sourceRevision: string,
): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot),
    current: {
      externalId: snapshot.reference.externalId,
      sourceRevision,
    },
  });
}

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

function refingerprinted(
  proposal: GitHubProviderContextReconciliationProposalV1,
  field: ProposalField,
  value: string,
): GitHubProviderContextReconciliationProposalV1 {
  return refingerprintedWith(proposal, { [field]: value });
}

function refingerprintedWith(
  proposal: GitHubProviderContextReconciliationProposalV1,
  changes: Partial<GitHubProviderContextReconciliationProposalV1>,
): GitHubProviderContextReconciliationProposalV1 {
  const body = structuredClone(proposal) as unknown as Record<string, unknown>;
  delete body.proposalFingerprint;
  Object.assign(body, changes);
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
}

function receipt(snapshot: GitHubIssueContext): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_embedded_privacy_958",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#958`,
    actorId: "actor_kite",
    clientId: "client_github_only",
    connectionId: "ghconn_embedded_privacy",
    installationId: "installation_embedded_privacy",
    bindingId: "ghbind_embedded_privacy",
    attachmentId: "attachment_embedded_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "embedded-privacy-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T08:29:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "request-embedded-privacy-958",
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
    title: "Retained identity embedded credential control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T08:20:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_embedded_privacy_958",
    sourceRevision: "github-rest:I_embedded_privacy_958:provider",
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
