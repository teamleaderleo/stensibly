import { describe, expect, test } from "bun:test";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
} from "../src/repository-write-fence.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/object-format";
const parent40 = "a".repeat(40);
const parent64 = "a".repeat(64);
const commit40 = "b".repeat(40);
const commit64 = "b".repeat(64);

describe("repository write fence object-format coherence", () => {
  test.each([
    [parent40, commit64],
    [parent64, commit40],
  ])("rejects mixed-width provider evidence before canonical reads", async (
    expectedParentSha,
    commitSha,
  ) => {
    let reads = 0;
    const error = await captureFenceError(verifyRepositoryWriteResult({
      prepared: prepared(expectedParentSha),
      providerResult: {
        commitSha,
        parentSha: expectedParentSha,
        targetRef,
      },
      refs: {
        async getRefHead() {
          reads += 1;
          return commitSha;
        },
        async getCommitParents() {
          reads += 1;
          return [expectedParentSha];
        },
      },
    }));

    expect(error).toMatchObject({
      code: "provider_write_evidence_invalid",
      disposition: "pending_reconciliation",
      retry: "reconcile_before_retry",
    });
    expect(error.evidence.expectedParentSha).toBe(expectedParentSha);
    expect(error.evidence.returnedCommitSha).toBe(commitSha);
    expect(reads).toBe(0);
  });

  test.each([
    [parent40, commit40],
    [parent64, commit64],
  ])("preserves coherent repository object formats", async (
    expectedParentSha,
    commitSha,
  ) => {
    await expect(verifyRepositoryWriteResult({
      prepared: prepared(expectedParentSha),
      providerResult: {
        commitSha,
        parentSha: expectedParentSha,
        targetRef,
      },
      refs: {
        async getRefHead() {
          return commitSha;
        },
        async getCommitParents() {
          return [expectedParentSha];
        },
      },
      now: () => "2026-08-03T20:55:00.000Z",
    })).resolves.toMatchObject({
      state: "verified",
      expectedParentSha,
      commitSha,
      nextExpectedParentSha: commitSha,
      targetRef,
      verifiedAt: "2026-08-03T20:55:00.000Z",
      authorizesRetry: false,
    });
  });

  test("rejects mixed-case repository aliases with the fence taxonomy", () => {
    let thrown: unknown;
    try {
      prepareRepositoryWrite({
        version: 1,
        repositoryFullName: "TeamLeaderLeo/Stensibly",
        path: "docs/object-format.txt",
        operation: "create_file",
        targetRef,
        expectedParentSha: parent40,
      }, {
        version: 1,
        repositoryFullName,
        targetRef,
        defaultBranch: "main",
        authorityId: "authority_object_format",
        authorityGeneration: 1,
        defaultBranchApprovalId: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RepositoryWriteFenceError);
    expect(thrown).toMatchObject({
      code: "invalid_repository_full_name",
      disposition: "rejected",
      retry: "do_not_retry",
    });
  });
});

function prepared(expectedParentSha: string) {
  return prepareRepositoryWrite({
    version: 1,
    repositoryFullName,
    path: "docs/object-format.txt",
    operation: "create_file",
    targetRef,
    expectedParentSha,
  }, {
    version: 1,
    repositoryFullName,
    targetRef,
    defaultBranch: "main",
    authorityId: "authority_object_format",
    authorityGeneration: 1,
    defaultBranchApprovalId: null,
  });
}

async function captureFenceError(
  operation: Promise<unknown>,
): Promise<RepositoryWriteFenceError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryWriteFenceError);
    return error as RepositoryWriteFenceError;
  }
  throw new Error("Expected repository write fence rejection");
}
