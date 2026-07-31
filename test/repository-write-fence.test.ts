import { describe, expect, test } from "bun:test";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type RepositoryWriteRefReader,
} from "../src/repository-write-fence.ts";

const parent = "a".repeat(40);
const commit = "b".repeat(40);
const other = "c".repeat(40);

function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    repositoryFullName: "TeamLeaderLeo/Stensibly",
    path: "docs/write-receipt.json",
    operation: "create_file",
    targetRef: "feature/exact-write",
    expectedParentSha: parent,
    ...overrides,
  };
}

function authority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/exact-write",
    defaultBranch: "main",
    authorityId: "grant_repository_write_7",
    authorityGeneration: 7,
    defaultBranchApprovalId: null,
    ...overrides,
  };
}

function prepared() {
  return prepareRepositoryWrite(intent(), authority());
}

function refs(overrides: Partial<RepositoryWriteRefReader> = {}): RepositoryWriteRefReader {
  return {
    async getRefHead() {
      return commit;
    },
    async getCommitParents() {
      return [parent];
    },
    ...overrides,
  };
}

function syncFenceError(action: () => unknown): RepositoryWriteFenceError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryWriteFenceError);
    return error as RepositoryWriteFenceError;
  }
  throw new Error("Expected RepositoryWriteFenceError");
}

async function asyncFenceError(action: Promise<unknown>): Promise<RepositoryWriteFenceError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryWriteFenceError);
    return error as RepositoryWriteFenceError;
  }
  throw new Error("Expected RepositoryWriteFenceError");
}

describe("repository write fence prerequisite", () => {
  test("binds exact caller intent to trusted authority without authorizing dispatch", () => {
    const first = prepared();
    const second = prepared();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      state: "prepared",
      repositoryFullName: "teamleaderleo/stensibly",
      path: "docs/write-receipt.json",
      operation: "create_file",
      targetRef: "feature/exact-write",
      defaultBranch: "main",
      expectedParentSha: parent,
      authorityId: "grant_repository_write_7",
      authorityGeneration: 7,
      defaultBranchApprovalId: null,
      authorizesProviderDispatch: false,
    });
    expect(first.requestSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("takes default-branch approval only from the trusted authority record", () => {
    const defaultIntent = intent({ targetRef: "main" });
    const defaultAuthority = authority({ targetRef: "main" });

    expect(syncFenceError(() => prepareRepositoryWrite(
      defaultIntent,
      defaultAuthority,
    ))).toMatchObject({
      code: "default_branch_approval_required",
      disposition: "rejected",
      retry: "do_not_retry",
    });

    expect(prepareRepositoryWrite(defaultIntent, authority({
      targetRef: "main",
      defaultBranchApprovalId: "approval_default_write_9",
    }))).toMatchObject({
      targetRef: "main",
      defaultBranchApprovalId: "approval_default_write_9",
    });

    expect(syncFenceError(() => prepareRepositoryWrite(
      intent(),
      authority({ defaultBranchApprovalId: "approval_irrelevant_1" }),
    ))).toMatchObject({ code: "irrelevant_default_branch_approval" });
  });

  test("rejects repository and target authority mismatches", () => {
    expect(syncFenceError(() => prepareRepositoryWrite(
      intent(),
      authority({ repositoryFullName: "teamleaderleo/other" }),
    ))).toMatchObject({ code: "repository_write_authority_repository_mismatch" });

    expect(syncFenceError(() => prepareRepositoryWrite(
      intent(),
      authority({ targetRef: "feature/other" }),
    ))).toMatchObject({ code: "repository_write_authority_target_mismatch" });
  });

  test("rejects caller-owned authority aliases and unknown fields", () => {
    for (const extra of [
      { branch_name: "feature/other" },
      { defaultBranch: "main" },
      { defaultBranchApprovalId: "invented" },
      { declaredTargetRef: "feature/exact-write" },
    ]) {
      expect(syncFenceError(() => prepareRepositoryWrite(
        intent(extra),
        authority(),
      ))).toMatchObject({ code: "invalid_repository_write_intent" });
    }
  });

  test("rejects accessors, hidden fields, symbols, and custom prototypes without invoking getters", () => {
    let intentGetterCalls = 0;
    const accessorIntent = intent();
    Object.defineProperty(accessorIntent, "path", {
      configurable: true,
      enumerable: true,
      get() {
        intentGetterCalls += 1;
        return "docs/other.json";
      },
    });
    expect(syncFenceError(() => prepareRepositoryWrite(
      accessorIntent,
      authority(),
    ))).toMatchObject({ code: "invalid_repository_write_intent" });
    expect(intentGetterCalls).toBe(0);

    const hiddenIntent = intent();
    Object.defineProperty(hiddenIntent, "branch_name", {
      enumerable: false,
      value: "feature/other",
    });
    expect(syncFenceError(() => prepareRepositoryWrite(
      hiddenIntent,
      authority(),
    ))).toMatchObject({ code: "invalid_repository_write_intent" });

    const symbolIntent = intent();
    Object.defineProperty(symbolIntent, Symbol("hidden"), {
      enumerable: true,
      value: "feature/other",
    });
    expect(syncFenceError(() => prepareRepositoryWrite(
      symbolIntent,
      authority(),
    ))).toMatchObject({ code: "invalid_repository_write_intent" });

    const customIntent = Object.setPrototypeOf(intent(), { inherited: true });
    expect(syncFenceError(() => prepareRepositoryWrite(
      customIntent,
      authority(),
    ))).toMatchObject({ code: "invalid_repository_write_intent" });
  });

  test("rejects padded, compatibility, and reserved target aliases", () => {
    for (const targetRef of [
      " feature/exact-write",
      "feature/exact-write ",
      "refs/heads/feature/exact-write",
      "ｆｅａｔｕｒｅ/exact-write",
      "feature//exact-write",
      "feature/.hidden",
      "feature/exact.lock",
      "@",
      "HEAD",
    ]) {
      expect(syncFenceError(() => prepareRepositoryWrite(
        intent({ targetRef }),
        authority({ targetRef }),
      ))).toMatchObject({ disposition: "rejected" });
    }
  });

  test("rejects ambiguous repository path bytes instead of rewriting them", () => {
    for (const path of [
      " docs/file.txt",
      "docs/file.txt ",
      "docs//file.txt",
      "docs/./file.txt",
      "docs/../file.txt",
      "docs\\file.txt",
      "/docs/file.txt",
      "docs/file.txt/",
    ]) {
      expect(syncFenceError(() => prepareRepositoryWrite(
        intent({ path }),
        authority(),
      ))).toMatchObject({ disposition: "rejected" });
    }
  });

  test("verifies one exact direct-child commit with one trusted clock read", async () => {
    let clockCalls = 0;
    const refReads: Array<{
      repositoryFullName: string;
      targetRef: string;
    }> = [];
    const commitReads: Array<{
      repositoryFullName: string;
      commitSha: string;
    }> = [];
    const result = await verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: {
        commitSha: commit,
        providerRequestId: "request_write_11",
        targetRef: "feature/exact-write",
        parentSha: parent,
      },
      refs: refs({
        async getRefHead(input) {
          refReads.push(input);
          return commit;
        },
        async getCommitParents(input) {
          commitReads.push(input);
          return [parent];
        },
      }),
      now: () => {
        clockCalls += 1;
        return "2026-08-01T00:00:00.000Z";
      },
    });

    expect(result).toMatchObject({
      state: "verified",
      commitSha: commit,
      nextExpectedParentSha: commit,
      providerRequestId: "request_write_11",
      verifiedAt: "2026-08-01T00:00:00.000Z",
      authorizesRetry: false,
    });
    expect(refReads).toEqual([{
      repositoryFullName: "teamleaderleo/stensibly",
      targetRef: "feature/exact-write",
    }]);
    expect(commitReads).toEqual([{
      repositoryFullName: "teamleaderleo/stensibly",
      commitSha: commit,
    }]);
    expect(clockCalls).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("rejects a merge commit even when either parent matches", async () => {
    for (const parents of [[parent, other], [other, parent]]) {
      const error = await asyncFenceError(verifyRepositoryWriteResult({
        prepared: prepared(),
        providerResult: { commitSha: commit },
        refs: refs({
          async getCommitParents() {
            return parents;
          },
        }),
      }));
      expect(error).toMatchObject({
        code: "returned_commit_is_not_exact_direct_child",
        disposition: "pending_reconciliation",
        retry: "reconcile_before_retry",
      });
      expect(error.evidence.observedParentCount).toBe("2");
    }
  });

  test("rejects accessor and decorated parent arrays without invoking entries", async () => {
    let getterCalls = 0;
    const accessorParents: string[] = [];
    Object.defineProperty(accessorParents, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return parent;
      },
    });
    accessorParents.length = 1;

    const accessorError = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs({
        async getCommitParents() {
          return accessorParents;
        },
      }),
    }));
    expect(accessorError).toMatchObject({
      code: "repository_write_verification_invalid",
      disposition: "pending_reconciliation",
    });
    expect(getterCalls).toBe(0);

    const decorated = [parent];
    Object.defineProperty(decorated, "source", {
      enumerable: true,
      value: "provider",
    });
    expect(await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs({
        async getCommitParents() {
          return decorated;
        },
      }),
    }))).toMatchObject({ code: "repository_write_verification_invalid" });
  });

  test("rejects hostile provider evidence without invoking getters or retaining secrets", async () => {
    let getterCalls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "commitSha", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return commit;
      },
    });
    const hostileError = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: hostile,
      refs: refs(),
    }));
    expect(hostileError).toMatchObject({ code: "provider_write_evidence_invalid" });
    expect(getterCalls).toBe(0);

    const secret = `github_pat_${"x".repeat(40)}`;
    const secretError = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: {
        commitSha: commit,
        providerRequestId: secret,
      },
      refs: refs(),
    }));
    expect(secretError).toMatchObject({ code: "provider_write_evidence_invalid" });
    expect(secretError.evidence.returnedCommitSha).toBe(commit);
    expect(JSON.stringify({
      message: secretError.message,
      evidence: secretError.evidence,
    })).not.toContain(secret);
    expect(Object.isFrozen(secretError.evidence)).toBe(true);
  });

  test("rejects moved refs and missing commit identities as reconciliation work", async () => {
    expect(await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs({
        async getRefHead() {
          return other;
        },
      }),
    }))).toMatchObject({
      code: "target_ref_did_not_land_on_returned_commit",
      disposition: "pending_reconciliation",
    });

    expect(await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { providerRequestId: "request_missing_commit" },
      refs: refs(),
    }))).toMatchObject({
      code: "provider_commit_identity_missing",
      disposition: "pending_reconciliation",
    });
  });

  test("rejects tampered prepared evidence before provider-state reads", async () => {
    let reads = 0;
    const tampered = {
      ...prepared(),
      path: "docs/tampered.json",
    };
    const error = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: tampered,
      providerResult: { commitSha: commit },
      refs: refs({
        async getRefHead() {
          reads += 1;
          return commit;
        },
        async getCommitParents() {
          reads += 1;
          return [parent];
        },
      }),
    }));
    expect(error).toMatchObject({
      code: "prepared_repository_write_fingerprint_mismatch",
      disposition: "rejected",
    });
    expect(reads).toBe(0);
  });

  test("uses fixed clock failures and reads the clock exactly once", async () => {
    let clockCalls = 0;
    const error = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs(),
      now: () => {
        clockCalls += 1;
        return "2026-08-01T08:00:00+08:00";
      },
    }));
    expect(error).toMatchObject({
      code: "repository_write_verification_clock_invalid",
      message: "Repository write verification clock is invalid",
      disposition: "pending_reconciliation",
    });
    expect(clockCalls).toBe(1);
  });
});
