import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
  composeGitHubProviderContextAcceptanceV1,
} from "../src/github-provider-context-acceptance-composer.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
  type GitHubProviderContextReconciliationProposalV1,
} from "../src/github-provider-context-reconciliation.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 975;
const observedAt = "2026-08-04T18:20:00.000Z";
const previousRevision = "github-rest:I_acceptance_final:previous";

describe("GitHub context acceptance final proposal admission", () => {
  test("rejects impossible create chronology before nested provider snapshot access", () => {
    const forged = refingerprintedWith(createProposal(), {
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

    expect(() => compose(hostile)).toThrow(
      "GitHub reconciliation proposal semantics are invalid",
    );
    expect(nestedReads).toBe(0);
  });

  test("rejects proposal identities through the final retained credential policy", () => {
    const token = "a".repeat(12);
    const original = updateProposal();
    const cases: Array<{
      changes: Partial<GitHubProviderContextReconciliationProposalV1>;
      message: string;
      rejected: string;
    }> = [
      {
        changes: { receiptId: `receiptxstn.svc_${token}` },
        message: "GitHub reconciliation receipt ID is invalid",
        rejected: `receiptxstn.svc_${token}`,
      },
      {
        changes: { currentSourceRevision: `revisionxstn.tok_${token}` },
        message: "GitHub context source revision is invalid",
        rejected: `revisionxstn.tok_${token}`,
      },
      {
        changes: { attachmentId: "attachmentxauthorization:token" },
        message: "GitHub reconciliation attachment ID is invalid",
        rejected: "attachmentxauthorization:token",
      },
    ];

    for (const candidate of cases) {
      expectFixedRejection(
        () => compose(refingerprintedWith(original, candidate.changes)),
        candidate.message,
        candidate.rejected,
      );
    }
  });

  test("rejects external issue identities above the GitHub provider ceiling", () => {
    const externalId = `github:${repositoryFullName}#2147483648`;
    const conflict = refingerprintedWith(updateProposal(), {
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      providerSnapshot: null,
      externalId,
    });

    expectFixedRejection(
      () => compose(conflict),
      "GitHub issue external ID is invalid",
      externalId,
    );
  });
});

function compose(proposal: GitHubProviderContextReconciliationProposalV1) {
  return composeGitHubProviderContextAcceptanceV1({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
    workspace: "default",
    proposal,
    binding: null,
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
      id: "ghop_acceptance_final_create",
      operation: "github_create_issue",
      target: `${repositoryFullName}#new`,
      idempotencyKey: "acceptance-final-create",
    }),
    current: null,
  });
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
    id: "ghop_acceptance_final_update",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#${issueNumber}`,
    actorId: "actor_lark",
    clientId: "client_github_only",
    connectionId: "ghconn_acceptance_final",
    installationId: "installation_acceptance_final",
    bindingId: "ghbind_acceptance_final",
    attachmentId: "attachment_acceptance_final",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "acceptance-final-update",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-04T18:19:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-ACCEPTANCE-FINAL",
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
    title: "Final context acceptance proposal admission",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-04T18:00:00.000Z",
    updatedAt: observedAt,
    providerNodeId: "I_acceptance_final",
    sourceRevision: "github-rest:I_acceptance_final:provider",
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
