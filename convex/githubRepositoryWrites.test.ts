import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexCaller } from "../src/convex-ledger";
import {
  ConvexGitHubRepositoryWriteStore,
} from "../src/github-repository-write-convex-store";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
  parseGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-receipt-admission";
import type {
  GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service";
import type { VerifiedRepositoryWrite } from "../src/repository-write-fence";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "repository-write-service-secret";
const reserveRef = makeFunctionReference<"mutation">(
  "githubRepositoryWrites:reserve",
);
const transitionRef = makeFunctionReference<"mutation">(
  "githubRepositoryWrites:transition",
);
const getRef = makeFunctionReference<"query">("githubRepositoryWrites:get");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted GitHub repository write receipts and ref lanes", () => {
  test("reserves, replays, conflicts, blocks one ref, and permits another ref", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt();

    const first = await t.mutation(reserveRef, reserveArgs(input)) as any;
    expect(first.outcome).toBe("reserved");
    expect(parseGitHubRepositoryWriteReceiptJson(first.receiptJson)).toEqual(input);

    const replayCandidate = receipt({
      id: "ghrw_replay_candidate",
      createdAt: "2026-08-03T10:01:00.000Z",
      updatedAt: "2026-08-03T10:01:00.000Z",
    });
    const replay = await t.mutation(
      reserveRef,
      reserveArgs(replayCandidate),
    ) as any;
    expect(replay.outcome).toBe("replay");
    expect(parseGitHubRepositoryWriteReceiptJson(replay.receiptJson)).toEqual(input);

    const conflict = await t.mutation(reserveRef, reserveArgs(receipt({
      id: "ghrw_conflict_candidate",
      path: "docs/other.md",
      requestSha256: `sha256:${"e".repeat(64)}`,
      createdAt: "2026-08-03T10:02:00.000Z",
      updatedAt: "2026-08-03T10:02:00.000Z",
    }))) as any;
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.receiptJson).toBe(first.receiptJson);

    const blockedCandidate = receipt({
      id: "ghrw_blocked_candidate",
      idempotencyKey: "repository-write-blocked",
      requestSha256: `sha256:${"f".repeat(64)}`,
      createdAt: "2026-08-03T10:03:00.000Z",
      updatedAt: "2026-08-03T10:03:00.000Z",
    });
    const blocked = await t.mutation(
      reserveRef,
      reserveArgs(blockedCandidate),
    ) as any;
    expect(blocked.outcome).toBe("blocked");
    expect(parseGitHubRepositoryWriteReceiptJson(blocked.receiptJson)).toEqual(input);

    const parallel = receipt({
      id: "ghrw_parallel_ref",
      idempotencyKey: "repository-write-parallel",
      targetRef: "feature/parallel-ref",
      requestSha256: `sha256:${"1".repeat(64)}`,
      createdAt: "2026-08-03T10:04:00.000Z",
      updatedAt: "2026-08-03T10:04:00.000Z",
    });
    expect((await t.mutation(reserveRef, reserveArgs(parallel)) as any).outcome)
      .toBe("reserved");

    const rows = await t.run(async (ctx: any) => ({
      receipts: await ctx.db.query("githubRepositoryWriteReceipts").collect(),
      lanes: await ctx.db.query("githubRepositoryWriteLanes").collect(),
    }));
    expect(rows.receipts).toHaveLength(2);
    expect(rows.lanes).toHaveLength(2);
  });

  test("serializes concurrent different-key reservations on one ref", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const first = receipt({
      id: "ghrw_concurrent_a",
      idempotencyKey: "concurrent-a",
      requestSha256: `sha256:${"2".repeat(64)}`,
    });
    const second = receipt({
      id: "ghrw_concurrent_b",
      idempotencyKey: "concurrent-b",
      requestSha256: `sha256:${"3".repeat(64)}`,
    });

    const results = await Promise.all([
      t.mutation(reserveRef, reserveArgs(first)),
      t.mutation(reserveRef, reserveArgs(second)),
    ]) as any[];
    expect(results.map((entry) => entry.outcome).sort()).toEqual([
      "blocked",
      "reserved",
    ]);
    const rows = await t.run(async (ctx: any) => ({
      receipts: await ctx.db.query("githubRepositoryWriteReceipts").collect(),
      lanes: await ctx.db.query("githubRepositoryWriteLanes").collect(),
    }));
    expect(rows.receipts).toHaveLength(1);
    expect(rows.lanes).toHaveLength(1);
  });

  test("holds the lane through ambiguity and verified settlement, then releases", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const store = new ConvexGitHubRepositoryWriteStore({
      client: convexCaller(t),
      serviceSecret,
    });
    const input = receipt();
    const reserved = await store.reserveRepositoryWrite(input);
    expect(reserved.outcome).toBe("reserved");

    const dispatched = receipt({ dispatchCount: 1 });
    const pending = await store.holdRepositoryWriteForReconciliation({
      receipt: dispatched,
      code: "repository_write_provider_outcome_ambiguous",
      heldAt: "2026-08-03T10:00:01.000Z",
    });
    expect(pending.state).toBe("pending_reconciliation");

    const blockedCandidate = receipt({
      id: "ghrw_held_blocked",
      idempotencyKey: "held-blocked",
      requestSha256: `sha256:${"4".repeat(64)}`,
      createdAt: "2026-08-03T10:00:02.000Z",
      updatedAt: "2026-08-03T10:00:02.000Z",
    });
    expect((await store.reserveRepositoryWrite(blockedCandidate)).outcome)
      .toBe("blocked");

    const verifiedReceipt = await store.recordVerifiedRepositoryWrite({
      receipt: pending,
      verified: verification(),
    });
    expect(verifiedReceipt.state).toBe("verified_pending_release");
    expect((await store.reserveRepositoryWrite(blockedCandidate)).outcome)
      .toBe("blocked");

    const succeeded = await store.releaseVerifiedRepositoryWrite({
      receipt: verifiedReceipt,
      releasedAt: "2026-08-03T10:00:04.000Z",
    });
    expect(succeeded.state).toBe("succeeded");
    expect((await store.reserveRepositoryWrite(blockedCandidate)).outcome)
      .toBe("reserved");
  });

  test("reject releases the lane immediately", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const store = new ConvexGitHubRepositoryWriteStore({
      client: convexCaller(t),
      serviceSecret,
    });
    const input = receipt({ idempotencyKey: "reject-a" });
    await store.reserveRepositoryWrite(input);
    const rejected = await store.rejectAndReleaseRepositoryWrite({
      receipt: input,
      code: "repository_write_authority_changed",
      rejectedAt: "2026-08-03T10:00:01.000Z",
    });
    expect(rejected.state).toBe("rejected");

    const next = receipt({
      id: "ghrw_after_reject",
      idempotencyKey: "reject-b",
      requestSha256: `sha256:${"5".repeat(64)}`,
      createdAt: "2026-08-03T10:00:02.000Z",
      updatedAt: "2026-08-03T10:00:02.000Z",
    });
    expect((await store.reserveRepositoryWrite(next)).outcome).toBe("reserved");
  });

  test("rejects stale or action-inconsistent transitions", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt({ idempotencyKey: "stale-transition" });
    await t.mutation(reserveRef, reserveArgs(input));

    const staleCurrent = receipt({
      ...input,
      updatedAt: "2026-08-03T10:00:01.000Z",
    });
    const proposed = receipt({
      ...input,
      state: "pending_reconciliation",
      dispatchCount: 1,
      updatedAt: "2026-08-03T10:00:02.000Z",
      error: {
        code: "repository_write_provider_outcome_ambiguous",
        retry: "reconcile_before_retry",
      },
    });
    await expect(t.mutation(transitionRef, transitionArgs({
      action: "hold_for_reconciliation",
      current: staleCurrent,
      next: proposed,
    }))).rejects.toThrow("GITHUB_REPOSITORY_WRITE_STALE_TRANSITION");

    await expect(t.mutation(transitionRef, transitionArgs({
      action: "reject_and_release",
      current: input,
      next: proposed,
    }))).rejects.toThrow("GITHUB_REPOSITORY_WRITE_TRANSITION_INVALID");
  });

  test("survives reconnect and isolates projects", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    await seedProject(t, "other-project");
    const first = new ConvexGitHubRepositoryWriteStore({
      client: convexCaller(t),
      serviceSecret,
    });
    const input = receipt({ idempotencyKey: "reconnect-write" });
    expect((await first.reserveRepositoryWrite(input)).outcome).toBe("reserved");

    const second = new ConvexGitHubRepositoryWriteStore({
      client: convexCaller(t),
      serviceSecret,
    });
    expect(await second.getRepositoryWriteReceipt(
      "stensibly",
      input.idempotencyKey,
    )).toEqual(input);
    expect(await second.getRepositoryWriteReceipt(
      "other-project",
      input.idempotencyKey,
    )).toBeNull();
  });

  test("fails closed on receipt or lane corruption", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt({ idempotencyKey: "corruption-write" });
    await t.mutation(reserveRef, reserveArgs(input));
    await t.run(async (ctx: any) => {
      const boundProjectId = await projectId(ctx, "stensibly");
      const receiptRow = await ctx.db
        .query("githubRepositoryWriteReceipts")
        .withIndex("by_project_external", (q: any) =>
          q.eq("projectId", boundProjectId).eq("externalId", input.id)
        )
        .unique();
      await ctx.db.patch(receiptRow._id, {
        receiptSha256: `sha256:${"f".repeat(64)}`,
      });
    });
    await expect(t.query(getRef, queryArgs({
      project: "stensibly",
      idempotencyKey: input.idempotencyKey,
    }))).rejects.toThrow("GITHUB_REPOSITORY_WRITE_STORED_ROW_INVALID");

    const fresh = receipt({
      id: "ghrw_lane_corruption",
      idempotencyKey: "lane-corruption",
      targetRef: "feature/lane-corruption",
      requestSha256: `sha256:${"6".repeat(64)}`,
    });
    await t.mutation(reserveRef, reserveArgs(fresh));
    await t.run(async (ctx: any) => {
      const boundProjectId = await projectId(ctx, "stensibly");
      const lane = await ctx.db
        .query("githubRepositoryWriteLanes")
        .withIndex("by_project_ref", (q: any) =>
          q.eq("projectId", boundProjectId)
            .eq("repositoryFullName", fresh.repositoryFullName)
            .eq("targetRef", fresh.targetRef)
        )
        .unique();
      await ctx.db.patch(lane._id, {
        expectedParentSha: "9".repeat(40),
      });
    });
    const blocker = receipt({
      id: "ghrw_lane_corruption_blocker",
      idempotencyKey: "lane-corruption-blocker",
      targetRef: fresh.targetRef,
      requestSha256: `sha256:${"7".repeat(64)}`,
    });
    await expect(t.mutation(reserveRef, reserveArgs(blocker))).rejects.toThrow(
      "GITHUB_REPOSITORY_WRITE_LANE_INVALID",
    );
  });
});

function receipt(
  overrides: Partial<GitHubRepositoryWriteReceipt> = {},
): GitHubRepositoryWriteReceipt {
  return admitGitHubRepositoryWriteReceipt({
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

function verification(): VerifiedRepositoryWrite {
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

function reserveArgs(value: GitHubRepositoryWriteReceipt) {
  return queryArgs({
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
  return queryArgs({
    project: input.current.project,
    action: input.action,
    currentReceiptJson: canonicalGitHubRepositoryWriteReceiptJson(input.current),
    nextReceiptJson: canonicalGitHubRepositoryWriteReceiptJson(input.next),
  });
}

function queryArgs(input: Record<string, unknown>) {
  return {
    ...input,
    serviceSecret,
    workspace: "default",
  };
}

function convexCaller(t: ReturnType<typeof convexTest>): ConvexCaller {
  return {
    query: async (reference, args) => await t.query(reference, args),
    mutation: async (reference, args) => await t.mutation(reference, args),
  };
}

async function seedProject(
  t: ReturnType<typeof convexTest>,
  slug: string,
): Promise<void> {
  await t.run(async (ctx: any) => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", "default"))
      .unique();
    const workspaceId = workspace?._id ?? await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: "default",
      name: "Default",
      createdAt: 1,
      updatedAt: 1,
    });
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("slug", slug)
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("projects", {
        workspaceId,
        externalId: `project_${slug}`,
        slug,
        name: slug,
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
}

async function projectId(ctx: any, slug: string) {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q: any) => q.eq("slug", "default"))
    .unique();
  const project = await ctx.db
    .query("projects")
    .withIndex("by_workspace_slug", (q: any) =>
      q.eq("workspaceId", workspace._id).eq("slug", slug)
    )
    .unique();
  return project._id;
}
