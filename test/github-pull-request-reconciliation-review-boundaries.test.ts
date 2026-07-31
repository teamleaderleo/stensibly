import { describe, expect, test } from "bun:test";
import type { GitHubDelegatedReadReceipt } from "../src/github-delegated-read.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
  type GitHubRepositoryObservation,
} from "../src/github-repository-observation.ts";
import {
  compileGitHubPullRequestReconciliationV1,
  GITHUB_PULL_REQUEST_RECONCILIATION_V1,
} from "../src/github-pull-request-reconciliation.ts";
import {
  sha256,
  stableJson,
} from "../src/github-provider-validation.ts";

const repository = "teamleaderleo/stensibly";
const pullRequestNumber = 42;
const headSha = "a".repeat(40);
const baseSha = "c".repeat(40);
const reconciledAt = "2026-08-01T00:08:00.000Z";
const clock = () => new Date(reconciledAt);

describe("GitHub pull request reconciliation review boundaries", () => {
  test("rejects credential-shaped retained provider identities", () => {
    const cases = [
      {
        field: "bindingId" as const,
        value: `github_pat_${"A".repeat(82)}`,
      },
      {
        field: "providerRequestId" as const,
        value: `ghp_${"A".repeat(36)}`,
      },
    ];

    for (const { field, value } of cases) {
      const receipt = providerRead();
      expect(() => compile({
        observation: observation(),
        providerRead: {
          ...receipt,
          [field]: value,
        },
      })).toThrow();
    }
  });

  test("rejects a provider source time after the trusted reconciliation time", () => {
    expect(() => compile({
      observation: observation({
        updatedAt: "2026-08-01T00:09:00.000Z",
        receivedAt: "2026-08-01T00:06:00.000Z",
      }),
      providerRead: providerRead({
        updatedAt: "2026-08-01T00:07:00.000Z",
      }),
    })).toThrow("evidence follows the reconciliation time");
  });
});

function compile(input: {
  observation: GitHubRepositoryObservation;
  providerRead: GitHubDelegatedReadReceipt;
}) {
  return compileGitHubPullRequestReconciliationV1({
    version: GITHUB_PULL_REQUEST_RECONCILIATION_V1,
    repository,
    pullRequestNumber,
    observation: input.observation,
    providerRead: input.providerRead,
    reconciledAt,
  }, clock);
}

function observation(overrides: {
  updatedAt?: string;
  receivedAt?: string;
} = {}): GitHubRepositoryObservation {
  const updatedAt = overrides.updatedAt ?? "2026-08-01T00:05:00.000Z";
  const receivedAt = overrides.receivedAt ?? "2026-08-01T00:06:00.000Z";
  const payload = {
    action: "synchronize",
    number: pullRequestNumber,
    repository: { full_name: repository },
    sender: { login: "teamleaderleo" },
    pull_request: {
      number: pullRequestNumber,
      state: "open",
      draft: false,
      locked: false,
      merged: false,
      title: "Reconcile this pull request",
      body: "private body",
      updated_at: updatedAt,
      merge_commit_sha: null,
      head: { sha: headSha },
      base: { sha: baseSha },
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const mapped = mapGitHubRepositoryWebhook({
    eventType: "pull_request",
    deliveryId: "delivery-pr-42-review",
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
    expectedRepository: repository,
  });
  if (!mapped) throw new Error("pull request observation was not mapped");
  return mapped;
}

function providerRead(overrides: {
  updatedAt?: string;
} = {}): GitHubDelegatedReadReceipt {
  const updatedAt = overrides.updatedAt ?? "2026-08-01T00:05:00.000Z";
  const result = {
    repositoryFullName: repository,
    number: pullRequestNumber,
    id: 987654,
    nodeId: "PR_kwDOGitHubReview",
    state: "open" as const,
    draft: false,
    locked: false,
    merged: false,
    title: "Reconcile this pull request",
    authorLogin: "teamleaderleo",
    headRepositoryFullName: repository,
    headSha,
    headRef: "kestrel/591-pr-reconciliation",
    baseSha,
    baseRef: "main",
    mergeCommitSha: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
    mergedAt: null,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    commits: 1,
    reviewComments: 0,
    comments: 1,
  };
  return {
    version: 1,
    project: "stensibly",
    repositoryFullName: repository,
    tool: "get_pr_info",
    actorId: "api-token:oriole",
    clientId: "chatgpt:oriole",
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
  };
}
