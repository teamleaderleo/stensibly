import { describe, expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexGitHubRepositoryWriteStore,
  GitHubRepositoryWriteStorageError,
  canonicalGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-convex-store.ts";
import {
  freezeRepositoryWriteReceipt,
  type GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service.ts";
import type { VerifiedRepositoryWrite } from "../src/repository-write-fence.ts";

class FakeClient implements ConvexCaller {
  readonly mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  mutationResult: unknown;
  queryResult: unknown;
  echoNextReceipt = false;

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.mutations.push({ name: String(reference), args });
    if (this.echoNextReceipt && typeof args.nextReceiptJson === "string") {
      return args.nextReceiptJson;
    }
    return this.mutationResult;
  }

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queries.push({ name: String(reference), args });
    return this.queryResult;
  }
}

describe("Convex GitHub repository write store client", () => {
  test("binds exact reservation response and service scope", async () => {
    const client = new FakeClient();
    const subject = receipt();
    client.mutationResult = {
      outcome: "reserved",
      receiptJson: canonicalGitHubRepositoryWriteReceiptJson(subject),
    };
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });

    await expect(store.reserveRepositoryWrite(subject)).resolves.toEqual({
      outcome: "reserved",
      receipt: subject,
    });
    expect(client.mutations[0]).toEqual({
      name: "githubRepositoryWrites:reserve",
      args: {
        project: "stensibly",
        receiptJson: canonicalGitHubRepositoryWriteReceiptJson(subject),
        serviceSecret: "service-secret",
        workspace: "default",
      },
    });
  });

  test("rejects blocked-lane substitution and hostile backend getters", async () => {
    const client = new FakeClient();
    const requested = receipt();
    const wrongLane = receipt({
      id: "ghrw_wrong_lane",
      idempotencyKey: "other-write",
      targetRef: "another-ref",
    });
    client.mutationResult = {
      outcome: "blocked",
      receiptJson: canonicalGitHubRepositoryWriteReceiptJson(wrongLane),
    };
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
    });
    await expect(store.reserveRepositoryWrite(requested)).rejects
      .toBeInstanceOf(GitHubRepositoryWriteStorageError);

    let getterCalls = 0;
    const hostile: Record<string, unknown> = { outcome: "reserved" };
    Object.defineProperty(hostile, "receiptJson", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("private backend prose");
      },
    });
    client.mutationResult = hostile;
    await expect(store.reserveRepositoryWrite(requested)).rejects
      .toBeInstanceOf(GitHubRepositoryWriteStorageError);
    expect(getterCalls).toBe(0);
  });

  test("emits exact lifecycle actions and accepts only the computed receipt", async () => {
    const client = new FakeClient();
    client.echoNextReceipt = true;
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
      workspace: "dogfood",
    });
    const dispatched = receipt({ dispatchCount: 1 });

    const rejected = await store.rejectAndReleaseRepositoryWrite({
      receipt: dispatched,
      code: "repository_write_authority_changed",
      rejectedAt: "2026-08-03T10:00:01.000Z",
    });
    expect(rejected).toMatchObject({
      state: "rejected",
      dispatchCount: 1,
      error: {
        code: "repository_write_authority_changed",
        retry: "do_not_retry",
      },
    });

    const pending = await store.holdRepositoryWriteForReconciliation({
      receipt: dispatched,
      code: "repository_write_provider_outcome_ambiguous",
      heldAt: "2026-08-03T10:00:02.000Z",
    });
    expect(pending).toMatchObject({
      state: "pending_reconciliation",
      error: {
        code: "repository_write_provider_outcome_ambiguous",
        retry: "reconcile_before_retry",
      },
    });

    const verification = verified();
    const recorded = await store.recordVerifiedRepositoryWrite({
      receipt: dispatched,
      verified: verification,
    });
    expect(recorded).toMatchObject({
      state: "verified_pending_release",
      dispatchCount: 1,
      verified: verification,
      error: {
        code: "repository_write_settlement_incomplete",
        retry: "reconcile_before_retry",
      },
    });

    const heldVerified = await store.holdVerifiedRepositoryWriteForReconciliation({
      receipt: dispatched,
      verified: verification,
      code: "repository_write_verified_release_failed",
      heldAt: "2026-08-03T10:00:04.000Z",
    });
    expect(heldVerified).toMatchObject({
      state: "verified_pending_release",
      verified: verification,
      error: {
        code: "repository_write_verified_release_failed",
        retry: "reconcile_before_retry",
      },
    });

    const released = await store.releaseVerifiedRepositoryWrite({
      receipt: recorded,
      releasedAt: "2026-08-03T10:00:05.000Z",
    });
    expect(released).toMatchObject({
      state: "succeeded",
      verified: verification,
      error: null,
    });

    expect(client.mutations.map((entry) => ({
      name: entry.name,
      action: entry.args.action,
      workspace: entry.args.workspace,
      project: entry.args.project,
    }))).toEqual([
      {
        name: "githubRepositoryWrites:transition",
        action: "reject_and_release",
        workspace: "dogfood",
        project: "stensibly",
      },
      {
        name: "githubRepositoryWrites:transition",
        action: "hold_for_reconciliation",
        workspace: "dogfood",
        project: "stensibly",
      },
      {
        name: "githubRepositoryWrites:transition",
        action: "record_verified",
        workspace: "dogfood",
        project: "stensibly",
      },
      {
        name: "githubRepositoryWrites:transition",
        action: "hold_verified_for_reconciliation",
        workspace: "dogfood",
        project: "stensibly",
      },
      {
        name: "githubRepositoryWrites:transition",
        action: "release_verified",
        workspace: "dogfood",
        project: "stensibly",
      },
    ]);
  });

  test("rejects a substituted transition response", async () => {
    const client = new FakeClient();
    const subject = receipt({ dispatchCount: 1 });
    client.mutationResult = canonicalGitHubRepositoryWriteReceiptJson(receipt({
      state: "succeeded",
      dispatchCount: 1,
      updatedAt: "2026-08-03T10:00:01.000Z",
      verified: verified(),
    }));
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
    });

    await expect(store.holdRepositoryWriteForReconciliation({
      receipt: subject,
      code: "repository_write_provider_outcome_ambiguous",
      heldAt: "2026-08-03T10:00:01.000Z",
    })).rejects.toBeInstanceOf(GitHubRepositoryWriteStorageError);
  });

  test("binds receipt lookup to exact project and idempotency identity", async () => {
    const client = new FakeClient();
    const subject = receipt({ state: "pending_reconciliation", dispatchCount: 1, error: {
      code: "repository_write_provider_outcome_ambiguous",
      retry: "reconcile_before_retry",
    } });
    client.queryResult = canonicalGitHubRepositoryWriteReceiptJson(subject);
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
    });

    await expect(store.getRepositoryWriteReceipt(
      subject.project,
      subject.idempotencyKey,
    )).resolves.toEqual(subject);
    expect(client.queries[0]).toEqual({
      name: "githubRepositoryWrites:get",
      args: {
        project: subject.project,
        idempotencyKey: subject.idempotencyKey,
        serviceSecret: "service-secret",
        workspace: "default",
      },
    });

    client.queryResult = canonicalGitHubRepositoryWriteReceiptJson(receipt({
      idempotencyKey: "substituted-key",
    }));
    await expect(store.getRepositoryWriteReceipt(
      subject.project,
      subject.idempotencyKey,
    )).rejects.toBeInstanceOf(GitHubRepositoryWriteStorageError);
  });

  test("rejects noncanonical service and project scope before backend use", async () => {
    const client = new FakeClient();
    expect(() => new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "",
    })).toThrow("Convex service secret");
    expect(() => new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
      workspace: "Default",
    })).toThrow("lowercase slug");

    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
    });
    await expect(store.getRepositoryWriteReceipt(
      "Stensibly",
      "repository-write-1",
    )).rejects.toThrow("lowercase slug");
    expect(client.queries).toHaveLength(0);
  });
});

function receipt(
  overrides: Partial<GitHubRepositoryWriteReceipt> = {},
): GitHubRepositoryWriteReceipt {
  return freezeRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_receipt_1",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/repository-write",
    path: "docs/provider-write.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: `sha256:${"b".repeat(64)}`,
    payloadSha256: `sha256:${"c".repeat(64)}`,
    actorId: "actor_juniper",
    clientId: "client_github_only",
    idempotencyKey: "repository-write-1",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    verified: null,
    error: null,
    ...overrides,
  });
}

function verified(): VerifiedRepositoryWrite {
  return {
    version: 1,
    state: "verified",
    repositoryFullName: "teamleaderleo/stensibly",
    path: "docs/provider-write.md",
    operation: "create_file",
    targetRef: "feature/repository-write",
    defaultBranch: "main",
    expectedParentSha: "a".repeat(40),
    authorityId: "grant_repository_write",
    authorityGeneration: 1,
    defaultBranchApprovalId: null,
    commitSha: "d".repeat(40),
    nextExpectedParentSha: "d".repeat(40),
    providerRequestId: "REQ-REPOSITORY-WRITE",
    requestSha256: `sha256:${"b".repeat(64)}`,
    verifiedAt: "2026-08-03T10:00:03.000Z",
    authorizesRetry: false,
  };
}
