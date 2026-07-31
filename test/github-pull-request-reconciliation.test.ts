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
const changedHeadSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const observationUpdatedAt = "2026-08-01T00:05:00.000Z";
const receivedAt = "2026-08-01T00:06:00.000Z";
const reconciledAt = "2026-08-01T00:10:00.000Z";
const clock = () => new Date(reconciledAt);

describe("GitHub pull request reconciliation", () => {
  test("matches identical admitted webhook and delegated-read state", () => {
    const result = compile({
      observation: observation(),
      providerRead: providerRead(),
    });

    expect(result).toMatchObject({
      version: GITHUB_PULL_REQUEST_RECONCILIATION_V1,
      repository,
      pullRequestNumber,
      state: "matched",
      reason: "states_match",
      providerBindingId: "ghbind_reconciliation_42",
      providerRequestId: "PRINFO:42",
      observationUpdatedAt,
      providerUpdatedAt: observationUpdatedAt,
      reconciledAt,
      authorizesMutation: false,
      authorizesProviderWrite: false,
    });
    expect(result.observationId).toBe("github:pull_request:delivery-pr-42");
    expect(result.observationStateFingerprint)
      .toBe(result.providerStateFingerprint);
    expect(result.reconciliationFingerprint)
      .toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Reconcile this pull request");
    expect(serialized).not.toContain("private body");
  });

  test("reports provider_ahead when a newer provider read changed state", () => {
    const result = compile({
      observation: observation(),
      providerRead: providerRead({
        headSha: changedHeadSha,
        updatedAt: "2026-08-01T00:07:00.000Z",
      }),
    });

    expect(result).toMatchObject({
      state: "provider_ahead",
      reason: "provider_newer",
    });
  });

  test("reports observation_ahead when newer webhook evidence changed state", () => {
    const result = compile({
      observation: observation({
        headSha: changedHeadSha,
        updatedAt: "2026-08-01T00:08:00.000Z",
        receivedAt: "2026-08-01T00:09:00.000Z",
      }),
      providerRead: providerRead({
        updatedAt: "2026-08-01T00:07:00.000Z",
      }),
    });

    expect(result).toMatchObject({
      state: "observation_ahead",
      reason: "observation_newer",
    });
  });

  test("reports conflict for divergent state at the same provider time", () => {
    const result = compile({
      observation: observation({ headSha: changedHeadSha }),
      providerRead: providerRead(),
    });

    expect(result).toMatchObject({
      state: "conflicted",
      reason: "same_time_divergence",
    });
  });

  test("reports missing_observation while retaining exact provider receipt identity", () => {
    const result = compile({
      observation: null,
      providerRead: providerRead(),
    });

    expect(result).toMatchObject({
      state: "missing_observation",
      reason: "observation_missing",
      observationId: null,
      observationFingerprint: null,
      observationStateFingerprint: null,
      providerBindingId: "ghbind_reconciliation_42",
      providerParametersSha256: sha256(
        stableJson({ pr_number: pullRequestNumber }),
      ),
    });
  });

  test("returns invalid_evidence when admitted source identities disagree", () => {
    const receipt = providerRead();
    const result = compile({
      observation: observation(),
      providerRead: {
        ...receipt,
        repositoryFullName: "teamleaderleo/another-repository",
      },
    });

    expect(result).toMatchObject({
      state: "invalid_evidence",
      reason: "identity_mismatch",
      repository,
      pullRequestNumber,
      authorizesMutation: false,
      authorizesProviderWrite: false,
    });
  });

  test("requires exact normalized repository identity", () => {
    expect(() => compileGitHubPullRequestReconciliationV1({
      version: GITHUB_PULL_REQUEST_RECONCILIATION_V1,
      repository: "TeamLeaderLeo/Stensibly",
      pullRequestNumber,
      observation: observation(),
      providerRead: providerRead(),
      reconciledAt,
    }, clock)).toThrow("repository is invalid");
  });

  test("produces a deterministic fingerprint from admitted evidence", () => {
    const input = {
      observation: observation(),
      providerRead: providerRead(),
    };
    const first = compile(input);
    const second = compile(input);

    expect(second).toEqual(first);
    expect(second.reconciliationFingerprint)
      .toBe(first.reconciliationFingerprint);
  });

  test("rejects changed delegated result bytes under the original fingerprint", () => {
    const receipt = providerRead();
    expect(() => compile({
      observation: observation(),
      providerRead: {
        ...receipt,
        result: {
          ...(receipt.result as Record<string, unknown>),
          headSha: changedHeadSha,
        },
      },
    })).toThrow("result fingerprint is invalid");
  });

  test("rejects changed observation bytes under the original semantic fingerprint", () => {
    const admitted = observation();
    expect(() => compile({
      observation: {
        ...admitted,
        facts: {
          ...admitted.facts,
          draft: true,
        },
      },
      providerRead: providerRead(),
    })).toThrow();
  });

  test("rejects evidence observed after the trusted reconciliation time", () => {
    expect(() => compile({
      observation: observation({
        updatedAt: "2026-08-01T00:11:00.000Z",
        receivedAt: "2026-08-01T00:12:00.000Z",
      }),
      providerRead: providerRead(),
    })).toThrow("evidence follows the reconciliation time");
  });

  test("rejects accessors and unknown input fields without reading them", () => {
    let reads = 0;
    const hostile = {
      version: GITHUB_PULL_REQUEST_RECONCILIATION_V1,
      repository,
      pullRequestNumber,
      observation: observation(),
      providerRead: providerRead(),
      reconciledAt,
      get extra() {
        reads += 1;
        return "secret";
      },
    };

    expect(() => compileGitHubPullRequestReconciliationV1(hostile, clock))
      .toThrow("unknown fields");
    expect(reads).toBe(0);
  });

  test("requires the trusted clock to attest the exact reconciliation time", () => {
    expect(() => compileGitHubPullRequestReconciliationV1({
      version: GITHUB_PULL_REQUEST_RECONCILIATION_V1,
      repository,
      pullRequestNumber,
      observation: observation(),
      providerRead: providerRead(),
      reconciledAt,
    }, () => new Date("2026-08-01T00:10:01.000Z")))
      .toThrow("trusted clock");
  });

  test("rejects credential-shaped retained provider identities", () => {
    const cases = [
      { field: "bindingId" as const, value: `github_pat_${"A".repeat(82)}` },
      { field: "providerRequestId" as const, value: `ghp_${"A".repeat(36)}` },
    ];
    for (const { field, value } of cases) {
      const receipt = providerRead();
      expect(() => compile({
        observation: observation(),
        providerRead: { ...receipt, [field]: value },
      })).toThrow();
    }

    const benign = providerRead();
    const result = compile({
      observation: observation(),
      providerRead: {
        ...benign,
        bindingId: "task-sk-review",
        providerRequestId: "PRINFO:sk-review",
      },
    });
    expect(result.providerBindingId).toBe("task-sk-review");
    expect(result.providerRequestId).toBe("PRINFO:sk-review");
  });

  test("rejects provider source evidence after the trusted reconciliation time", () => {
    expect(() => compile({
      observation: observation({
        updatedAt: "2026-08-01T00:11:00.000Z",
        receivedAt: "2026-08-01T00:09:00.000Z",
      }),
      providerRead: providerRead({
        updatedAt: "2026-08-01T00:07:00.000Z",
      }),
    })).toThrow("evidence follows the reconciliation time");
  });

});

function compile(input: {
  observation: GitHubRepositoryObservation | null;
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
  repository?: string;
  headSha?: string;
  baseSha?: string;
  mergeCommitSha?: string | null;
  state?: "open" | "closed";
  draft?: boolean;
  locked?: boolean;
  merged?: boolean;
  updatedAt?: string;
  receivedAt?: string;
} = {}): GitHubRepositoryObservation {
  const repositoryFullName = overrides.repository ?? repository;
  const updatedAt = overrides.updatedAt ?? observationUpdatedAt;
  const receiptTime = overrides.receivedAt ?? receivedAt;
  const payload = {
    action: "synchronize",
    number: pullRequestNumber,
    repository: { full_name: repositoryFullName },
    sender: { login: "teamleaderleo" },
    pull_request: {
      number: pullRequestNumber,
      state: overrides.state ?? "open",
      draft: overrides.draft ?? false,
      locked: overrides.locked ?? false,
      merged: overrides.merged ?? false,
      title: "Reconcile this pull request",
      body: "private body",
      updated_at: updatedAt,
      merge_commit_sha: overrides.mergeCommitSha ?? null,
      head: { sha: overrides.headSha ?? headSha },
      base: { sha: overrides.baseSha ?? baseSha },
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const mapped = mapGitHubRepositoryWebhook({
    eventType: "pull_request",
    deliveryId: "delivery-pr-42",
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt: receiptTime,
    expectedRepository: repositoryFullName,
  });
  if (!mapped) throw new Error("pull request observation was not mapped");
  return mapped;
}

function providerRead(overrides: {
  receiptRepository?: string;
  resultRepository?: string;
  number?: number;
  headSha?: string;
  baseSha?: string;
  mergeCommitSha?: string | null;
  state?: "open" | "closed";
  draft?: boolean;
  locked?: boolean;
  merged?: boolean;
  updatedAt?: string;
} = {}): GitHubDelegatedReadReceipt {
  const state = overrides.state ?? "open";
  const merged = overrides.merged ?? false;
  const updatedAt = overrides.updatedAt ?? observationUpdatedAt;
  const closedAt = state === "closed" ? updatedAt : null;
  const mergedAt = merged ? updatedAt : null;
  const result = {
    repositoryFullName: overrides.resultRepository ?? repository,
    number: overrides.number ?? pullRequestNumber,
    id: 987654,
    nodeId: "PR_kwDOGitHub",
    state,
    draft: overrides.draft ?? false,
    locked: overrides.locked ?? false,
    merged,
    title: "Reconcile this pull request",
    authorLogin: "teamleaderleo",
    headRepositoryFullName: repository,
    headSha: overrides.headSha ?? headSha,
    headRef: "kestrel/591-pr-reconciliation",
    baseSha: overrides.baseSha ?? baseSha,
    baseRef: "main",
    mergeCommitSha: overrides.mergeCommitSha ?? null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    closedAt,
    mergedAt,
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
    repositoryFullName: overrides.receiptRepository ?? repository,
    tool: "get_pr_info",
    actorId: "api-token:kestrel",
    clientId: "chatgpt:kestrel",
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
