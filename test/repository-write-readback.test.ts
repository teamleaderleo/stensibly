import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  prepareRepositoryWrite,
  RepositoryWriteFenceError,
  verifyRepositoryWriteReadback,
  type PreparedRepositoryWrite,
  type RepositoryWriteCommitTreeSnapshot,
  type RepositoryWriteReadbackReader,
  type RepositoryWriteTreeEntry,
} from "../src/repository-write-fence.ts";

const repository = "teamleaderleo/stensibly";
const branch = "keel/exact-readback";
const path = "docs/exact-readback.md";
const parent = "a".repeat(40);
const candidate = "b".repeat(40);
const parentTree = "c".repeat(40);
const candidateTree = "d".repeat(40);
const otherBlob = "e".repeat(40);
const message = "Prove exact repository write";

describe("repository write exact tree readback", () => {
  test("proves an exact create from complete parent and candidate leaf sets", async () => {
    const content = "exact readback\n";
    const prepared = preparedWrite("create_file");
    const result = await verifyRepositoryWriteReadback({
      prepared,
      payload: { operation: "create_file", content, message },
      refs: reader(
        snapshot(parent, [], parentTree, [otherEntry()]),
        snapshot(candidate, [parent], candidateTree, [
          otherEntry(),
          entry(path, "100644", blobSha(content)),
        ], message),
      ),
      now: () => "2026-08-11T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      state: "verified",
      commitSha: candidate,
      expectedParentSha: parent,
      providerRequestId: null,
      verifiedAt: "2026-08-11T00:00:00.000Z",
      authorizesRetry: false,
    });
  });

  test("proves an exact update while preserving the executable bit", async () => {
    const before = blobSha("before\n");
    const content = "after\n";
    const result = await verifyRepositoryWriteReadback({
      prepared: preparedWrite("update_file"),
      payload: {
        operation: "update_file",
        contentSha: before,
        content,
        message,
      },
      refs: reader(
        snapshot(parent, [], parentTree, [entry(path, "100755", before)]),
        snapshot(candidate, [parent], candidateTree, [
          entry(path, "100755", blobSha(content)),
        ], message),
      ),
    });

    expect(result.commitSha).toBe(candidate);
  });

  test("keeps absent, unchanged, and malformed canonical state pending", async () => {
    const prepared = preparedWrite("create_file");
    const payload = { operation: "create_file", content: "safe\n", message } as const;
    for (const refs of [
      reader(null, null, null),
      reader(null, null, parent),
      reader(
        snapshot(parent, [], parentTree, []),
        { ...snapshot(candidate, [parent], candidateTree, [], message), extra: true },
      ),
    ]) {
      const error = await fenceError(verifyRepositoryWriteReadback({
        prepared,
        payload,
        refs,
      }));
      expect(error).toMatchObject({
        disposition: "pending_reconciliation",
        retry: "reconcile_before_retry",
      });
    }
  });

  test("rejects every plausible but non-exact candidate tree", async () => {
    const content = "safe\n";
    const prepared = preparedWrite("create_file");
    const payload = { operation: "create_file", content, message } as const;
    const exact = snapshot(candidate, [parent], candidateTree, [
      otherEntry(),
      entry(path, "100644", blobSha(content)),
    ], message);
    const variants: RepositoryWriteCommitTreeSnapshot[] = [
      { ...exact, parentShas: ["f".repeat(40)] },
      { ...exact, messageSha256: sha256("another message") },
      { ...exact, entries: [otherEntry(), entry(path, "100755", blobSha(content))] },
      { ...exact, entries: [otherEntry(), entry(path, "100644", "1".repeat(40))] },
      { ...exact, entries: [otherEntry(), entry(path, "100644", blobSha(content)), entry("extra.txt", "100644", "2".repeat(40))] },
    ];
    for (const candidateSnapshot of variants) {
      const error = await fenceError(verifyRepositoryWriteReadback({
        prepared,
        payload,
        refs: reader(
          snapshot(parent, [], parentTree, [otherEntry()]),
          candidateSnapshot,
        ),
      }));
      expect(error.code).toMatch(/^repository_write_readback_/);
    }
  });

  test("binds the readback payload to the prepared operation and prior blob", async () => {
    const before = blobSha("before\n");
    const prepared = preparedWrite("update_file");
    const refs = reader(
      snapshot(parent, [], parentTree, [entry(path, "100644", before)]),
      snapshot(candidate, [parent], candidateTree, [
        entry(path, "100644", blobSha("after\n")),
      ], message),
    );
    for (const payload of [
      { operation: "create_file", content: "after\n", message },
      { operation: "update_file", contentSha: "f".repeat(40), content: "after\n", message },
    ]) {
      const error = await fenceError(verifyRepositoryWriteReadback({
        prepared,
        payload,
        refs,
      }));
      expect(error.code).toMatch(/^repository_write_readback_/);
    }
  });
});

function preparedWrite(operation: "create_file" | "update_file"): PreparedRepositoryWrite {
  return prepareRepositoryWrite({
    version: 1,
    repositoryFullName: repository,
    path,
    operation,
    targetRef: branch,
    expectedParentSha: parent,
  }, {
    version: 1,
    repositoryFullName: repository,
    targetRef: branch,
    defaultBranch: "main",
    authorityId: "authority_readback_1",
    authorityGeneration: 1,
    defaultBranchApprovalId: null,
  });
}

function snapshot(
  commitSha: string,
  parentShas: string[],
  treeSha: string,
  entries: RepositoryWriteTreeEntry[],
  commitMessage = "unrelated parent message",
): RepositoryWriteCommitTreeSnapshot {
  return {
    version: 1,
    repositoryFullName: repository,
    commitSha,
    parentShas,
    messageSha256: sha256(commitMessage),
    treeSha,
    entries,
  };
}

function reader(
  parentSnapshot: unknown,
  candidateSnapshot: unknown,
  head: string | null = candidate,
): RepositoryWriteReadbackReader {
  return {
    async getRefHead() { return head; },
    async getCommitParents() { return [parent]; },
    async getCommitTreeSnapshot(input) {
      return input.commitSha === parent ? parentSnapshot : candidateSnapshot;
    },
  };
}

function entry(
  entryPath: string,
  mode: "100644" | "100755",
  sha: string,
): RepositoryWriteTreeEntry {
  return { path: entryPath, mode, type: "blob", sha };
}

function otherEntry(): RepositoryWriteTreeEntry {
  return entry("README.md", "100644", otherBlob);
}

function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
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
  throw new Error("Expected repository write readback to remain pending");
}
