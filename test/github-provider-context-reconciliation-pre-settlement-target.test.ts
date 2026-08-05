import { describe, expect, test } from "bun:test";
import type {
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const repositoryFullName = "teamleaderleo/stensibly";

type UnsettledReceiptKind =
  | "reserved"
  | "interrupted"
  | "ambiguous"
  | "rejected";

describe("GitHub provider context reconciliation pre-settlement target admission", () => {
  test("rejects malformed operation targets before unsettled outcome classification", () => {
    const cases: Array<{
      operation: GitHubIssueProviderOperation;
      target: string;
      kind: UnsettledReceiptKind;
    }> = [
      {
        operation: "github_create_issue",
        target: `${repositoryFullName}#958`,
        kind: "reserved",
      },
      {
        operation: "github_update_issue",
        target: "other/repository#958",
        kind: "interrupted",
      },
      {
        operation: "github_update_issue",
        target: `${repositoryFullName}#new`,
        kind: "ambiguous",
      },
      {
        operation: "github_add_issue_labels",
        target: `${repositoryFullName}#958`,
        kind: "ambiguous",
      },
      {
        operation: "github_remove_issue_assignees",
        target: `${repositoryFullName}#01:assignees`,
        kind: "rejected",
      },
      {
        operation: "github_add_issue_comment",
        target: `${repositoryFullName}#0:comment:new`,
        kind: "reserved",
      },
      {
        operation: "github_update_issue",
        target: `${repositoryFullName}#958:labels`,
        kind: "rejected",
      },
      {
        operation: "github_remove_issue_label",
        target: `${repositoryFullName}#2147483648:labels`,
        kind: "interrupted",
      },
    ];

    for (const candidate of cases) {
      expect(() => compile(receipt(candidate))).toThrow(
        "GitHub provider receipt target is invalid for its operation",
      );
    }
  });

  test("preserves canonical targets for every unsettled operation family", () => {
    const cases: Array<{
      operation: GitHubIssueProviderOperation;
      target: string;
      kind: UnsettledReceiptKind;
      outcome:
        | "await_provider_result"
        | "pending_provider_reconciliation"
        | "no_issue_context_effect";
    }> = [
      {
        operation: "github_create_issue",
        target: `${repositoryFullName}#new`,
        kind: "reserved",
        outcome: "await_provider_result",
      },
      {
        operation: "github_update_issue",
        target: `${repositoryFullName}#958`,
        kind: "interrupted",
        outcome: "pending_provider_reconciliation",
      },
      {
        operation: "github_add_issue_labels",
        target: `${repositoryFullName}#958:labels`,
        kind: "ambiguous",
        outcome: "pending_provider_reconciliation",
      },
      {
        operation: "github_remove_issue_assignees",
        target: `${repositoryFullName}#958:assignees`,
        kind: "rejected",
        outcome: "no_issue_context_effect",
      },
      {
        operation: "github_add_issue_comment",
        target: `${repositoryFullName}#958:comment:new`,
        kind: "reserved",
        outcome: "await_provider_result",
      },
    ];

    for (const candidate of cases) {
      expect(compile(receipt(candidate))).toMatchObject({
        operation: candidate.operation,
        outcome: candidate.outcome,
        externalId: null,
        providerSnapshot: null,
      });
    }
  });
});

function compile(receiptValue: GitHubProviderReceipt) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receiptValue,
    current: null,
  });
}

function receipt(input: {
  operation: GitHubIssueProviderOperation;
  target: string;
  kind: UnsettledReceiptKind;
}): GitHubProviderReceipt {
  const common = {
    version: 1 as const,
    id: `ghop_pre_settlement_${input.kind}_${input.operation}`,
    project: "stensibly",
    provider: "github" as const,
    repositoryFullName,
    operation: input.operation,
    target: input.target,
    actorId: "actor_loom",
    clientId: "client_github_only",
    connectionId: "ghconn_pre_settlement",
    installationId: "installation_pre_settlement",
    bindingId: "ghbind_pre_settlement",
    attachmentId: "attachment_pre_settlement",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey:
      `pre-settlement-${input.kind}-${input.operation}`,
    parametersSha256: hash("b"),
    attemptCount: 1,
    createdAt: "2026-08-03T08:05:00.000Z",
    updatedAt: "2026-08-03T08:05:01.000Z",
    providerRequestId: null,
    result: null,
  };

  switch (input.kind) {
    case "reserved":
      return {
        ...common,
        state: "reserved",
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
        error: null,
        recovery: { nextAction: "none" },
      };
    case "interrupted":
      return {
        ...common,
        state: "pending_reconciliation",
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
        error: {
          code: "provider_dispatch_in_progress_or_interrupted",
          message: "Provider dispatch may have started before interruption",
          retry: "reconcile_before_retry",
        },
        recovery: { nextAction: "reconcile_exact_operation" },
      };
    case "ambiguous":
      return {
        ...common,
        state: "pending_reconciliation",
        verification: {
          state: "failed",
          checkedAt: "2026-08-03T08:05:01.000Z",
          sourceRevision: null,
        },
        error: {
          code: "ambiguous_provider_outcome",
          message: "Provider outcome requires reconciliation",
          retry: "reconcile_before_retry",
        },
        recovery: { nextAction: "reconcile_exact_operation" },
      };
    case "rejected":
      return {
        ...common,
        state: "rejected",
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
        error: {
          code: "provider_rejected",
          message: "Provider rejected the requested operation",
          retry: "do_not_retry",
        },
        recovery: {
          nextAction: "inspect_authority_or_provider_rejection",
        },
      };
  }
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
