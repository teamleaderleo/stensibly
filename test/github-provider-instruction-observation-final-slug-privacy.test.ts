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
const observedAt = "2026-08-03T20:45:00.000Z";

describe("GitHub instruction-observation retained slug privacy", () => {
  test("rejects grammar-valid credential-shaped project and workspace slugs", () => {
    const token = `github_pat_${"a".repeat(20)}`;
    const project = `projectx${token}`;
    const workspace = `workspacex${token}`;
    const canonical = proposal();
    const hostileProject = refingerprintedWith(canonical, { project });

    expectFixedRejection(
      () => compile(hostileProject, "default"),
      "GitHub reconciliation project is invalid",
      project,
    );
    expectFixedRejection(
      () => compile(canonical, workspace),
      "GitHub provider instruction observation workspace is invalid",
      workspace,
    );
  });

  test("preserves benign short token-like project and workspace slugs", () => {
    const project = "project_github_pat_review";
    const workspace = "workspace_github_pat_review";
    const candidate = refingerprintedWith(proposal(), { project });

    expect(compile(candidate, workspace)).toMatchObject({
      project,
      workspace,
      outcome: "ready_for_repository_instruction_observation",
      nextAction: "load_attachment_and_observe_repository_instructions",
    });
  });
});

function compile(
  candidate: GitHubProviderContextReconciliationProposalV1,
  workspace: string,
) {
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal: candidate,
  });
}

function proposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot),
    current: {
      externalId: snapshot.reference.externalId,
      sourceRevision: "github-rest:I_slug_privacy:previous",
    },
  });
}

function refingerprintedWith(
  candidate: GitHubProviderContextReconciliationProposalV1,
  changes: Partial<GitHubProviderContextReconciliationProposalV1>,
): GitHubProviderContextReconciliationProposalV1 {
  const body = structuredClone(candidate) as unknown as Record<string, unknown>;
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
  expect(JSON.stringify(thrown)).not.toContain(rejectedText);
}

function receipt(snapshot: GitHubIssueContext): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_instruction_slug_privacy",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#958`,
    actorId: "actor_morrow",
    clientId: "client_github_only",
    connectionId: "ghconn_instruction_slug_privacy",
    installationId: "installation_instruction_slug_privacy",
    bindingId: "ghbind_instruction_slug_privacy",
    attachmentId: "attachment_instruction_slug_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "instruction-slug-privacy",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T20:44:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-INSTRUCTION-SLUG-PRIVACY",
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
    title: "Instruction observation slug privacy",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T20:40:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_slug_privacy",
    sourceRevision: "github-rest:I_slug_privacy:provider",
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
