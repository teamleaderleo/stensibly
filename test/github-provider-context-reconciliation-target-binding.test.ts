import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import type { GitHubIssueContext } from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const repositoryFullName = "teamleaderleo/stensibly";

describe("GitHub provider context reconciliation target binding", () => {
  test("accepts coherent create, update, label, and assignee targets", () => {
    const created = compile(receipt({
      operation: "github_create_issue",
      target: `${repositoryFullName}#new`,
      resultNumber: 958,
    }));
    const updated = compile(receipt({
      operation: "github_update_issue",
      target: `${repositoryFullName}#958`,
      resultNumber: 958,
    }));
    const labeled = compile(receipt({
      operation: "github_add_issue_labels",
      target: `${repositoryFullName}#958:labels`,
      resultNumber: 958,
    }));
    const assigned = compile(receipt({
      operation: "github_remove_issue_assignees",
      target: `${repositoryFullName}#958:assignees`,
      resultNumber: 958,
    }));

    for (const proposal of [created, updated, labeled, assigned]) {
      expect(proposal.outcome).toBe("propose_context_acceptance");
      expect(proposal.externalId).toBe(`github:${repositoryFullName}#958`);
    }
  });

  test("rejects a create receipt that does not retain the new-issue target", () => {
    expect(() => compile(receipt({
      operation: "github_create_issue",
      target: `${repositoryFullName}#958`,
      resultNumber: 958,
    }))).toThrow("target does not bind the provider result");
  });

  test("rejects same-repository issue substitution for update and set mutation", () => {
    const cases = [
      {
        operation: "github_update_issue" as const,
        target: `${repositoryFullName}#958`,
      },
      {
        operation: "github_add_issue_labels" as const,
        target: `${repositoryFullName}#958:labels`,
      },
      {
        operation: "github_remove_issue_assignees" as const,
        target: `${repositoryFullName}#958:assignees`,
      },
    ];
    for (const { operation, target } of cases) {
      expect(() => compile(receipt({
        operation,
        target,
        resultNumber: 959,
      }))).toThrow("target does not bind the provider result");
    }
  });

  test("rejects a coherent issue number with the wrong mutation suffix", () => {
    for (const input of [
      {
        operation: "github_add_issue_labels" as const,
        target: `${repositoryFullName}#958`,
      },
      {
        operation: "github_remove_issue_assignees" as const,
        target: `${repositoryFullName}#958:labels`,
      },
    ]) {
      expect(() => compile(receipt({
        ...input,
        resultNumber: 958,
      }))).toThrow("target does not bind the provider result");
    }
  });

  test("rejects stale readback from another issue before proposing acceptance", () => {
    expect(() => compile(receipt({
      operation: "github_update_issue",
      target: `${repositoryFullName}#958`,
      resultNumber: 959,
      state: "stale",
    }))).toThrow("target does not bind the provider result");
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
  operation:
    | "github_create_issue"
    | "github_update_issue"
    | "github_add_issue_labels"
    | "github_remove_issue_assignees";
  target: string;
  resultNumber: number;
  state?: "succeeded" | "stale";
}): GitHubProviderReceipt {
  const result = issueResult(input.resultNumber);
  const stale = input.state === "stale";
  return {
    version: 1,
    id: `ghop_target_${input.resultNumber}`,
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: input.operation,
    target: input.target,
    actorId: "actor_cedar",
    clientId: "client_github_only",
    connectionId: "ghconn_target",
    installationId: "installation_target",
    bindingId: "ghbind_target",
    attachmentId: "attachment_target",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: `target-binding-${input.operation}-${input.resultNumber}`,
    parametersSha256: hash("b"),
    state: stale ? "stale" : "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:26:55.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerRequestId: `request-${input.resultNumber}`,
    result,
    verification: {
      state: stale ? "failed" : "passed",
      checkedAt: "2026-08-02T17:27:00.000Z",
      sourceRevision: result.sourceRevision,
    },
    error: stale
      ? {
        code: "stale_provider_version",
        message: "GitHub issue source revision changed before the guarded update",
        retry: "do_not_retry",
      }
      : null,
    recovery: {
      nextAction: stale ? "refresh_and_retry_with_new_version" : "none",
    },
  };
}

function issueResult(number: number): GitHubIssueContext {
  const sourceRevision =
    `github-rest:I_kwDOReconcile${number}:2026-08-02T17:27:00.000Z`;
  return {
    version: 1,
    provider: "github",
    reference: {
      provider: "github",
      host: "github.com",
      owner: "teamleaderleo",
      repository: "stensibly",
      repositoryFullName,
      number,
      externalId: `github:${repositoryFullName}#${number}`,
      canonicalUrl: `https://github.com/${repositoryFullName}/issues/${number}`,
    },
    title: `Target binding control ${number}`,
    bodyRevision: {
      present: false,
      byteLength: 0,
      sha256: hash("0"),
    },
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-02T17:26:51.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerNodeId: `I_kwDOReconcile${number}`,
    sourceRevision,
    contentSha256: hash("c"),
    snapshotSha256: hash("d"),
    containsIssueBody: false,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
