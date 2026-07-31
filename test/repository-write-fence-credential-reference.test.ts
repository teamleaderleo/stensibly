import { describe, expect, test } from "bun:test";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteResult,
  type RepositoryWriteRefReader,
} from "../src/repository-write-fence.ts";

const parent = "a".repeat(40);
const commit = "b".repeat(40);
const slackToken = [
  "xo",
  "xb",
  "-",
  "123456789012",
  "-",
  "123456789012",
  "-",
  "abcdefghijklmnopqrstuvwx",
].join("");
const jwt = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJyZXBvc2l0b3J5LXdyaXRlIn0",
  "signature0123456789",
].join(".");

function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    repositoryFullName: "teamleaderleo/stensibly",
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

function fenceError(action: () => unknown): RepositoryWriteFenceError {
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

describe("repository write credential-reference identity", () => {
  test("rejects realistic credential references before preparing write evidence", () => {
    for (const credentialIdentity of [
      "env://WRITE_TOKEN",
      "secret://github/app-private-key",
      slackToken,
      jwt,
    ]) {
      const error = fenceError(() => prepareRepositoryWrite(
        intent(),
        authority({ authorityId: credentialIdentity }),
      ));
      expect(error).toMatchObject({
        code: "invalid_repository_write_identifier",
        disposition: "rejected",
        retry: "do_not_retry",
      });
      expect(JSON.stringify({
        message: error.message,
        evidence: error.evidence,
      })).not.toContain(credentialIdentity);
    }
  });

  test("rejects namespaced credential-shaped request IDs while retaining the commit identity", async () => {
    const prepared = prepareRepositoryWrite(intent(), authority());
    for (const credentialIdentity of [
      "request:env://WRITE_TOKEN",
      "request:secret://github/app-private-key",
      `request:${slackToken}`,
      `request:${jwt}`,
    ]) {
      let refReads = 0;
      const refs: RepositoryWriteRefReader = {
        async getRefHead() {
          refReads += 1;
          return commit;
        },
        async getCommitParents() {
          refReads += 1;
          return [parent];
        },
      };
      const error = await asyncFenceError(verifyRepositoryWriteResult({
        prepared,
        providerResult: {
          commitSha: commit,
          providerRequestId: credentialIdentity,
        },
        refs,
      }));
      expect(error).toMatchObject({
        code: "provider_write_evidence_invalid",
        disposition: "pending_reconciliation",
        retry: "reconcile_before_retry",
      });
      expect(error.evidence.returnedCommitSha).toBe(commit);
      expect(error.evidence.providerRequestId).toBeNull();
      expect(refReads).toBe(0);
      expect(JSON.stringify({
        message: error.message,
        evidence: error.evidence,
      })).not.toContain(credentialIdentity);
    }
  });

  test("keeps benign repository names containing ordinary substrings admissible", async () => {
    const prepared = prepareRepositoryWrite(
      intent({
        path: "docs/sk-research/env-reference.md",
        targetRef: "feature/sk-review",
      }),
      authority({
        targetRef: "feature/sk-review",
        authorityId: "item-sk-research",
      }),
    );
    const result = await verifyRepositoryWriteResult({
      prepared,
      providerResult: {
        commitSha: commit,
        providerRequestId: "request-secret-review-xox-handler",
      },
      refs: {
        async getRefHead() {
          return commit;
        },
        async getCommitParents() {
          return [parent];
        },
      },
      now: () => "2026-08-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      path: "docs/sk-research/env-reference.md",
      targetRef: "feature/sk-review",
      authorityId: "item-sk-research",
      providerRequestId: "request-secret-review-xox-handler",
      commitSha: commit,
      authorizesRetry: false,
    });
  });
});
