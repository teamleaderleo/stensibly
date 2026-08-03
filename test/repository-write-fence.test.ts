import { describe, expect, test } from "bun:test";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type PreparedRepositoryWrite,
  type RepositoryWriteAuthority,
  type RepositoryWriteIntent,
  type RepositoryWriteRefReader,
} from "../src/repository-write-fence.ts";

const parent = "a".repeat(40);
const commit = "b".repeat(40);
const other = "c".repeat(40);

const baseIntent: RepositoryWriteIntent = {
  version: 1,
  repositoryFullName: "teamleaderleo/stensibly",
  path: "docs/parity.json",
  operation: "update_file",
  targetRef: "feature/parity",
  expectedParentSha: parent,
};

const baseAuthority: RepositoryWriteAuthority = {
  version: 1,
  repositoryFullName: "teamleaderleo/stensibly",
  targetRef: "feature/parity",
  defaultBranch: "main",
  authorityId: "grant_repository_write_7",
  authorityGeneration: 3,
  defaultBranchApprovalId: null,
};

function prepared(): PreparedRepositoryWrite {
  return prepareRepositoryWrite(baseIntent, baseAuthority);
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

function fenceError(action: () => unknown): RepositoryWriteFenceError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryWriteFenceError);
    return error as RepositoryWriteFenceError;
  }
  throw new Error("expected repository-write fence error");
}

async function asyncFenceError(
  promise: Promise<unknown>,
): Promise<RepositoryWriteFenceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryWriteFenceError);
    return error as RepositoryWriteFenceError;
  }
  throw new Error("expected repository-write fence error");
}

describe("repository write authority fence", () => {
  test("prepares exact non-default branch evidence without authorizing dispatch", () => {
    const result = prepared();
    expect(result).toMatchObject({
      state: "prepared",
      repositoryFullName: "teamleaderleo/stensibly",
      targetRef: "feature/parity",
      defaultBranch: "main",
      expectedParentSha: parent,
      authorityId: "grant_repository_write_7",
      authorityGeneration: 3,
      defaultBranchApprovalId: null,
      authorizesProviderDispatch: false,
    });
    expect(result.requestSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("requires explicit approval for the authoritative default branch", () => {
    const intent = {
      ...baseIntent,
      targetRef: "main",
    };
    const withoutApproval = {
      ...baseAuthority,
      targetRef: "main",
    };
    const error = fenceError(() => prepareRepositoryWrite(intent, withoutApproval));
    expect(error).toMatchObject({
      code: "default_branch_approval_required",
      disposition: "rejected",
      retry: "do_not_retry",
    });

    const approved = prepareRepositoryWrite(intent, {
      ...withoutApproval,
      defaultBranchApprovalId: "approval_change_42",
    });
    expect(approved.defaultBranchApprovalId).toBe("approval_change_42");
  });

  test("rejects approval evidence on a non-default target", () => {
    const error = fenceError(() => prepareRepositoryWrite(baseIntent, {
      ...baseAuthority,
      defaultBranchApprovalId: "approval_wrong_ref",
    }));
    expect(error).toMatchObject({
      code: "irrelevant_default_branch_approval",
      disposition: "rejected",
    });
  });

  test("rejects repository and target mismatches against server authority", () => {
    expect(fenceError(() => prepareRepositoryWrite(baseIntent, {
      ...baseAuthority,
      repositoryFullName: "teamleaderleo/another-repository",
    }))).toMatchObject({ code: "repository_write_authority_repository_mismatch" });
    expect(fenceError(() => prepareRepositoryWrite(baseIntent, {
      ...baseAuthority,
      targetRef: "feature/other",
    }))).toMatchObject({ code: "repository_write_authority_target_mismatch" });
  });

  test("rejects mixed-case repository aliases with the canonical fence taxonomy", () => {
    const error = fenceError(() => prepareRepositoryWrite({
      ...baseIntent,
      repositoryFullName: "TeamLeaderLeo/Stensibly",
    }, baseAuthority));
    expect(error).toMatchObject({
      code: "invalid_repository_full_name",
      disposition: "rejected",
      retry: "do_not_retry",
    });
  });

  test("rejects unknown, accessor, symbol, and credential-shaped fields", () => {
    expect(fenceError(() => prepareRepositoryWrite({
      ...baseIntent,
      extra: true,
    }, baseAuthority))).toMatchObject({ code: "invalid_repository_write_intent" });

    let getterCalls = 0;
    const accessorIntent = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(baseIntent)) {
      Object.defineProperty(accessorIntent, key, {
        enumerable: true,
        value,
      });
    }
    Object.defineProperty(accessorIntent, "path", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "docs/accessor.json";
      },
    });
    expect(fenceError(() => prepareRepositoryWrite(accessorIntent, baseAuthority))).toMatchObject({
      code: "invalid_repository_write_intent",
    });
    expect(getterCalls).toBe(0);

    expect(fenceError(() => prepareRepositoryWrite({
      ...baseIntent,
      [Symbol("hidden")]: true,
    }, baseAuthority))).toMatchObject({ code: "invalid_repository_write_intent" });

    const secret = `github_pat_${"q".repeat(40)}`;
    const error = fenceError(() => prepareRepositoryWrite(baseIntent, {
      ...baseAuthority,
      authorityId: secret,
    }));
    expect(error.code).toBe("invalid_repository_write_text");
    expect(JSON.stringify({ message: error.message, evidence: error.evidence })).not.toContain(secret);
  });
});

describe("repository write verification fence", () => {
  test("verifies one exact direct child at the target ref", async () => {
    let headCalls = 0;
    let parentCalls = 0;
    const result = await verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: {
        commitSha: commit,
        providerRequestId: "request_7",
        targetRef: "feature/parity",
        parentSha: parent,
      },
      refs: refs({
        async getRefHead(input) {
          headCalls += 1;
          expect(input).toEqual({
            repositoryFullName: "teamleaderleo/stensibly",
            targetRef: "feature/parity",
          });
          return commit;
        },
        async getCommitParents(input) {
          parentCalls += 1;
          expect(input).toEqual({
            repositoryFullName: "teamleaderleo/stensibly",
            commitSha: commit,
          });
          return [parent];
        },
      }),
      now: () => "2026-08-01T00:00:00.000Z",
    });

    expect(result).toEqual({
      version: 1,
      state: "verified",
      repositoryFullName: "teamleaderleo/stensibly",
      path: "docs/parity.json",
      operation: "update_file",
      targetRef: "feature/parity",
      defaultBranch: "main",
      expectedParentSha: parent,
      authorityId: "grant_repository_write_7",
      authorityGeneration: 3,
      defaultBranchApprovalId: null,
      commitSha: commit,
      nextExpectedParentSha: commit,
      providerRequestId: "request_7",
      requestSha256: prepared().requestSha256,
      verifiedAt: "2026-08-01T00:00:00.000Z",
      authorizesRetry: false,
    });
    expect(headCalls).toBe(1);
    expect(parentCalls).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("rejects provider ref and parent mismatches before canonical reads", async () => {
    let reads = 0;
    const reader = refs({
      async getRefHead() {
        reads += 1;
        return commit;
      },
      async getCommitParents() {
        reads += 1;
        return [parent];
      },
    });
    const refError = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: {
        commitSha: commit,
        targetRef: "feature/other",
      },
      refs: reader,
    }));
    expect(refError).toMatchObject({
      code: "provider_target_ref_mismatch",
      disposition: "pending_reconciliation",
    });
    expect(reads).toBe(0);

    const parentError = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: {
        commitSha: commit,
        parentSha: other,
      },
      refs: reader,
    }));
    expect(parentError).toMatchObject({ code: "provider_parent_mismatch" });
    expect(reads).toBe(0);
  });

  test("uses fixed reconciliation errors for unavailable or invalid verification", async () => {
    const unavailable = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs({
        async getRefHead() {
          throw new Error("provider prose and secret");
        },
      }),
    }));
    expect(unavailable).toMatchObject({
      code: "repository_write_verification_unavailable",
      disposition: "pending_reconciliation",
      retry: "reconcile_before_retry",
    });

    const invalid = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs({
        async getRefHead() {
          return "ABC";
        },
      }),
    }));
    expect(invalid).toMatchObject({
      code: "repository_write_verification_invalid",
      disposition: "pending_reconciliation",
    });
  });

  test("requires exact target head and one exact direct parent", async () => {
    const wrongHead = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs({
        async getRefHead() {
          return other;
        },
      }),
    }));
    expect(wrongHead).toMatchObject({ code: "target_ref_did_not_land_on_returned_commit" });
    expect(wrongHead.evidence.observedRefHead).toBe(other);

    const mergeCommit = await asyncFenceError(verifyRepositoryWriteResult({
      prepared: prepared(),
      providerResult: { commitSha: commit },
      refs: refs({
        async getCommitParents() {
          return [parent, other];
        },
      }),
    }));
    expect(mergeCommit).toMatchObject({ code: "returned_commit_is_not_exact_direct_child" });
    expect(mergeCommit.evidence.observedParentCount).toBe("2");
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
