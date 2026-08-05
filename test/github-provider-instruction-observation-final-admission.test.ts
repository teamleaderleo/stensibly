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
const observedAt = "2026-08-03T20:40:00.000Z";
const previousRevision = "github-rest:I_final_admission_958:previous";

type ProposalField =
  | "receiptId"
  | "actorId"
  | "attachmentId"
  | "currentSourceRevision"
  | "providerSourceRevision";

describe("GitHub instruction-observation final proposal admission", () => {
  test("rejects create proposals with prior accepted revision before nested snapshot access", () => {
    const original = createProposal();
    const forged = refingerprintedWith(original, {
      currentSourceRevision: previousRevision,
    });
    const snapshot = forged.providerSnapshot!;
    let nestedReads = 0;
    const hostileSnapshot = new Proxy(snapshot, {
      getPrototypeOf(target) {
        nestedReads += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        nestedReads += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        nestedReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const hostile = {
      ...forged,
      providerSnapshot: hostileSnapshot,
    } as GitHubProviderContextReconciliationProposalV1;

    expect(() => compileObservation(hostile)).toThrow(
      "GitHub reconciliation proposal semantics are invalid",
    );
    expect(nestedReads).toBe(0);
  });

  test("rejects provider issue identities above the GitHub item ceiling", () => {
    const externalId = `github:${repositoryFullName}#2147483648`;
    const conflict = refingerprintedWith(updateProposal(), {
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      providerSnapshot: null,
      externalId,
    });

    expectFixedRejection(
      () => compileObservation(conflict),
      "GitHub issue external ID is invalid",
      externalId,
    );
  });

  test("uses the landed retained-credential policy for proposal identities", () => {
    const original = updateProposal();
    const token = "a".repeat(12);
    const variants: Array<{
      field: ProposalField;
      value: string;
      message: string;
    }> = [
      {
        field: "receiptId",
        value: `receiptxstn.tok_${token}`,
        message: "GitHub reconciliation receipt ID is invalid",
      },
      {
        field: "actorId",
        value: `actorxstn.svc_${token}`,
        message: "GitHub reconciliation actor ID is invalid",
      },
      {
        field: "attachmentId",
        value: "attachmentxauthorization:token",
        message: "GitHub reconciliation attachment ID is invalid",
      },
      {
        field: "currentSourceRevision",
        value: `revisionxstn.tok_${token}`,
        message: "GitHub context source revision is invalid",
      },
      {
        field: "providerSourceRevision",
        value: `providerxstn.svc_${token}`,
        message: "GitHub context source revision is invalid",
      },
    ];

    for (const variant of variants) {
      const forged = refingerprinted(
        original,
        variant.field,
        variant.value,
      );
      expectFixedRejection(
        () => compileObservation(forged),
        variant.message,
        variant.value,
      );
    }

    const hostileRepository =
      `teamleaderleo/projectxstn.svc_${token}`;
    const nonActionable = refingerprintedWith(original, {
      repositoryFullName: hostileRepository,
      outcome: "await_provider_result",
      nextAction: "await_provider_result",
      providerSnapshot: null,
      externalId: null,
      providerSourceRevision: null,
      verificationCheckedAt: null,
    });
    expectFixedRejection(
      () => compileObservation(nonActionable),
      "GitHub repository identity is invalid",
      hostileRepository,
    );
  });

  test("preserves benign short Stensibly-like aliases", () => {
    const original = updateProposal();
    const benign = refingerprintedWith(original, {
      actorId: "actorxstn.svc_review",
      attachmentId: "attachmentxstn.tok_review",
      currentSourceRevision: "revisionxstn.tok_review",
    });

    expect(compileObservation(benign)).toMatchObject({
      actorId: "actorxstn.svc_review",
      attachmentId: "attachmentxstn.tok_review",
      previousSourceRevision: "revisionxstn.tok_review",
      outcome: "ready_for_repository_instruction_observation",
      nextAction: "load_attachment_and_observe_repository_instructions",
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

function updateProposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot),
    current: {
      externalId: snapshot.reference.externalId,
      sourceRevision: previousRevision,
    },
  });
}

function createProposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot, {
      id: "ghop_final_admission_create_958",
      operation: "github_create_issue",
      target: `${repositoryFullName}#new`,
      idempotencyKey: "final-admission-create-958",
    }),
    current: null,
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
  expect(JSON.stringify(thrown)).not.toContain(rejectedText);
}

function receipt(
  snapshot: GitHubIssueContext,
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_final_admission_update_958",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#${issueNumber}`,
    actorId: "actor_cicada",
    clientId: "client_github_only",
    connectionId: "ghconn_final_admission",
    installationId: "installation_final_admission",
    bindingId: "ghbind_final_admission",
    attachmentId: "attachment_final_admission",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "final-admission-update-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T20:39:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-FINAL-ADMISSION-958",
    result: snapshot,
    verification: {
      state: "passed",
      checkedAt: observedAt,
      sourceRevision: snapshot.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  };
}

function issueSnapshot(): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: issueNumber,
    title: "Final instruction observation admission controls",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T20:30:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_final_admission_958",
    sourceRevision: "github-rest:I_final_admission_958:provider",
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
