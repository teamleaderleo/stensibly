import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
} from "../src/github-provider-instruction-observation-request.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
  type GitHubProviderContextReconciliationProposalV1,
} from "../src/github-provider-context-reconciliation.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const observedAt = "2026-08-03T08:10:00.000Z";

describe("GitHub provider instruction observation current revision", () => {
  test("rejects a refingerprinted acceptance proposal that is already current", () => {
    const original = compileGitHubProviderContextReconciliation({
      schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
      receipt: succeededCreateReceipt(),
      current: null,
    });
    expect(original.outcome).toBe("propose_context_acceptance");
    expect(original.currentSourceRevision).toBeNull();
    expect(original.providerSourceRevision).not.toBeNull();

    const forgedBody = {
      ...structuredClone(original),
      currentSourceRevision: original.providerSourceRevision,
    };
    const forged = {
      ...forgedBody,
      proposalFingerprint: fingerprintCanonicalRequest(
        withoutProposalFingerprint(forgedBody),
      ),
    };

    expect(() => compileGitHubProviderInstructionObservationRequestV1({
      schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
      workspace: "default",
      proposal: forged,
    })).toThrow("GitHub reconciliation proposal semantics are invalid");
  });
});

function succeededCreateReceipt(): GitHubProviderReceipt {
  const snapshot = issueSnapshot();
  return {
    version: 1,
    id: "ghop_instruction_current_revision",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_kestrel",
    clientId: "client_github_only",
    connectionId: "ghconn_instruction_current_revision",
    installationId: "installation_instruction_current_revision",
    bindingId: "ghbind_instruction_current_revision",
    attachmentId: "attachment_instruction_current_revision",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "instruction-current-revision",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T08:09:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "request-instruction-current-revision",
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
    number: 991,
    title: "Instruction observation current revision control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T08:00:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_instruction_current_revision",
    sourceRevision: "github-rest:I_instruction_current_revision:provider",
  });
}

function withoutProposalFingerprint(
  proposal: Omit<
    GitHubProviderContextReconciliationProposalV1,
    "proposalFingerprint"
  > & { proposalFingerprint?: string },
) {
  const { proposalFingerprint: _proposalFingerprint, ...body } = proposal;
  return body;
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
