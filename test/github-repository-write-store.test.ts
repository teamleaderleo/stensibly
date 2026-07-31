import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freezeRepositoryWriteReceipt,
  type GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service.ts";
import { SqliteGitHubRepositoryWriteStore } from "../src/github-repository-write-store.ts";
import type { VerifiedRepositoryWrite } from "../src/repository-write-fence.ts";

const parent = "a".repeat(40);
const commit = "b".repeat(40);

function receipt(overrides: Partial<GitHubRepositoryWriteReceipt> = {}): GitHubRepositoryWriteReceipt {
  return freezeRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_store_1",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/exact-write",
    path: "docs/write-receipt.json",
    operation: "create_file",
    expectedParentSha: parent,
    requestSha256: `sha256:${"1".repeat(64)}`,
    payloadSha256: `sha256:${"2".repeat(64)}`,
    actorId: "actor_plover",
    clientId: "chatgpt_plover",
    idempotencyKey: "write_store_1",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    verified: null,
    error: null,
    ...overrides,
  });
}

function verified(): VerifiedRepositoryWrite {
  return Object.freeze({
    version: 1,
    state: "verified",
    repositoryFullName: "teamleaderleo/stensibly",
    path: "docs/write-receipt.json",
    operation: "create_file",
    targetRef: "feature/exact-write",
    defaultBranch: "main",
    expectedParentSha: parent,
    authorityId: "grant_repository_write_7",
    authorityGeneration: 7,
    defaultBranchApprovalId: null,
    commitSha: commit,
    nextExpectedParentSha: commit,
    providerRequestId: "request_store_1",
    requestSha256: `sha256:${"1".repeat(64)}`,
    verifiedAt: "2026-08-01T00:00:01.000Z",
    authorizesRetry: false,
  });
}

function withDatabase(
  action: (path: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "stensibly-write-store-"));
  const path = join(directory, "writes.sqlite");
  return action(path).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

describe("SQLite GitHub repository write store", () => {
  test("requires an explicit durable path or database owner", () => {
    expect(() => new SqliteGitHubRepositoryWriteStore({ path: "" })).toThrow(TypeError);
  });

  test("persists one atomic repository/ref lane across store instances", async () => {
    await withDatabase(async (path) => {
      const firstStore = new SqliteGitHubRepositoryWriteStore({ path });
      const firstReceipt = receipt();
      expect(await firstStore.reserveRepositoryWrite(firstReceipt)).toMatchObject({
        outcome: "reserved",
        receipt: { id: "ghrw_store_1" },
      });
      firstStore.close();

      const secondStore = new SqliteGitHubRepositoryWriteStore({ path });
      expect(await secondStore.getRepositoryWriteReceipt(
        "stensibly",
        "write_store_1",
      )).toMatchObject({ state: "reserved", id: "ghrw_store_1" });
      expect(await secondStore.reserveRepositoryWrite(firstReceipt)).toMatchObject({
        outcome: "replay",
        receipt: { id: "ghrw_store_1" },
      });

      const blocked = await secondStore.reserveRepositoryWrite(receipt({
        id: "ghrw_store_2",
        idempotencyKey: "write_store_2",
      }));
      expect(blocked).toMatchObject({
        outcome: "blocked",
        receipt: { id: "ghrw_store_1", idempotencyKey: "write_store_1" },
      });
      secondStore.close();
    });
  });

  test("rejects idempotency reuse with changed exact request evidence", async () => {
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const firstReceipt = receipt();
    await store.reserveRepositoryWrite(firstReceipt);

    const conflict = await store.reserveRepositoryWrite(receipt({
      id: "ghrw_store_conflict",
      payloadSha256: `sha256:${"3".repeat(64)}`,
    }));
    expect(conflict).toMatchObject({
      outcome: "conflict",
      receipt: { id: "ghrw_store_1" },
    });
    store.close();
  });

  test("releases a rejected pre-dispatch lane for another exact write", async () => {
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const firstReceipt = receipt();
    await store.reserveRepositoryWrite(firstReceipt);
    const rejected = await store.rejectAndReleaseRepositoryWrite({
      receipt: firstReceipt,
      code: "repository_write_expected_parent_moved",
      rejectedAt: "2026-08-01T00:00:01.000Z",
    });
    expect(rejected).toMatchObject({
      state: "rejected",
      dispatchCount: 0,
      error: { retry: "do_not_retry" },
    });

    const next = await store.reserveRepositoryWrite(receipt({
      id: "ghrw_store_next",
      idempotencyKey: "write_store_next",
    }));
    expect(next.outcome).toBe("reserved");
    store.close();
  });

  test("persists verified evidence before releasing the lane", async () => {
    await withDatabase(async (path) => {
      const store = new SqliteGitHubRepositoryWriteStore({ path });
      const firstReceipt = receipt();
      await store.reserveRepositoryWrite(firstReceipt);
      const recorded = await store.recordVerifiedRepositoryWrite({
        receipt: freezeRepositoryWriteReceipt({
          ...firstReceipt,
          dispatchCount: 1,
        }),
        verified: verified(),
      });
      expect(recorded).toMatchObject({
        state: "verified_pending_release",
        dispatchCount: 1,
        verified: { commitSha: commit },
      });
      store.close();

      const recovered = new SqliteGitHubRepositoryWriteStore({ path });
      expect(await recovered.getRepositoryWriteReceipt(
        "stensibly",
        "write_store_1",
      )).toMatchObject({
        state: "verified_pending_release",
        verified: { commitSha: commit },
      });
      const blocked = await recovered.reserveRepositoryWrite(receipt({
        id: "ghrw_store_blocked",
        idempotencyKey: "write_store_blocked",
      }));
      expect(blocked.outcome).toBe("blocked");

      const released = await recovered.releaseVerifiedRepositoryWrite({
        receipt: recorded,
        releasedAt: "2026-08-01T00:00:02.000Z",
      });
      expect(released).toMatchObject({
        state: "succeeded",
        verified: { commitSha: commit },
        error: null,
      });
      expect((await recovered.reserveRepositoryWrite(receipt({
        id: "ghrw_store_after_release",
        idempotencyKey: "write_store_after_release",
      }))).outcome).toBe("reserved");
      recovered.close();
    });
  });

  test("persists verified reconciliation evidence after a primary write failure", async () => {
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const firstReceipt = receipt();
    await store.reserveRepositoryWrite(firstReceipt);
    const held = await store.holdVerifiedRepositoryWriteForReconciliation({
      receipt: freezeRepositoryWriteReceipt({ ...firstReceipt, dispatchCount: 1 }),
      verified: verified(),
      code: "repository_write_verified_receipt_persistence_failed",
      heldAt: "2026-08-01T00:00:02.000Z",
    });
    expect(held).toMatchObject({
      state: "verified_pending_release",
      verified: { commitSha: commit },
      error: {
        code: "repository_write_verified_receipt_persistence_failed",
        retry: "reconcile_before_retry",
      },
    });
    expect((await store.reserveRepositoryWrite(receipt({
      id: "ghrw_store_after_hold",
      idempotencyKey: "write_store_after_hold",
    }))).outcome).toBe("blocked");
    store.close();
  });
});
