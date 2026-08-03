import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-receipt-admission.ts";
import type {
  GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service.ts";

describe("repository write receipt embedded credential admission", () => {
  test("rejects realistic credential families anywhere in retained receipt text", () => {
    const github = `github_pat_${"a".repeat(20)}`;
    const shortGitHub = `ghp_${"b".repeat(20)}`;
    const openAi = `sk-proj-${"c".repeat(20)}`;
    const stensibly = `stn.tok_${"d".repeat(12)}`;
    const service = `stn.svc_${"e".repeat(12)}`;
    const slack = `xoxb-${"f".repeat(16)}`;
    const bearer = `Bearer ${"g".repeat(12)}`;
    const jwt = `eyJ${"h".repeat(8)}.eyJ${"i".repeat(8)}.${"j".repeat(8)}`;

    const cases: Array<{
      secret: string;
      build: () => unknown;
    }> = [
      {
        secret: github,
        build: () => receipt({ id: `ghrwx${github}` }),
      },
      {
        secret: shortGitHub,
        build: () => receipt({ project: `projectx${shortGitHub}` }),
      },
      {
        secret: openAi,
        build: () => receipt({
          repositoryFullName: `teamleaderleo/repositoryx${openAi}`,
        }),
      },
      {
        secret: slack,
        build: () => receipt({ targetRef: `feature/${slack}` }),
      },
      {
        secret: bearer,
        build: () => receipt({ path: `docs/revisionx${bearer}.md` }),
      },
      {
        secret: stensibly,
        build: () => receipt({ actorId: `actorx${stensibly}` }),
      },
      {
        secret: service,
        build: () => receipt({ clientId: `clientx${service}` }),
      },
      {
        secret: jwt,
        build: () => receipt({ idempotencyKey: `keyx${jwt}` }),
      },
      {
        secret: "secret://github/app-private-key",
        build: () => receipt({
          path: "docs/xsecret://github/app-private-key.md",
        }),
      },
      {
        secret: "authorization:",
        build: () => receipt({
          state: "pending_reconciliation",
          dispatchCount: 1,
          updatedAt: "2026-08-03T18:00:01.000Z",
          error: {
            code: "failurexauthorization:token",
            retry: "reconcile_before_retry",
          },
        }),
      },
      {
        secret: "-----BEGIN PRIVATE KEY-----",
        build: () => receipt({
          path: "docs/x-----BEGIN PRIVATE KEY-----.md",
        }),
      },
      {
        secret: github,
        build: () => verifiedReceipt({
          authorityId: `authorityx${github}`,
        }),
      },
      {
        secret: shortGitHub,
        build: () => verifiedReceipt({
          providerRequestId: `requestx${shortGitHub}`,
        }),
      },
      {
        secret: stensibly,
        build: () => verifiedReceipt({
          defaultBranchApprovalId: `approvalx${stensibly}`,
          targetRef: "main",
          defaultBranch: "main",
        }),
      },
    ];

    for (const { secret, build } of cases) {
      let observed: unknown;
      try {
        build();
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(Error);
      expect((observed as Error).message).toBe(
        "GitHub repository write receipt is invalid",
      );
      expect((observed as Error).message).not.toContain(secret);
      expect(JSON.stringify(observed)).not.toContain(secret);
    }
  });

  test("preserves benign short token-like aliases below realistic thresholds", () => {
    const admitted = receipt({
      id: "ghrw_github_pat_review",
      project: "project_ghp_review",
      repositoryFullName: "teamleaderleo/sk-review",
      targetRef: "feature/xoxb-review",
      path: "docs/Bearer-review.md",
      actorId: "actor_stn.tok_review",
      clientId: "client_stn.svc_review",
      idempotencyKey: "key_eyJ.short.token",
    });

    expect(admitted).toMatchObject({
      id: "ghrw_github_pat_review",
      project: "project_ghp_review",
      repositoryFullName: "teamleaderleo/sk-review",
      targetRef: "feature/xoxb-review",
      path: "docs/Bearer-review.md",
      actorId: "actor_stn.tok_review",
      clientId: "client_stn.svc_review",
      idempotencyKey: "key_eyJ.short.token",
    });

    const verified = verifiedReceipt({
      authorityId: "authority_github_pat_review",
      providerRequestId: "request_ghp_review",
    });
    expect(verified.verified).toMatchObject({
      authorityId: "authority_github_pat_review",
      providerRequestId: "request_ghp_review",
    });
  });
});

function receipt(
  overrides: Partial<GitHubRepositoryWriteReceipt> = {},
): GitHubRepositoryWriteReceipt {
  return admitGitHubRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_receipt_privacy",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/receipt-privacy",
    path: "docs/receipt-privacy.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: hash("b"),
    payloadSha256: hash("c"),
    actorId: "actor_morrow",
    clientId: "client_github_only",
    idempotencyKey: "repository-write-receipt-privacy",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T18:00:00.000Z",
    updatedAt: "2026-08-03T18:00:00.000Z",
    verified: null,
    error: null,
    ...overrides,
  });
}

function verifiedReceipt(
  verifiedOverrides: Partial<
    NonNullable<GitHubRepositoryWriteReceipt["verified"]>
  > = {},
): GitHubRepositoryWriteReceipt {
  const targetRef = verifiedOverrides.targetRef ?? "feature/receipt-privacy";
  const defaultBranch = verifiedOverrides.defaultBranch ?? "main";
  const approvalId = verifiedOverrides.defaultBranchApprovalId
    ?? (targetRef === defaultBranch ? "approval_receipt_privacy" : null);
  const verifiedAt = "2026-08-03T18:00:01.000Z";
  return receipt({
    state: "verified_pending_release",
    dispatchCount: 1,
    targetRef,
    updatedAt: verifiedAt,
    verified: {
      version: 1,
      state: "verified",
      repositoryFullName: "teamleaderleo/stensibly",
      path: "docs/receipt-privacy.md",
      operation: "create_file",
      targetRef,
      defaultBranch,
      expectedParentSha: "a".repeat(40),
      authorityId: "authority_repository_write",
      authorityGeneration: 1,
      defaultBranchApprovalId: approvalId,
      commitSha: "d".repeat(40),
      nextExpectedParentSha: "d".repeat(40),
      providerRequestId: "request-repository-write",
      requestSha256: hash("b"),
      verifiedAt,
      authorizesRetry: false,
      ...verifiedOverrides,
    },
    error: {
      code: "repository_write_settlement_incomplete",
      retry: "reconcile_before_retry",
    },
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
