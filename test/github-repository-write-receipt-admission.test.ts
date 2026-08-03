import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
  fingerprintGitHubRepositoryWriteReceipt,
  parseGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-receipt-admission.ts";

describe("GitHub repository write receipt admission", () => {
  test("canonicalizes one valid reserved and verified receipt", () => {
    const reserved = admitGitHubRepositoryWriteReceipt(receipt());
    expect(parseGitHubRepositoryWriteReceiptJson(
      canonicalGitHubRepositoryWriteReceiptJson(reserved),
    )).toEqual(reserved);
    expect(fingerprintGitHubRepositoryWriteReceipt(reserved)).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );

    const succeeded = admitGitHubRepositoryWriteReceipt(receipt({
      state: "succeeded",
      dispatchCount: 1,
      updatedAt: "2026-08-03T10:00:05.000Z",
      verified: verification(),
    }));
    expect(succeeded.verified?.nextExpectedParentSha).toBe(
      succeeded.verified?.commitSha,
    );
    expect(Object.isFrozen(succeeded)).toBe(true);
    expect(Object.isFrozen(succeeded.verified)).toBe(true);
  });

  test("rejects negative-zero dispatch identity", () => {
    expect(() => admitGitHubRepositoryWriteReceipt(receipt({
      dispatchCount: -0,
    }))).toThrow("receipt is invalid");
  });

  test("rejects hostile accessors without invoking them", () => {
    let getterCalls = 0;
    const hostile = receipt();
    Object.defineProperty(hostile, "actorId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "actor_substituted";
      },
    });
    expect(() => admitGitHubRepositoryWriteReceipt(hostile)).toThrow(
      "receipt is invalid",
    );
    expect(getterCalls).toBe(0);
  });

  test("rejects extra fields and credential-shaped identities", () => {
    expect(() => admitGitHubRepositoryWriteReceipt({
      ...receipt(),
      extra: true,
    })).toThrow("receipt is invalid");
    expect(() => admitGitHubRepositoryWriteReceipt(receipt({
      actorId: `github_pat_${"a".repeat(24)}`,
    }))).toThrow("receipt is invalid");
  });

  test("rejects verified evidence that does not bind to the receipt", () => {
    expect(() => admitGitHubRepositoryWriteReceipt(receipt({
      state: "succeeded",
      dispatchCount: 1,
      updatedAt: "2026-08-03T10:00:05.000Z",
      verified: {
        ...verification(),
        path: "docs/another-path.md",
      },
    }))).toThrow("receipt is invalid");
    expect(() => admitGitHubRepositoryWriteReceipt(receipt({
      state: "succeeded",
      dispatchCount: 1,
      updatedAt: "2026-08-03T10:00:05.000Z",
      verified: {
        ...verification(),
        nextExpectedParentSha: "e".repeat(40),
      },
    }))).toThrow("receipt is invalid");
  });

  test("rejects impossible lifecycle combinations", () => {
    expect(() => admitGitHubRepositoryWriteReceipt(receipt({
      state: "reserved",
      error: {
        code: "unexpected_error",
        retry: "do_not_retry",
      },
    }))).toThrow("receipt is invalid");
    expect(() => admitGitHubRepositoryWriteReceipt(receipt({
      state: "verified_pending_release",
      dispatchCount: 0,
      updatedAt: "2026-08-03T10:00:05.000Z",
      verified: verification(),
      error: {
        code: "repository_write_settlement_incomplete",
        retry: "reconcile_before_retry",
      },
    }))).toThrow("receipt is invalid");
  });
});

function receipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id: "ghrw_receipt_1",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/repository-write",
    path: "docs/provider-write.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: `sha256:${"b".repeat(64)}`,
    payloadSha256: `sha256:${"c".repeat(64)}`,
    actorId: "actor_juniper",
    clientId: "client_github_only",
    idempotencyKey: "repository-write-1",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    verified: null,
    error: null,
    ...overrides,
  };
}

function verification(): Record<string, unknown> {
  return {
    version: 1,
    state: "verified",
    repositoryFullName: "teamleaderleo/stensibly",
    path: "docs/provider-write.md",
    operation: "create_file",
    targetRef: "feature/repository-write",
    defaultBranch: "main",
    expectedParentSha: "a".repeat(40),
    authorityId: "grant_repository_write",
    authorityGeneration: 1,
    defaultBranchApprovalId: null,
    commitSha: "d".repeat(40),
    nextExpectedParentSha: "d".repeat(40),
    providerRequestId: "REQ-REPOSITORY-WRITE",
    requestSha256: `sha256:${"b".repeat(64)}`,
    verifiedAt: "2026-08-03T10:00:03.000Z",
    authorizesRetry: false,
  };
}
