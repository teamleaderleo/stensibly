import { describe, expect, test } from "bun:test";
import type {
  GitHubIssueComment,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  compileGitHubProviderContextReconciliationV1,
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
} from "../src/github-provider-context-reconciliation.ts";

const issue = buildGitHubIssueContext({
  owner: "teamleaderleo",
  repository: "stensibly",
  number: 958,
  title: "Compile verified GitHub issue receipts into context proposals",
  body: "This body remains outside the provider receipt and proposal.",
  state: "open",
  labels: ["area:github"],
  assignees: ["teamleaderleo"],
  createdAt: "2026-08-02T17:00:00.000Z",
  updatedAt: "2026-08-02T17:01:00.000Z",
  providerNodeId: "I_kwDOContext958",
  sourceRevision: "github-rest:I_kwDOContext958:2026-08-02T17:01:00.000Z",
});

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_context_958",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_update_issue",
    target: "teamleaderleo/stensibly#958",
    actorId: "actor_morrow",
    clientId: "client_github_only",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "context-reconciliation-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:00:00.000Z",
    updatedAt: "2026-08-02T17:01:00.000Z",
    providerRequestId: "ABCD:1234",
    result: issue,
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T17:01:00.000Z",
      sourceRevision: issue.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  };
}

function input(
  providerReceipt: GitHubProviderReceipt,
  currentAcceptedIssueExternalId: string | null = null,
  currentAcceptedSourceRevision: string | null = null,
) {
  return {
    version: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: providerReceipt,
    currentAcceptedIssueExternalId,
    currentAcceptedSourceRevision,
  };
}

describe("GitHub provider context reconciliation", () => {
  test("proposes an admitted successful issue readback without granting acceptance", () => {
    const proposal = compileGitHubProviderContextReconciliationV1(
      input(receipt()),
    );

    expect(proposal.outcome).toBe("propose_context_acceptance");
    expect(proposal.nextAction).toBe("accept_provider_issue_context");
    expect(proposal.providerIssueExternalId).toBe(issue.reference.externalId);
    expect(proposal.providerSourceRevision).toBe(issue.sourceRevision);
    expect(proposal.issue).toEqual(issue);
    expect(proposal.authorizesProviderMutation).toBe(false);
    expect(proposal.authorizesContextAcceptance).toBe(false);
    expect(proposal.grantsAuthority).toBe(false);
    expect(proposal.receiptFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(proposal.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(proposal.proposalFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.issue)).toBe(true);
    expect(JSON.stringify(proposal)).not.toContain("This body remains");
  });

  test("returns already current without copying the issue snapshot", () => {
    const proposal = compileGitHubProviderContextReconciliationV1(input(
      receipt(),
      issue.reference.externalId,
      issue.sourceRevision,
    ));

    expect(proposal.outcome).toBe("already_current");
    expect(proposal.nextAction).toBe("none");
    expect(proposal.issue).toBeNull();
  });

  test("proposes stale provider readback while preserving failed mutation evidence", () => {
    const proposal = compileGitHubProviderContextReconciliationV1(input(receipt({
      state: "stale",
      verification: {
        state: "failed",
        checkedAt: "2026-08-02T17:01:00.000Z",
        sourceRevision: issue.sourceRevision,
      },
      error: {
        code: "stale_provider_version",
        message: "GitHub issue source revision changed before the guarded update",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    })));

    expect(proposal.receiptState).toBe("stale");
    expect(proposal.outcome).toBe("propose_context_acceptance");
    expect(proposal.issue?.sourceRevision).toBe(issue.sourceRevision);
    expect(JSON.stringify(proposal)).not.toContain("guarded update");
  });

  test("keeps reserved and ambiguous operations visibly distinct", () => {
    const reserved = compileGitHubProviderContextReconciliationV1(input(receipt({
      state: "reserved",
      result: null,
      providerRequestId: null,
      verification: { state: "not_run", checkedAt: null, sourceRevision: null },
    })));
    const pending = compileGitHubProviderContextReconciliationV1(input(receipt({
      state: "pending_reconciliation",
      result: null,
      verification: {
        state: "failed",
        checkedAt: "2026-08-02T17:01:00.000Z",
        sourceRevision: null,
      },
      error: {
        code: "ambiguous_provider_outcome",
        message: "Provider outcome is unknown",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    })));

    expect(reserved.outcome).toBe("await_provider_result");
    expect(reserved.nextAction).toBe("wait_for_provider_result");
    expect(pending.outcome).toBe("pending_provider_reconciliation");
    expect(pending.nextAction).toBe("reconcile_provider_operation");
    expect(reserved.proposalFingerprint).not.toBe(pending.proposalFingerprint);
  });

  test("rejects contradictory receipt state and result evidence", () => {
    expect(() => compileGitHubProviderContextReconciliationV1(input(receipt({
      state: "reserved",
    })))).toThrow("must not contain result evidence");

    expect(() => compileGitHubProviderContextReconciliationV1(input(receipt({
      state: "stale",
      operation: "github_create_issue",
      target: "teamleaderleo/stensibly#new",
      verification: {
        state: "failed",
        checkedAt: "2026-08-02T17:01:00.000Z",
        sourceRevision: issue.sourceRevision,
      },
    })))).toThrow("lacks exact current-issue readback evidence");

    expect(() => compileGitHubProviderContextReconciliationV1(input(receipt({
      verification: {
        state: "failed",
        checkedAt: "2026-08-02T17:01:00.000Z",
        sourceRevision: issue.sourceRevision,
      },
    })))).toThrow("lacks verified provider readback");
  });

  test("treats comments and rejected writes as no issue-context effect", () => {
    const comment: GitHubIssueComment = {
      id: "5159544403",
      issueNumber: 958,
      canonicalUrl:
        "https://github.com/teamleaderleo/stensibly/issues/958#issuecomment-5159544403",
      createdAt: "2026-08-02T17:01:00.000Z",
      updatedAt: "2026-08-02T17:01:00.000Z",
      sourceRevision:
        "github-rest:IC_5159544403:2026-08-02T17:01:00.000Z",
      bodyRevision: { byteLength: 12, sha256: hash("c") },
      containsBody: false,
    };
    const commentProposal = compileGitHubProviderContextReconciliationV1(input(
      receipt({
        operation: "github_add_issue_comment",
        target: "teamleaderleo/stensibly#958:comment:new",
        result: comment,
        verification: {
          state: "passed",
          checkedAt: "2026-08-02T17:01:00.000Z",
          sourceRevision: comment.sourceRevision,
        },
      }),
    ));
    const rejectedProposal = compileGitHubProviderContextReconciliationV1(input(
      receipt({
        state: "rejected",
        result: null,
        verification: { state: "not_run", checkedAt: null, sourceRevision: null },
        error: {
          code: "provider_rejected",
          message: "Provider rejected the operation",
          retry: "do_not_retry",
        },
        recovery: { nextAction: "inspect_authority_or_provider_rejection" },
      }),
    ));

    expect(commentProposal.outcome).toBe("no_issue_context_effect");
    expect(commentProposal.providerIssueExternalId).toBeNull();
    expect(commentProposal.issue).toBeNull();
    expect(rejectedProposal.outcome).toBe("no_issue_context_effect");
    expect(rejectedProposal.providerIssueExternalId).toBeNull();
  });

  test("fails closed on accepted/provider issue identity conflict", () => {
    const proposal = compileGitHubProviderContextReconciliationV1(input(
      receipt(),
      "github:teamleaderleo/stensibly#957",
      "github-rest:I_kwDOContext957:2026-08-02T17:00:00.000Z",
    ));

    expect(proposal.outcome).toBe("identity_conflict");
    expect(proposal.nextAction).toBe("inspect_issue_identity_conflict");
    expect(proposal.providerIssueExternalId).toBe(issue.reference.externalId);
    expect(proposal.issue).toBeNull();
  });

  test("requires accepted identity fields together and exact readback evidence", () => {
    expect(() => compileGitHubProviderContextReconciliationV1(input(
      receipt(),
      issue.reference.externalId,
      null,
    ))).toThrow("must be supplied together");

    expect(() => compileGitHubProviderContextReconciliationV1(input(receipt({
      verification: {
        state: "passed",
        checkedAt: "2026-08-02T17:01:00.000Z",
        sourceRevision: "github-rest:other",
      },
    })))).toThrow("does not match provider readback");

    expect(() => compileGitHubProviderContextReconciliationV1(input(receipt({
      result: null,
      verification: { state: "not_run", checkedAt: null, sourceRevision: null },
    })))).toThrow("lacks verified provider readback");
  });

  test("rejects hostile descriptors without invoking getters", () => {
    let reads = 0;
    const hostileReceipt = Object.defineProperty(receipt(), "target", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error("secret provider prose");
      },
    });

    expect(() => compileGitHubProviderContextReconciliationV1({
      version: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
      receipt: hostileReceipt,
      currentAcceptedIssueExternalId: null,
      currentAcceptedSourceRevision: null,
    })).toThrow("enumerable data fields");
    expect(reads).toBe(0);
  });

  test("produces deterministic fingerprints and immutable detached output", () => {
    const left = compileGitHubProviderContextReconciliationV1(input(receipt()));
    const right = compileGitHubProviderContextReconciliationV1(input(receipt()));

    expect(left).toEqual(right);
    expect(left.proposalFingerprint).toBe(right.proposalFingerprint);
    expect(() => {
      (left as { outcome: string }).outcome = "already_current";
    }).toThrow();
    expect(left.outcome).toBe("propose_context_acceptance");
  });
});

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
