import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
  fingerprintGitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-receipt-admission";
import type {
  GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "repository-write-external-corruption-secret";
const conflict = "GITHUB_REPOSITORY_WRITE_EXTERNAL_ID_CONFLICT";
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

describe("hosted repository-write external ID corruption admission", () => {
  test("rejects both receipt lookups, replay, and blocked-owner resolution", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const active = receipt();
    await t.mutation(reserveRef, reserveArgs(active));
    const [terminal] = await insertDuplicateTerminalReceipts(t, active, 1);
    if (!terminal) throw new Error("expected terminal duplicate");

    await expect(t.mutation(reserveRef, reserveArgs(active))).rejects.toThrow(
      conflict,
    );
    for (const idempotencyKey of [
      active.idempotencyKey,
      terminal.idempotencyKey,
    ]) {
      await expect(t.query(getRef, scoped({
        project: active.project,
        idempotencyKey,
      }))).rejects.toThrow(conflict);
    }

    const blocked = receipt({
      id: "ghrw_external_corruption_blocked",
      idempotencyKey: "external-corruption-blocked",
      requestSha256: hash("f"),
      createdAt: "2026-08-03T18:00:03.000Z",
      updatedAt: "2026-08-03T18:00:03.000Z",
    });
    await expect(t.mutation(reserveRef, reserveArgs(blocked))).rejects.toThrow(
      conflict,
    );
  });

  test("rejects transition without mutating the active receipt or lane", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const active = receipt();
    await t.mutation(reserveRef, reserveArgs(active));
    await insertDuplicateTerminalReceipts(t, active, 1);

    await expect(t.mutation(
      transitionRef,
      transitionArgs(active),
    )).rejects.toThrow(conflict);

    const rows = await t.run(async (ctx: any) => {
      const projectId = await boundProjectId(ctx);
      const stored = await ctx.db
        .query("githubRepositoryWriteReceipts")
        .withIndex("by_project_idempotency", (q: any) =>
          q.eq("projectId", projectId)
            .eq("idempotencyKey", active.idempotencyKey)
        )
        .unique();
      const lane = await ctx.db
        .query("githubRepositoryWriteLanes")
        .withIndex("by_project_ref", (q: any) =>
          q.eq("projectId", projectId)
            .eq("repositoryFullName", active.repositoryFullName)
            .eq("targetRef", active.targetRef)
        )
        .unique();
      return { stored, lane };
    });
    expect(JSON.parse(rows.stored.receiptJson)).toMatchObject({
      state: "reserved",
      dispatchCount: 0,
    });
    expect(rows.lane.ownerReceiptExternalId).toBe(active.id);
  });

  test("fails closed with more than two duplicate external owners", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const active = receipt();
    await t.mutation(reserveRef, reserveArgs(active));
    await insertDuplicateTerminalReceipts(t, active, 3);

    await expect(t.mutation(reserveRef, reserveArgs(active))).rejects.toThrow(
      conflict,
    );
    await expect(t.query(getRef, scoped({
      project: active.project,
      idempotencyKey: active.idempotencyKey,
    }))).rejects.toThrow(conflict);
    await expect(t.mutation(
      transitionRef,
      transitionArgs(active),
    )).rejects.toThrow(conflict);
  });
});

function receipt(
  overrides: Partial<GitHubRepositoryWriteReceipt> = {},
): GitHubRepositoryWriteReceipt {
  return admitGitHubRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_external_corruption",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/external-corruption",
    path: "docs/external-corruption.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: hash("b"),
    payloadSha256: hash("c"),
    actorId: "actor_kite",
    clientId: "client_github_only",
    idempotencyKey: "external-corruption-active",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T18:00:00.000Z",
    updatedAt: "2026-08-03T18:00:00.000Z",
    verified: null,
    error: null,
    ...overrides,
  });
}

function duplicateTerminalReceipt(
  active: GitHubRepositoryWriteReceipt,
  index: number,
): GitHubRepositoryWriteReceipt {
  const suffix = index + 1;
  const requestCharacter = (index + 4).toString(16);
  const payloadCharacter = (index + 8).toString(16);
  const timestamp = new Date(
    Date.parse("2026-08-03T18:00:02.000Z") + index * 1_000,
  ).toISOString();
  return receipt({
    id: active.id,
    idempotencyKey: `external-corruption-terminal-${suffix}`,
    targetRef: `feature/external-corruption-terminal-${suffix}`,
    path: `docs/external-corruption-terminal-${suffix}.md`,
    requestSha256: hash(requestCharacter),
    payloadSha256: hash(payloadCharacter),
    state: "rejected",
    dispatchCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    error: {
      code: "repository_write_pre_dispatch_rejected",
      retry: "do_not_retry",
    },
  });
}

async function insertDuplicateTerminalReceipts(
  t: ReturnType<typeof convexTest>,
  active: GitHubRepositoryWriteReceipt,
  count: number,
): Promise<GitHubRepositoryWriteReceipt[]> {
  const duplicates = Array.from(
    { length: count },
    (_, index) => duplicateTerminalReceipt(active, index),
  );
  await t.run(async (ctx: any) => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", "default"))
      .unique();
    const projectId = await boundProjectId(ctx);
    for (const duplicate of duplicates) {
      await ctx.db.insert("githubRepositoryWriteReceipts", {
        workspaceId: workspace._id,
        projectId,
        externalId: duplicate.id,
        idempotencyKey: duplicate.idempotencyKey,
        repositoryFullName: duplicate.repositoryFullName,
        targetRef: duplicate.targetRef,
        state: duplicate.state,
        receiptJson: canonicalGitHubRepositoryWriteReceiptJson(duplicate),
        receiptSha256: fingerprintGitHubRepositoryWriteReceipt(duplicate),
        createdAt: Date.parse(duplicate.createdAt),
        updatedAt: Date.parse(duplicate.updatedAt),
      });
    }
  });
  return duplicates;
}

function transitionArgs(active: GitHubRepositoryWriteReceipt) {
  const dispatched = receipt({ dispatchCount: 1 });
  const pending = receipt({
    state: "pending_reconciliation",
    dispatchCount: 1,
    updatedAt: "2026-08-03T18:00:01.000Z",
    error: {
      code: "repository_write_provider_outcome_ambiguous",
      retry: "reconcile_before_retry",
    },
  });
  return scoped({
    project: active.project,
    action: "hold_for_reconciliation",
    currentReceiptJson: canonicalGitHubRepositoryWriteReceiptJson(dispatched),
    nextReceiptJson: canonicalGitHubRepositoryWriteReceiptJson(pending),
  });
}

function reserveArgs(value: GitHubRepositoryWriteReceipt) {
  return scoped({
    project: value.project,
    receiptJson: canonicalGitHubRepositoryWriteReceiptJson(value),
  });
}

function scoped(input: Record<string, unknown>) {
  return {
    ...input,
    serviceSecret,
    workspace: "default",
  };
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

async function boundProjectId(ctx: any) {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q: any) => q.eq("slug", "default"))
    .unique();
  const project = await ctx.db
    .query("projects")
    .withIndex("by_workspace_slug", (q: any) =>
      q.eq("workspaceId", workspace._id).eq("slug", "stensibly")
    )
    .unique();
  return project._id;
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
