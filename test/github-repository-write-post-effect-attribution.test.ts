import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWritePendingReconciliationError,
  GitHubRepositoryWriteProviderService,
  type GitHubRepositoryWriteAuthorityProvider,
  type GitHubRepositoryWriteCommand,
  type GitHubRepositoryWriteProviderAdapter,
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
    let dispatchCalls = 0;
    let refReads = 0;
    let parentReads = 0;
    const adapter: GitHubRepositoryWriteProviderAdapter = {
      async getRefHead() {
        refReads += 1;
        return refReads === 1 ? parentSha : commitSha;
      },
      async getCommitParents(input) {
        parentReads += 1;
        expect(input).toEqual({
          repositoryFullName,
          commitSha,
        });
        return [parentSha];
      },
      async dispatchRepositoryWrite(input) {
        dispatchCalls += 1;
        expect(input).toMatchObject({
          repositoryFullName,
          targetRef,
          expectedParentSha: parentSha,
          operation: "create_file",
        });
        throw new GitHubRepositoryWritePostEffectError({
          code: "repository_write_effect_readback_incomplete",
          result: {
            commitSha,
            parentSha,
            targetRef,
            providerRequestId: requestId,
          },
        });
      },
    };
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: monotonicClock(),
      idFactory: () => "ghrw_post_effect_attribution",
    });

    const first = await capturePending(service.execute(command()));
    expect(first.receipt).toMatchObject({
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
    expect(dispatchCalls).toBe(1);
    expect(refReads).toBe(2);
    expect(parentReads).toBe(1);

    const replay = await capturePending(service.execute(command()));
    expect(replay.receipt).toEqual(first.receipt);
    expect(dispatchCalls).toBe(1);
    expect(refReads).toBe(2);
    expect(parentReads).toBe(1);
    expect(JSON.stringify(first.receipt)).not.toContain("credential");
    store.close();
  });

  test("rejects substituted post-effect evidence before canonical provider-state reads", async () => {
    let refReads = 0;
    let parentReads = 0;
    const adapter: GitHubRepositoryWriteProviderAdapter = {
      async getRefHead() {
        refReads += 1;
        return parentSha;
      },
      async getCommitParents() {
        parentReads += 1;
        return [parentSha];
      },
      async dispatchRepositoryWrite() {
        throw new GitHubRepositoryWritePostEffectError({
          code: "repository_write_effect_readback_incomplete",
          result: {
            commitSha,
            parentSha,
            targetRef: "topic/other",
            providerRequestId: requestId,
          },
        });
      },
    };
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: monotonicClock(),
      idFactory: () => "ghrw_post_effect_substitution",
    });

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
    expect(refReads).toBe(1);
    expect(parentReads).toBe(0);
    store.close();
  });
});

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
