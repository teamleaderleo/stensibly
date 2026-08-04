import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWritePendingReconciliationError,
  GitHubRepositoryWriteProviderService,
  type GitHubRepositoryWriteAuthorityProvider,
  type GitHubRepositoryWriteCommand,
  type GitHubRepositoryWriteProviderAdapter,
  type GitHubRepositoryWriteStore,
} from "../src/github-repository-write-provider-service.ts";
import {
  GitHubRepositoryWritePostEffectError,
} from "../src/github-repository-write-post-effect-error.ts";
import { SqliteGitHubRepositoryWriteStore } from "../src/github-repository-write-store.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/post-effect-attribution";
const parentSha = "1".repeat(40);
const commitSha = "2".repeat(40);
const requestId = "REQ-POST-EFFECT-READBACK";

describe("repository write post-effect attribution", () => {
  test("retains verified commit and request identity when canonical effect readback fails", async () => {
    const observed = counters();
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const service = serviceWith(adapter(observed), store, "ghrw_post_effect_attribution");

    const first = await capturePending(service.execute(command()));
    expectVerifiedPending(first);
    expect(observed).toEqual({ dispatch: 1, ref: 2, parents: 1 });

    const replay = await capturePending(service.execute(command()));
    expect(replay.receipt).toEqual(first.receipt);
    expect(observed).toEqual({ dispatch: 1, ref: 2, parents: 1 });
    expect(JSON.stringify(first.receipt)).not.toContain("credential");
    store.close();
  });

  test("rejects substituted post-effect evidence before canonical provider-state reads", async () => {
    const observed = counters();
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const service = serviceWith(adapter(observed, {
      targetRef: "topic/other",
    }), store, "ghrw_post_effect_substitution");

    const pending = await capturePending(service.execute(command()));
    expect(pending.receipt).toMatchObject({
      state: "pending_reconciliation",
      dispatchCount: 1,
      verified: null,
      error: {
        code: "repository_write_provider_outcome_ambiguous",
        retry: "reconcile_before_retry",
      },
    });
    expect(observed).toEqual({ dispatch: 1, ref: 1, parents: 0 });
    store.close();
  });

  test("retains exact in-memory verified evidence when the durable verified hold fails", async () => {
    const observed = counters();
    const inner = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const store: GitHubRepositoryWriteStore = {
      reserveRepositoryWrite: inner.reserveRepositoryWrite.bind(inner),
      rejectAndReleaseRepositoryWrite:
        inner.rejectAndReleaseRepositoryWrite.bind(inner),
      holdRepositoryWriteForReconciliation:
        inner.holdRepositoryWriteForReconciliation.bind(inner),
      recordVerifiedRepositoryWrite:
        inner.recordVerifiedRepositoryWrite.bind(inner),
      async holdVerifiedRepositoryWriteForReconciliation() {
        throw new Error("durable hold unavailable with credential prose");
      },
      releaseVerifiedRepositoryWrite:
        inner.releaseVerifiedRepositoryWrite.bind(inner),
      getRepositoryWriteReceipt: inner.getRepositoryWriteReceipt.bind(inner),
    };
    const service = serviceWith(
      adapter(observed),
      store,
      "ghrw_post_effect_hold_failure",
    );

    const pending = await capturePending(service.execute(command()));
    expectVerifiedPending(pending);
    expect(observed).toEqual({ dispatch: 1, ref: 2, parents: 1 });
    expect(JSON.stringify(pending.receipt)).not.toContain("credential prose");
    inner.close();
  });
});

function adapter(
  observed: ReturnType<typeof counters>,
  overrides: Partial<{
    targetRef: string;
    parentSha: string;
    commitSha: string;
    providerRequestId: string;
  }> = {},
): GitHubRepositoryWriteProviderAdapter {
  return {
    async getRefHead() {
      observed.ref += 1;
      return observed.ref === 1 ? parentSha : commitSha;
    },
    async getCommitParents(input) {
      observed.parents += 1;
      expect(input).toEqual({ repositoryFullName, commitSha });
      return [parentSha];
    },
    async dispatchRepositoryWrite(input) {
      observed.dispatch += 1;
      expect(input).toMatchObject({
        repositoryFullName,
        targetRef,
        expectedParentSha: parentSha,
        operation: "create_file",
      });
      throw new GitHubRepositoryWritePostEffectError({
        code: "repository_write_effect_readback_incomplete",
        result: {
          commitSha: overrides.commitSha ?? commitSha,
          parentSha: overrides.parentSha ?? parentSha,
          targetRef: overrides.targetRef ?? targetRef,
          providerRequestId: overrides.providerRequestId ?? requestId,
        },
      });
    },
  };
}

function serviceWith(
  adapterValue: GitHubRepositoryWriteProviderAdapter,
  store: GitHubRepositoryWriteStore,
  id: string,
): GitHubRepositoryWriteProviderService {
  return new GitHubRepositoryWriteProviderService({
    authority: authorityProvider(),
    adapter: adapterValue,
    store,
    now: monotonicClock(),
    idFactory: () => id,
  });
}

function expectVerifiedPending(
  error: GitHubRepositoryWritePendingReconciliationError,
): void {
  expect(error.receipt).toMatchObject({
    state: "verified_pending_release",
    dispatchCount: 1,
    verified: {
      repositoryFullName,
      targetRef,
      expectedParentSha: parentSha,
      commitSha,
      nextExpectedParentSha: commitSha,
      providerRequestId: requestId,
      authorizesRetry: false,
    },
    error: {
      code: "repository_write_effect_readback_incomplete",
      retry: "reconcile_before_retry",
    },
  });
  expect(Object.isFrozen(error.receipt)).toBe(true);
  expect(Object.isFrozen(error.receipt.verified)).toBe(true);
}

function counters() {
  return { dispatch: 0, ref: 0, parents: 0 };
}

function authorityProvider(): GitHubRepositoryWriteAuthorityProvider {
  return {
    async getRepositoryWriteAuthority() {
      return {
        version: 1,
        repositoryFullName,
        targetRef,
        defaultBranch: "main",
        authorityId: "authority_post_effect_attribution",
        authorityGeneration: 1,
        defaultBranchApprovalId: null,
      };
    },
  };
}

function command(): GitHubRepositoryWriteCommand {
  return {
    project: "stensibly",
    actorId: "actor_post_effect_attribution",
    clientId: "client_post_effect_attribution",
    idempotencyKey: "post-effect-attribution-1",
    intent: {
      version: 1,
      repositoryFullName,
      path: "docs/post-effect-attribution.md",
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
    },
    payload: {
      operation: "create_file",
      content: "attributed\n",
      message: "Record attributed write",
    },
  };
}

function monotonicClock(): () => string {
  let tick = 0;
  return () => new Date(
    Date.UTC(2026, 7, 4, 18, 0, tick++),
  ).toISOString();
}

async function capturePending(
  operation: Promise<unknown>,
): Promise<GitHubRepositoryWritePendingReconciliationError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(
      GitHubRepositoryWritePendingReconciliationError,
    );
    return error as GitHubRepositoryWritePendingReconciliationError;
  }
  throw new Error("Expected pending reconciliation");
}
