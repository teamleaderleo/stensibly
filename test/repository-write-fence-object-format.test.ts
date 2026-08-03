import { describe, expect, test } from "bun:test";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type RepositoryWriteAuthority,
  type RepositoryWriteIntent,
} from "../src/repository-write-fence.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "feature/object-format-coherence";
const parent40 = "a".repeat(40);
const parent64 = "a".repeat(64);
const commit40 = "b".repeat(40);
const commit64 = "b".repeat(64);

function prepared(expectedParentSha: string) {
  const intent: RepositoryWriteIntent = {
    version: 1,
    repositoryFullName,
    path: "docs/object-format.md",
    operation: "update_file",
    targetRef,
    expectedParentSha,
  };
  const authority: RepositoryWriteAuthority = {
    version: 1,
    repositoryFullName,
    targetRef,
    defaultBranch: "main",
    authorityId: "grant_object_format_coherence",
    authorityGeneration: 1,
    defaultBranchApprovalId: null,
  };
  return prepareRepositoryWrite(intent, authority);
}

async function fenceError(
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

describe("repository write fence object-format coherence", () => {
  test.each([
    [parent40, commit64],
    [parent64, commit40],
  ])("rejects a %s-byte parent with a %s-byte provider commit before canonical reads", async (
    expectedParentSha,
    commitSha,
  ) => {
    let reads = 0;
    const error = await fenceError(verifyRepositoryWriteResult({
      prepared: prepared(expectedParentSha),
      providerResult: { commitSha },
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
    const result = await verifyRepositoryWriteResult({
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
      now: () => "2026-08-04T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      state: "verified",
      expectedParentSha,
      commitSha,
      nextExpectedParentSha: commitSha,
      authorizesRetry: false,
    });
  });
});
