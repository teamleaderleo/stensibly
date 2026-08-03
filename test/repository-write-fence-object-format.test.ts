import { describe, expect, test } from "bun:test";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type RepositoryWriteRefReader,
} from "../src/repository-write-fence.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const parent40 = "a".repeat(40);
const commit64 = "b".repeat(64);
const parent64 = "c".repeat(64);
const coherentCommit64 = "d".repeat(64);

describe("repository write fence object-format coherence", () => {
  test("rejects a SHA-256 commit over a SHA-1 parent before provider-state reads", async () => {
    let reads = 0;
    const error = await captureFenceError(verifyRepositoryWriteResult({
      prepared: prepared(parent40),
      providerResult: {
        commitSha: commit64,
        parentSha: parent40,
        targetRef: "topic/object-format",
      },
      refs: {
        async getRefHead() {
          reads += 1;
          return commit64;
        },
        async getCommitParents() {
          reads += 1;
          return [parent40];
        },
      },
    }));

    expect(error).toMatchObject({
      code: "provider_write_evidence_invalid",
      disposition: "pending_reconciliation",
      retry: "reconcile_before_retry",
    });
    expect(reads).toBe(0);
  });

  test("preserves one coherent SHA-256 repository format", async () => {
    const reads: string[] = [];
    const refs: RepositoryWriteRefReader = {
      async getRefHead(input) {
        reads.push(`ref:${input.repositoryFullName}:${input.targetRef}`);
        return coherentCommit64;
      },
      async getCommitParents(input) {
        reads.push(`commit:${input.repositoryFullName}:${input.commitSha}`);
        return [parent64];
      },
    };

    await expect(verifyRepositoryWriteResult({
      prepared: prepared(parent64),
      providerResult: {
        commitSha: coherentCommit64,
        parentSha: parent64,
        targetRef: "topic/object-format",
      },
      refs,
      now: () => "2026-08-03T20:55:00.000Z",
    })).resolves.toMatchObject({
      state: "verified",
      expectedParentSha: parent64,
      commitSha: coherentCommit64,
      nextExpectedParentSha: coherentCommit64,
      targetRef: "topic/object-format",
      verifiedAt: "2026-08-03T20:55:00.000Z",
      authorizesRetry: false,
    });
    expect(reads).toEqual([
      `ref:${repositoryFullName}:topic/object-format`,
      `commit:${repositoryFullName}:${coherentCommit64}`,
    ]);
  });
});

function prepared(expectedParentSha: string) {
  return prepareRepositoryWrite({
    version: 1,
    repositoryFullName,
    path: "docs/object-format.txt",
    operation: "create_file",
    targetRef: "topic/object-format",
    expectedParentSha,
  }, {
    version: 1,
    repositoryFullName,
    targetRef: "topic/object-format",
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
