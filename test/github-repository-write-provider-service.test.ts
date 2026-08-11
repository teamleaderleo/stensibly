import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  GitHubRepositoryWritePendingReconciliationError,
  GitHubRepositoryWriteProviderService,
  GitHubRepositoryWriteRejectedError,
  GitHubRepositoryWriteSettlementError,
  type GitHubRepositoryWriteAuthorityProvider,
  type GitHubRepositoryWriteProviderAdapter,
  type GitHubRepositoryWriteStore,
} from "../src/github-repository-write-provider-service.ts";
import { SqliteGitHubRepositoryWriteStore } from "../src/github-repository-write-store.ts";

const parent = "a".repeat(40);
const commit = "b".repeat(40);
const moved = "c".repeat(40);

type DispatchInput = Parameters<
  GitHubRepositoryWriteProviderAdapter["dispatchRepositoryWrite"]
>[0];

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "stensibly",
    actorId: "actor_plover",
    clientId: "chatgpt_plover",
    idempotencyKey: "write_plover_1",
    intent: {
      version: 1,
      repositoryFullName: "teamleaderleo/stensibly",
      path: "docs/write-receipt.json",
      operation: "create_file",
      targetRef: "feature/exact-write",
      expectedParentSha: parent,
    },
    payload: {
      operation: "create_file",
      content: "{}\n",
      message: "Record exact write receipt",
    },
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

function clock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 1, 0, 0, tick++)).toISOString();
}

function memoryStore(): SqliteGitHubRepositoryWriteStore {
  return new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
}

function authorityProvider(
  values: readonly (Record<string, unknown> | Error)[] = [authority()],
): GitHubRepositoryWriteAuthorityProvider & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getRepositoryWriteAuthority() {
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
  };
}

function successfulAdapter(): GitHubRepositoryWriteProviderAdapter & {
  dispatches: number;
  lastDispatch: DispatchInput | null;
} {
  let dispatched = false;
  let dispatches = 0;
  let lastDispatch: DispatchInput | null = null;
  return {
    get dispatches() {
      return dispatches;
    },
    get lastDispatch() {
      return lastDispatch;
    },
    async getRefHead() {
      return dispatched ? commit : parent;
    },
    async getCommitParents() {
      return [parent];
    },
    async dispatchRepositoryWrite(input) {
      dispatched = true;
      dispatches += 1;
      lastDispatch = structuredClone(input);
      return {
        commitSha: commit,
        providerRequestId: "request_write_1",
        targetRef: "feature/exact-write",
        parentSha: parent,
      };
    },
  };
}

async function caught<T extends Error>(
  action: Promise<unknown>,
  expected: abstract new (...args: never[]) => T,
): Promise<T> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(expected);
    return error as T;
  }
  throw new Error("Expected action to throw");
}

function delegatingStore(
  store: GitHubRepositoryWriteStore,
  overrides: Partial<GitHubRepositoryWriteStore>,
): GitHubRepositoryWriteStore {
  return {
    reserveRepositoryWrite: overrides.reserveRepositoryWrite
      ?? ((input) => store.reserveRepositoryWrite(input)),
    rejectAndReleaseRepositoryWrite: overrides.rejectAndReleaseRepositoryWrite
      ?? ((input) => store.rejectAndReleaseRepositoryWrite(input)),
    holdRepositoryWriteForReconciliation: overrides.holdRepositoryWriteForReconciliation
      ?? ((input) => store.holdRepositoryWriteForReconciliation(input)),
    recordVerifiedRepositoryWrite: overrides.recordVerifiedRepositoryWrite
      ?? ((input) => store.recordVerifiedRepositoryWrite(input)),
    holdVerifiedRepositoryWriteForReconciliation:
      overrides.holdVerifiedRepositoryWriteForReconciliation
      ?? ((input) => store.holdVerifiedRepositoryWriteForReconciliation(input)),
    releaseVerifiedRepositoryWrite: overrides.releaseVerifiedRepositoryWrite
      ?? ((input) => store.releaseVerifiedRepositoryWrite(input)),
    getRepositoryWriteReceipt: overrides.getRepositoryWriteReceipt
      ?? ((project, key) => store.getRepositoryWriteReceipt(project, key)),
  };
}

describe("durable GitHub repository write provider service", () => {
  test("re-reads the exact head and authority before one verified dispatch", async () => {
    const store = memoryStore();
    const authoritySource = authorityProvider();
    const adapter = successfulAdapter();
    const service = new GitHubRepositoryWriteProviderService({
      authority: authoritySource,
      adapter,
      store,
      now: clock(),
      idFactory: () => "ghrw_success_1",
    });

    const receipt = await service.execute(command());

    expect(receipt).toMatchObject({
      id: "ghrw_success_1",
      state: "succeeded",
      dispatchCount: 1,
      repositoryFullName: "teamleaderleo/stensibly",
      targetRef: "feature/exact-write",
      expectedParentSha: parent,
      verified: {
        commitSha: commit,
        nextExpectedParentSha: commit,
        providerRequestId: "request_write_1",
        authorizesRetry: false,
      },
      error: null,
    });
    expect(authoritySource.calls).toBe(2);
    expect(adapter.dispatches).toBe(1);
    expect(adapter.lastDispatch).toMatchObject({
      repositoryFullName: "teamleaderleo/stensibly",
      path: "docs/write-receipt.json",
      operation: "create_file",
      targetRef: "feature/exact-write",
      expectedParentSha: parent,
    });
    expect(adapter.lastDispatch).not.toHaveProperty("prepared");
    expect(Object.isFrozen(receipt)).toBe(true);
    store.close();
  });

  test("rejects moved or malformed target heads and releases the lane", async () => {
    for (const [head, code] of [
      [moved, "repository_write_expected_parent_moved"],
      ["BAD", "repository_write_pre_dispatch_head_invalid"],
    ] as const) {
      const store = memoryStore();
      let allow = false;
      let dispatches = 0;
      let dispatched = false;
      const adapter: GitHubRepositoryWriteProviderAdapter = {
        async getRefHead() {
          if (dispatched) return commit;
          return allow ? parent : head;
        },
        async getCommitParents() {
          return [parent];
        },
        async dispatchRepositoryWrite() {
          dispatched = true;
          dispatches += 1;
          return { commitSha: commit, targetRef: "feature/exact-write", parentSha: parent };
        },
      };
      const service = new GitHubRepositoryWriteProviderService({
        authority: authorityProvider(),
        adapter,
        store,
        now: clock(),
        idFactory: (() => {
          let count = 0;
          return () => `ghrw_head_${++count}`;
        })(),
      });

      const error = await caught(
        service.execute(command()),
        GitHubRepositoryWriteRejectedError,
      );
      expect(error.code).toBe(code);
      expect(error.receipt).toMatchObject({ state: "rejected", dispatchCount: 0 });
      expect(dispatches).toBe(0);

      allow = true;
      const after = await service.execute(command({ idempotencyKey: `write_after_${code}` }));
      expect(after.state).toBe("succeeded");
      expect(dispatches).toBe(1);
      store.close();
    }
  });

  test("rejects changed or failed authority replay and releases the lane", async () => {
    for (const second of [
      authority({ authorityGeneration: 8 }),
      new Error("authority backend failed"),
    ]) {
      const store = memoryStore();
      const adapter = successfulAdapter();
      const service = new GitHubRepositoryWriteProviderService({
        authority: authorityProvider([authority(), second]),
        adapter,
        store,
        now: clock(),
        idFactory: (() => {
          let count = 0;
          return () => `ghrw_authority_${++count}`;
        })(),
      });

      const error = await caught(
        service.execute(command()),
        GitHubRepositoryWriteRejectedError,
      );
      expect(error.code).toBe("repository_write_authority_changed");
      expect(error.receipt.state).toBe("rejected");
      expect(adapter.dispatches).toBe(0);

      const retry = new GitHubRepositoryWriteProviderService({
        authority: authorityProvider(),
        adapter,
        store,
        now: clock(),
        idFactory: () => "ghrw_authority_recovered",
      });
      expect((await retry.execute(command({
        idempotencyKey: `write_recovered_${second instanceof Error ? "error" : "change"}`,
      }))).state).toBe("succeeded");
      store.close();
    }
  });

  test("holds a repository/ref lane across concurrent idempotency keys", async () => {
    const store = memoryStore();
    let dispatched = false;
    let dispatches = 0;
    let dispatchStartedResolve!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      dispatchStartedResolve = resolve;
    });
    let finishDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    const adapter: GitHubRepositoryWriteProviderAdapter = {
      async getRefHead() {
        return dispatched ? commit : parent;
      },
      async getCommitParents() {
        return [parent];
      },
      async dispatchRepositoryWrite() {
        dispatched = true;
        dispatches += 1;
        dispatchStartedResolve();
        await dispatchGate;
        return { commitSha: commit, targetRef: "feature/exact-write", parentSha: parent };
      },
    };
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: clock(),
      idFactory: (() => {
        let count = 0;
        return () => `ghrw_concurrent_${++count}`;
      })(),
    });

    const first = service.execute(command({ idempotencyKey: "write_concurrent_1" }));
    await dispatchStarted;
    const blocked = await caught(
      service.execute(command({ idempotencyKey: "write_concurrent_2" })),
      GitHubRepositoryWritePendingReconciliationError,
    );
    expect(blocked.receipt.idempotencyKey).toBe("write_concurrent_1");
    expect(dispatches).toBe(1);

    finishDispatch();
    expect((await first).state).toBe("succeeded");
    store.close();
  });

  test("replays an ambiguous provider outcome without a second provider call", async () => {
    const store = memoryStore();
    let dispatches = 0;
    const adapter: GitHubRepositoryWriteProviderAdapter = {
      async getRefHead() {
        return parent;
      },
      async getCommitParents() {
        return [parent];
      },
      async dispatchRepositoryWrite() {
        dispatches += 1;
        throw new Error("private provider detail");
      },
    };
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: clock(),
      idFactory: () => "ghrw_ambiguous",
    });

    const first = await caught(
      service.execute(command()),
      GitHubRepositoryWritePendingReconciliationError,
    );
    expect(first.receipt).toMatchObject({
      state: "pending_reconciliation",
      dispatchCount: 1,
      error: {
        code: "repository_write_provider_outcome_ambiguous",
        retry: "reconcile_before_retry",
      },
    });
    expect(JSON.stringify(first.receipt)).not.toContain("private provider detail");

    await caught(
      service.execute(command()),
      GitHubRepositoryWritePendingReconciliationError,
    );
    expect(dispatches).toBe(1);
    store.close();
  });

  test("settles an ambiguous provider effect from an exact canonical tree readback", async () => {
    const store = memoryStore();
    let applied = false;
    let dispatches = 0;
    let treeReads = 0;
    const content = "{}\n";
    const adapter: GitHubRepositoryWriteProviderAdapter = {
      async getRefHead() { return applied ? commit : parent; },
      async getCommitParents() { return [parent]; },
      async getCommitTreeSnapshot(input) {
        treeReads += 1;
        return input.commitSha === parent
          ? treeSnapshot(parent, [], "d".repeat(40), [])
          : treeSnapshot(commit, [parent], "e".repeat(40), [{
              path: "docs/write-receipt.json",
              mode: "100644",
              type: "blob",
              sha: blobSha(content),
            }], "Record exact write receipt");
      },
      async dispatchRepositoryWrite() {
        dispatches += 1;
        applied = true;
        throw new Error("response was lost after the exact ref update");
      },
    };
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: clock(),
      idFactory: () => "ghrw_readback_success",
    });

    await caught(
      service.execute(command()),
      GitHubRepositoryWritePendingReconciliationError,
    );
    const receipt = await service.reconcile(command());

    expect(receipt).toMatchObject({
      id: "ghrw_readback_success",
      state: "succeeded",
      dispatchCount: 1,
      verified: {
        commitSha: commit,
        providerRequestId: null,
        authorizesRetry: false,
      },
    });
    expect(dispatches).toBe(1);
    expect(treeReads).toBe(2);
    await expect(service.reconcile(command())).resolves.toEqual(receipt);
    expect(treeReads).toBe(2);
    store.close();
  });

  test("rejects changed reconciliation identity before canonical provider reads", async () => {
    for (const changed of [
      command({ actorId: "actor_other" }),
      command({ payload: {
        operation: "create_file",
        content: "changed\n",
        message: "Record exact write receipt",
      } }),
    ]) {
      const store = memoryStore();
      let applied = false;
      let providerReads = 0;
      const adapter: GitHubRepositoryWriteProviderAdapter = {
        async getRefHead() {
          if (applied) providerReads += 1;
          return applied ? commit : parent;
        },
        async getCommitParents() { return [parent]; },
        async getCommitTreeSnapshot() {
          providerReads += 1;
          throw new Error("must not observe changed reconciliation identity");
        },
        async dispatchRepositoryWrite() {
          applied = true;
          throw new Error("ambiguous");
        },
      };
      const service = new GitHubRepositoryWriteProviderService({
        authority: authorityProvider(),
        adapter,
        store,
        now: clock(),
        idFactory: () => "ghrw_readback_identity",
      });
      await caught(
        service.execute(command()),
        GitHubRepositoryWritePendingReconciliationError,
      );
      await expect(service.reconcile(changed)).rejects.toMatchObject({
        code: "github_repository_write_reconciliation_identity_mismatch",
      });
      expect(providerReads).toBe(0);
      store.close();
    }
  });

  test("rejects changed reconciliation authority before canonical provider reads", async () => {
    const store = memoryStore();
    let applied = false;
    let providerReads = 0;
    const adapter: GitHubRepositoryWriteProviderAdapter = {
      async getRefHead() {
        if (applied) providerReads += 1;
        return applied ? commit : parent;
      },
      async getCommitParents() { return [parent]; },
      async getCommitTreeSnapshot() {
        providerReads += 1;
        throw new Error("must not observe changed authority");
      },
      async dispatchRepositoryWrite() {
        applied = true;
        throw new Error("ambiguous");
      },
    };
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider([
        authority(),
        authority(),
        authority({ authorityGeneration: 8 }),
      ]),
      adapter,
      store,
      now: clock(),
      idFactory: () => "ghrw_readback_authority",
    });
    await caught(
      service.execute(command()),
      GitHubRepositoryWritePendingReconciliationError,
    );

    await expect(service.reconcile(command())).rejects.toMatchObject({
      code: "github_repository_write_reconciliation_identity_mismatch",
    });
    expect(providerReads).toBe(0);
    store.close();
  });

  test("persists verified fallback evidence when primary receipt persistence fails", async () => {
    const durable = memoryStore();
    const store = delegatingStore(durable, {
      async recordVerifiedRepositoryWrite() {
        throw new Error("injected primary persistence failure");
      },
    });
    const adapter = successfulAdapter();
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: clock(),
      idFactory: () => "ghrw_record_failure",
    });

    const error = await caught(
      service.execute(command()),
      GitHubRepositoryWriteSettlementError,
    );
    expect(error.code).toBe("repository_write_verified_receipt_persistence_failed");
    expect(error.verified.commitSha).toBe(commit);
    expect(error.receipt).toMatchObject({
      state: "verified_pending_release",
      dispatchCount: 1,
      verified: { commitSha: commit },
      error: { code: "repository_write_verified_receipt_persistence_failed" },
    });
    expect(await durable.getRepositoryWriteReceipt(
      "stensibly",
      "write_plover_1",
    )).toMatchObject({
      state: "verified_pending_release",
      verified: { commitSha: commit },
    });
    expect(adapter.dispatches).toBe(1);

    const blocked = await caught(
      service.execute(command({ idempotencyKey: "write_after_record_failure" })),
      GitHubRepositoryWritePendingReconciliationError,
    );
    expect(blocked.receipt.idempotencyKey).toBe("write_plover_1");
    durable.close();
  });

  test("keeps durable verified evidence and the lane when release fails", async () => {
    const durable = memoryStore();
    const store = delegatingStore(durable, {
      async releaseVerifiedRepositoryWrite() {
        throw new Error("injected release failure");
      },
    });
    const adapter = successfulAdapter();
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: clock(),
      idFactory: () => "ghrw_release_failure",
    });

    const error = await caught(
      service.execute(command()),
      GitHubRepositoryWriteSettlementError,
    );
    expect(error.code).toBe("repository_write_verified_lane_release_failed");
    expect(error.verified.commitSha).toBe(commit);
    expect(await durable.getRepositoryWriteReceipt(
      "stensibly",
      "write_plover_1",
    )).toMatchObject({
      state: "verified_pending_release",
      dispatchCount: 1,
      verified: { commitSha: commit },
    });

    const blocked = await caught(
      service.execute(command({ idempotencyKey: "write_after_release_failure" })),
      GitHubRepositoryWritePendingReconciliationError,
    );
    expect(blocked.receipt.state).toBe("verified_pending_release");
    expect(adapter.dispatches).toBe(1);
    durable.close();
  });

  test("releases durable verified evidence during reconciliation without provider reads", async () => {
    const durable = memoryStore();
    let releaseCalls = 0;
    const store = delegatingStore(durable, {
      async releaseVerifiedRepositoryWrite(input) {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error("injected first release failure");
        return await durable.releaseVerifiedRepositoryWrite(input);
      },
    });
    let treeReads = 0;
    const adapter = successfulAdapter();
    adapter.getCommitTreeSnapshot = async () => {
      treeReads += 1;
      throw new Error("verified settlement must not read GitHub");
    };
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: clock(),
      idFactory: () => "ghrw_release_reconciliation",
    });
    await caught(
      service.execute(command()),
      GitHubRepositoryWriteSettlementError,
    );

    const receipt = await service.reconcile(command());
    expect(receipt).toMatchObject({
      state: "succeeded",
      dispatchCount: 1,
      verified: { commitSha: commit },
    });
    expect(releaseCalls).toBe(2);
    expect(adapter.dispatches).toBe(1);
    expect(treeReads).toBe(0);
    durable.close();
  });

  test("rejects credential-shaped durable command identities before authority", async () => {
    const store = memoryStore();
    const authoritySource = authorityProvider();
    const adapter = successfulAdapter();
    const service = new GitHubRepositoryWriteProviderService({
      authority: authoritySource,
      adapter,
      store,
    });

    await expect(service.execute(command({
      clientId: "secret://production/github-token",
    }))).rejects.toThrow(TypeError);
    expect(authoritySource.calls).toBe(0);
    expect(adapter.dispatches).toBe(0);
    store.close();
  });
});

function treeSnapshot(
  commitSha: string,
  parentShas: string[],
  treeSha: string,
  entries: Array<{ path: string; mode: string; type: string; sha: string }>,
  message = "parent message",
): unknown {
  return {
    version: 1,
    repositoryFullName: "teamleaderleo/stensibly",
    commitSha,
    parentShas,
    messageSha256: sha256(message),
    treeSha,
    entries,
  };
}

function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}
