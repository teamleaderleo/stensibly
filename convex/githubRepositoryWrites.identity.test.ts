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

const serviceSecret = "repository-write-identity-secret";
const reserveRef = makeFunctionReference<"mutation">(
  "githubRepositoryWrites:reserve",
);
const getRef = makeFunctionReference<"query">("githubRepositoryWrites:get");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted GitHub repository write receipt and lane identity", () => {
  test("rejects a reused receipt ID on a different idempotency key and ref", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const first = receipt({
      id: "ghrw_duplicate_external_id",
      idempotencyKey: "duplicate-external-a",
      targetRef: "feature/duplicate-a",
      requestSha256: hash("b"),
    });
    const second = receipt({
      id: first.id,
      idempotencyKey: "duplicate-external-b",
      targetRef: "feature/duplicate-b",
      requestSha256: hash("c"),
      createdAt: "2026-08-03T16:01:00.000Z",
      updatedAt: "2026-08-03T16:01:00.000Z",
    });

    expect((await t.mutation(reserveRef, reserveArgs(first)) as any).outcome)
      .toBe("reserved");
    await expect(t.mutation(reserveRef, reserveArgs(second))).rejects.toThrow(
      "GITHUB_REPOSITORY_WRITE_EXTERNAL_ID_CONFLICT",
    );

    const rows = await t.run(async (ctx: any) => ({
      receipts: await ctx.db.query("githubRepositoryWriteReceipts").collect(),
      lanes: await ctx.db.query("githubRepositoryWriteLanes").collect(),
    }));
    expect(rows.receipts).toHaveLength(1);
    expect(rows.lanes).toHaveLength(1);
  });

  test("rejects same-key replay when an active receipt lost its ref lane", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt({
      id: "ghrw_missing_lane_replay",
      idempotencyKey: "missing-lane-replay",
      targetRef: "feature/missing-lane-replay",
      requestSha256: hash("d"),
    });

    expect((await t.mutation(reserveRef, reserveArgs(input)) as any).outcome)
      .toBe("reserved");
    await deleteLane(t, input);

    await expect(t.mutation(reserveRef, reserveArgs(input))).rejects.toThrow(
      "GITHUB_REPOSITORY_WRITE_LANE_MISSING",
    );
  });

  test("rejects lookup when an active receipt lost its ref lane", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt({
      id: "ghrw_missing_lane_lookup",
      idempotencyKey: "missing-lane-lookup",
      targetRef: "feature/missing-lane-lookup",
      requestSha256: hash("e"),
    });

    expect((await t.mutation(reserveRef, reserveArgs(input)) as any).outcome)
      .toBe("reserved");
    await deleteLane(t, input);

    await expect(t.query(getRef, queryArgs({
      project: input.project,
      idempotencyKey: input.idempotencyKey,
    }))).rejects.toThrow("GITHUB_REPOSITORY_WRITE_LANE_MISSING");
  });
});

function receipt(
  overrides: Partial<GitHubRepositoryWriteReceipt> = {},
): GitHubRepositoryWriteReceipt {
  return admitGitHubRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_identity_receipt",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/identity-control",
    path: "docs/repository-write-identity.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: hash("b"),
    payloadSha256: hash("f"),
    actorId: "actor_rook",
    clientId: "client_github_only",
    idempotencyKey: "repository-write-identity",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T16:00:00.000Z",
    updatedAt: "2026-08-03T16:00:00.000Z",
    verified: null,
    error: null,
    ...overrides,
  });
}

function reserveArgs(value: GitHubRepositoryWriteReceipt) {
  return queryArgs({
    project: value.project,
    receiptJson: canonicalGitHubRepositoryWriteReceiptJson(value),
  });
}

function queryArgs(input: Record<string, unknown>) {
  return {
    ...input,
    serviceSecret,
    workspace: "default",
  };
}

async function deleteLane(
  t: ReturnType<typeof convexTest>,
  value: GitHubRepositoryWriteReceipt,
): Promise<void> {
  await t.run(async (ctx: any) => {
    const boundProjectId = await projectId(ctx, value.project);
    const lane = await ctx.db
      .query("githubRepositoryWriteLanes")
      .withIndex("by_project_ref", (q: any) =>
        q.eq("projectId", boundProjectId)
          .eq("repositoryFullName", value.repositoryFullName)
          .eq("targetRef", value.targetRef)
      )
      .unique();
    if (!lane) throw new Error("expected repository write lane");
    await ctx.db.delete(lane._id);
  });
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

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
