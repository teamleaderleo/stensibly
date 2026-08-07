import { describe, expect, test } from "bun:test";
import type { GitHubDelegatedReadReceipt } from "../src/github-delegated-read.ts";
import {
  compileGitHubPullRequestReconciliationV1,
  GITHUB_PULL_REQUEST_RECONCILIATION_V1,
} from "../src/github-pull-request-reconciliation.ts";
import { sha256, stableJson } from "../src/github-provider-validation.ts";

const repository = "teamleaderleo/stensibly";
const pullRequestNumber = 42;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const reconciledAt = "2026-08-08T00:10:00.000Z";

function providerRead(
  overrides: Partial<GitHubDelegatedReadReceipt> = {},
): GitHubDelegatedReadReceipt {
  const result = {
    repositoryFullName: repository,
    number: pullRequestNumber,
    id: 987654,
    nodeId: "PR_kwDOGitHub",
    state: "open" as const,
    draft: false,
    locked: false,
    merged: false,
    title: "Reconcile this pull request",
    authorLogin: "teamleaderleo",
    headRepositoryFullName: repository,
    headSha,
    headRef: "tern/1184-pr-reconciliation-credential-control",
    baseSha,
    baseRef: "main",
    mergeCommitSha: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:05:00.000Z",
    closedAt: null,
    mergedAt: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commits: 1,
    reviewComments: 0,
    comments: 0,
  };
  return {
    version: 1,
    project: "stensibly",
    repositoryFullName: repository,
    tool: "get_pr_info",
    actorId: "api-token:tern",
    clientId: "chatgpt:tern",
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    bindingId: "ghbind_reconciliation_42",
    attachmentId: "attach_stensibly",
    attachmentSnapshotSha256: `sha256:${"d".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    catalogueFingerprint: `sha256:${"e".repeat(64)}`,
    parametersSha256: sha256(stableJson({ pr_number: pullRequestNumber })),
    providerRequestId: "PRINFO:42",
    resultSha256: sha256(stableJson(result)),
    result,
    ...overrides,
  };
}

function compile(receipt: GitHubDelegatedReadReceipt) {
  return compileGitHubPullRequestReconciliationV1({
    version: GITHUB_PULL_REQUEST_RECONCILIATION_V1,
    repository,
    pullRequestNumber,
    observation: null,
    providerRead: receipt,
    reconciledAt,
  }, () => new Date(reconciledAt));
}

describe("pull request reconciliation shared retained credential policy", () => {
  test("rejects realistic Stensibly provider identities at the shared 12-character threshold", () => {
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => compile(providerRead({ bindingId: serviceIdentity })))
      .toThrow();
    expect(() => compile(providerRead({ providerRequestId: tokenIdentity })))
      .toThrow();
    expect(() => compile(providerRead({ actorId: serviceIdentity })))
      .toThrow();
  });

  test("retains benign Stensibly-like aliases below the shared threshold", () => {
    const benign = `stn.tok_${"a".repeat(11)}`;
    const result = compile(providerRead({
      bindingId: benign,
      providerRequestId: benign,
    }));

    expect(result.providerBindingId).toBe(benign);
    expect(result.providerRequestId).toBe(benign);
  });
});
