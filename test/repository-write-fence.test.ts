import { describe, expect, test } from "bun:test";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type RepositoryWriteRefReader,
} from "../src/repository-write-fence.ts";

const parent = "a".repeat(40);
const commit = "b".repeat(40);

function intent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    repositoryFullName: "teamleaderleo/fieldwork",
    path: "STENSIBLY.md",
    operation: "create_file",
    declaredTargetRef: "agent/rook-repository-admission-v2",
    targetRef: "agent/rook-repository-admission-v2",
    defaultBranch: "main",
    expectedParentSha: parent,
    ...overrides,
  };
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

describe("repository write fence", () => {
  test("rejects an unknown branch_name field instead of falling back", () => {
    expect(() => prepareRepositoryWrite(intent({ branch_name: "wrong-branch" })))
      .toThrow(RepositoryWriteFenceError);
    try {
      prepareRepositoryWrite(intent({ branch_name: "wrong-branch" }));
    } catch (error) {
      expect(error).toMatchObject({
        code: "unknown_repository_write_field",
        disposition: "rejected",
        retry: "do_not_retry",
      });
    }
  });

  test("requires explicit approval for default-branch writes", () => {
    expect(() => prepareRepositoryWrite(intent({
      declaredTargetRef: "main",
      targetRef: "main",
    }))).toThrow(/explicit approval/);

    expect(prepareRepositoryWrite(intent({
      declaredTargetRef: "main",
      targetRef: "main",
      defaultBranchApprovalId: "approval_default_branch_1",
    }))).toMatchObject({ targetRef: "main" });
  });

  test("requires authority fallback when the target ref changes", () => {
    expect(() => prepareRepositoryWrite(intent({ targetRef: "other-branch" })))
      .toThrow(/differs from declared target ref/);
  });

  test("verifies the returned commit is the target-ref head and direct child", async () => {
    const prepared = prepareRepositoryWrite(intent());
    const verified = await verifyRepositoryWriteResult({
      prepared,
      providerResult: {
        commitSha: commit,
        providerRequestId: "request-1",
        targetRef: "refs/heads/agent/rook-repository-admission-v2",
        parentSha: parent,
      },
      refs: refs(),
      now: () => "2026-07-31T01:20:00+08:00",
    });

    expect(verified).toMatchObject({
      state: "verified",
      commitSha: commit,
      nextExpectedParentSha: commit,
      providerRequestId: "request-1",
      verifiedAt: "2026-07-30T17:20:00.000Z",
    });
  });

  test("forces reconciliation when the write lands on another ref head", async () => {
    const prepared = prepareRepositoryWrite(intent());
    await expect(verifyRepositoryWriteResult({
      prepared,
      providerResult: { commitSha: commit },
      refs: refs({
        async getRefHead() {
          return "c".repeat(40);
        },
      }),
    })).rejects.toMatchObject({
      code: "target_ref_did_not_land_on_returned_commit",
      disposition: "pending_reconciliation",
      retry: "reconcile_before_retry",
    });
  });

  test("forces reconciliation when the returned commit has another parent", async () => {
    const prepared = prepareRepositoryWrite(intent());
    await expect(verifyRepositoryWriteResult({
      prepared,
      providerResult: { commitSha: commit },
      refs: refs({
        async getCommitParents() {
          return ["d".repeat(40)];
        },
      }),
    })).rejects.toMatchObject({
      code: "returned_commit_does_not_descend_from_expected_parent",
      disposition: "pending_reconciliation",
    });
  });

  test("forces reconciliation when the connector omits commit identity", async () => {
    const prepared = prepareRepositoryWrite(intent());
    await expect(verifyRepositoryWriteResult({
      prepared,
      providerResult: { providerRequestId: "request-ambiguous" },
      refs: refs(),
    })).rejects.toMatchObject({
      code: "provider_commit_identity_missing",
      disposition: "pending_reconciliation",
    });
  });
});
