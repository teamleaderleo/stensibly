import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const checkedAt = "2026-08-02T17:27:00.000Z";

describe("GitHub provider context reconciliation semantic admission", () => {
  test("retains coherent unsettled and rejected state meanings", () => {
    const reserved = compile(receipt({
      state: "reserved",
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      providerRequestId: null,
    }));
    const pendingInterrupted = compile(receipt({
      state: "pending_reconciliation",
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      providerRequestId: null,
      error: {
        code: "provider_dispatch_in_progress_or_interrupted",
        message:
          "GitHub provider dispatch may still be in progress or may have been interrupted",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    }));
    const pendingAmbiguous = compile(receipt({
      state: "pending_reconciliation",
      result: null,
      verification: {
        state: "failed",
        checkedAt,
        sourceRevision: null,
      },
      providerRequestId: null,
      error: {
        code: "ambiguous_provider_outcome",
        message: "GitHub provider result requires reconciliation",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    }));
    const rejected = compile(receipt({
      state: "rejected",
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: {
        code: "provider_rejected",
        message: "GitHub provider rejected the operation",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "inspect_authority_or_provider_rejection" },
    }));

    expect(reserved.outcome).toBe("await_provider_result");
    expect(pendingInterrupted.outcome).toBe("pending_provider_reconciliation");
    expect(pendingAmbiguous.outcome).toBe("pending_provider_reconciliation");
    expect(rejected.outcome).toBe("no_issue_context_effect");
  });

  test("rejects unsettled or rejected receipts that retain a provider result", () => {
    const result = issueResult();
    const contradictions: GitHubProviderReceipt[] = [
      receipt({
        state: "reserved",
        result,
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
      }),
      receipt({
        state: "pending_reconciliation",
        result,
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
        error: {
          code: "provider_dispatch_in_progress_or_interrupted",
          message:
            "GitHub provider dispatch may still be in progress or may have been interrupted",
          retry: "reconcile_before_retry",
        },
        recovery: { nextAction: "reconcile_exact_operation" },
      }),
      receipt({
        state: "pending_reconciliation",
        result,
        verification: {
          state: "failed",
          checkedAt,
          sourceRevision: null,
        },
        error: {
          code: "ambiguous_provider_outcome",
          message: "GitHub provider result requires reconciliation",
          retry: "reconcile_before_retry",
        },
        recovery: { nextAction: "reconcile_exact_operation" },
      }),
      receipt({
        state: "rejected",
        result,
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
        error: {
          code: "provider_rejected",
          message: "GitHub provider rejected the operation",
          retry: "do_not_retry",
        },
        recovery: { nextAction: "inspect_authority_or_provider_rejection" },
      }),
    ];

    for (const contradiction of contradictions) {
      expect(() => compile(contradiction)).toThrow("lifecycle is inconsistent");
    }
  });

  test("limits stale evidence to guarded issue updates", () => {
    const result = issueResult();
    for (const input of [
      {
        operation: "github_create_issue" as const,
        target: `${repositoryFullName}#new`,
      },
      {
        operation: "github_add_issue_labels" as const,
        target: `${repositoryFullName}#958:labels`,
      },
    ]) {
      expect(() => compile(receipt({
        ...input,
        state: "stale",
        result,
        verification: {
          state: "failed",
          checkedAt,
          sourceRevision: result.sourceRevision,
        },
        error: {
          code: "stale_provider_version",
          message: "GitHub issue source revision changed before dispatch",
          retry: "do_not_retry",
        },
        recovery: { nextAction: "refresh_and_retry_with_new_version" },
      }))).toThrow(
        "Stale GitHub provider receipt lifecycle is inconsistent",
      );
    }
  });

  test("rejects issue snapshots with corrupted content or snapshot fingerprints", () => {
    const corruptedContent = structuredClone(issueResult());
    corruptedContent.contentSha256 = hash("c");
    const corruptedSnapshot = structuredClone(issueResult());
    corruptedSnapshot.snapshotSha256 = hash("d");

    expect(() => compile(receiptWithResult(corruptedContent))).toThrow(
      "content fingerprint is invalid",
    );
    expect(() => compile(receiptWithResult(corruptedSnapshot))).toThrow(
      "snapshot fingerprint is invalid",
    );
  });

  test("rejects a self-consistent snapshot with credential-shaped source revision", () => {
    const result = issueResult(`sk-proj-${"a".repeat(24)}`);

    expect(() => compile(receiptWithResult(result))).toThrow(
      "GitHub provider receipt contains credential-shaped text",
    );
  });

  test("preserves a benign short token-like current source revision", () => {
    const proposal = compileGitHubProviderContextReconciliation({
      schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
      receipt: receipt(),
      current: {
        externalId: `github:${repositoryFullName}#958`,
        sourceRevision: "sk-short",
      },
    });

    expect(proposal.currentSourceRevision).toBe("sk-short");
    expect(proposal.outcome).toBe("propose_context_acceptance");
  });
});

function compile(receiptValue: GitHubProviderReceipt) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receiptValue,
    current: null,
  });
}

function receiptWithResult(result: GitHubIssueContext): GitHubProviderReceipt {
  return receipt({
    result,
    verification: {
      state: "passed",
      checkedAt,
      sourceRevision: result.sourceRevision,
    },
  });
}

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const result = issueResult();
  return {
    version: 1,
    id: "ghop_reconciliation_admission",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_cedar",
    clientId: "client_github_only",
    connectionId: "ghconn_admission",
    installationId: "installation_admission",
    bindingId: "ghbind_admission",
    attachmentId: "attachment_admission",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-context-admission",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:26:55.000Z",
    updatedAt: checkedAt,
    providerRequestId: "request-admission",
    result,
    verification: {
      state: "passed",
      checkedAt,
      sourceRevision: result.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  };
}

function issueResult(
  sourceRevision = "github-rest:I_kwDOReconcileAdmission:2026-08-02T17:27:00.000Z",
): GitHubIssueContext {
  return structuredClone(buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 958,
    title: "Provider context reconciliation admission controls",
    body: null,
    state: "open",
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    createdAt: "2026-08-02T17:26:51.000Z",
    updatedAt: checkedAt,
    providerNodeId: "I_kwDOReconcileAdmission",
    sourceRevision,
  }));
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
