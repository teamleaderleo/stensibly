import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-receipt-admission";
import type {
  GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "repository-write-transition-source-secret";
const reserveRef = makeFunctionReference<"mutation">(
  "githubRepositoryWrites:reserve",
);
const transitionRef = makeFunctionReference<"mutation">(
  "githubRepositoryWrites:transition",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted repository-write transition source states", () => {
  test("cannot relabel an ambiguous provider effect as rejected or release its lane", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const initial = receipt();
    await t.mutation(reserveRef, reserveArgs(initial));

    const dispatched = receipt({ dispatchCount: 1 });
    const pending = receipt({
      state: "pending_reconciliation",
      dispatchCount: 1,
      updatedAt: "2026-08-03T12:00:01.000Z",
      error: {
        code: "repository_write_provider_outcome_ambiguous",
        retry: "reconcile_before_retry",
      },
    });
    await t.mutation(transitionRef, transitionArgs({
      action: "hold_for_reconciliation",
      current: dispatched,
      next: pending,
    }));

    const forgedRejection = receipt({
      state: "rejected",
      dispatchCount: 1,
      updatedAt: "2026-08-03T12:00:02.000Z",
      error: {
        code: "repository_write_rejected_after_ambiguity",
        retry: "do_not_retry",
      },
    });
    await expect(t.mutation(transitionRef, transitionArgs({
      action: "reject_and_release",
      current: pending,
      next: forgedRejection,
    }))).rejects.toThrow("GITHUB_REPOSITORY_WRITE_TRANSITION_SOURCE_INVALID");

    const blocked = await t.mutation(reserveRef, reserveArgs(receipt({
      id: "ghrw_after_ambiguous_rejection_attempt",
      idempotencyKey: "after-ambiguous-rejection-attempt",
      requestSha256: hash("d"),
      createdAt: "2026-08-03T12:00:03.000Z",
      updatedAt: "2026-08-03T12:00:03.000Z",
    }))) as { outcome: string; receiptJson: string };
    expect(blocked.outcome).toBe("blocked");
    expect(JSON.parse(blocked.receiptJson)).toMatchObject({
      state: "pending_reconciliation",
      dispatchCount: 1,
      idempotencyKey: initial.idempotencyKey,
    });
  });

  test("cannot invent provider ambiguity before dispatch", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const initial = receipt({ idempotencyKey: "undispatched-source" });
    await t.mutation(reserveRef, reserveArgs(initial));

    const inventedPending = receipt({
      idempotencyKey: initial.idempotencyKey,
      state: "pending_reconciliation",
      dispatchCount: 0,
      updatedAt: "2026-08-03T12:00:01.000Z",
      error: {
        code: "repository_write_provider_outcome_ambiguous",
        retry: "reconcile_before_retry",
      },
    });
    await expect(t.mutation(transitionRef, transitionArgs({
      action: "hold_for_reconciliation",
      current: initial,
      next: inventedPending,
    }))).rejects.toThrow("GITHUB_REPOSITORY_WRITE_TRANSITION_SOURCE_INVALID");

    const blocked = await t.mutation(reserveRef, reserveArgs(receipt({
      id: "ghrw_after_undispatched_hold_attempt",
      idempotencyKey: "after-undispatched-hold-attempt",
      requestSha256: hash("e"),
      createdAt: "2026-08-03T12:00:02.000Z",
      updatedAt: "2026-08-03T12:00:02.000Z",
    }))) as { outcome: string; receiptJson: string };
    expect(blocked.outcome).toBe("blocked");
    expect(JSON.parse(blocked.receiptJson)).toMatchObject({
      state: "reserved",
      dispatchCount: 0,
      idempotencyKey: initial.idempotencyKey,
    });
  });
});

function receipt(
  overrides: Partial<GitHubRepositoryWriteReceipt> = {},
): GitHubRepositoryWriteReceipt {
  return admitGitHubRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_transition_source",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/transition-source",
    path: "docs/transition-source.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: hash("b"),
    payloadSha256: hash("c"),
    actorId: "actor_plover",
    clientId: "client_github_only",
    idempotencyKey: "transition-source",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
    verified: null,
    error: null,
    ...overrides,
  });
}

function reserveArgs(value: GitHubRepositoryWriteReceipt) {
  return scoped({
    project: value.project,
    receiptJson: canonicalGitHubRepositoryWriteReceiptJson(value),
  });
}

function transitionArgs(input: {
  action:
    | "reject_and_release"
    | "hold_for_reconciliation"
    | "record_verified"
    | "hold_verified_for_reconciliation"
    | "release_verified";
  current: GitHubRepositoryWriteReceipt;
  next: GitHubRepositoryWriteReceipt;
}) {
  return scoped({
    project: input.current.project,
    action: input.action,
    currentReceiptJson: canonicalGitHubRepositoryWriteReceiptJson(input.current),
    nextReceiptJson: canonicalGitHubRepositoryWriteReceiptJson(input.next),
  });
}

function scoped(input: Record<string, unknown>) {
  return {
    ...input,
    serviceSecret,
    workspace: "default",
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

async function seedProject(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx: any) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: "default",
      name: "Default",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("projects", {
      workspaceId,
      externalId: "project_stensibly",
      slug: "stensibly",
      name: "Stensibly",
      createdAt: 1,
      updatedAt: 1,
    });
  });
}
