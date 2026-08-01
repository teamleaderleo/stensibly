import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexCaller } from "../src/convex-ledger";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts";
import {
  canonicalGitHubProviderReceiptJson,
  parseGitHubProviderReceiptJson,
} from "../src/github-provider-receipt-admission";
import {
  ConvexGitHubProviderReceiptStore,
  withConvexGitHubProviderReceiptStore,
} from "../src/github-provider-receipt-convex-ledger";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-provider-receipt-service-secret";
const reserveRef = makeFunctionReference<"mutation">(
  "githubProviderReceipts:reserve",
);
const updateRef = makeFunctionReference<"mutation">(
  "githubProviderReceipts:update",
);
const getRef = makeFunctionReference<"query">("githubProviderReceipts:get");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted GitHub provider receipts", () => {
  test("reserves once, projects interrupted replay, and conflicts altered reuse", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt();

    const first = await t.mutation(reserveRef, reserveArgs(input)) as any;
    expect(first.outcome).toBe("reserved");
    expect(parseGitHubProviderReceiptJson(first.receiptJson)).toEqual(input);

    const replay = await t.mutation(reserveRef, reserveArgs(input)) as any;
    expect(replay.outcome).toBe("replay");
    expect(parseGitHubProviderReceiptJson(replay.receiptJson)).toMatchObject({
      state: "pending_reconciliation",
      error: {
        code: "provider_dispatch_in_progress_or_interrupted",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    });

    const stableReplay = await t.mutation(reserveRef, reserveArgs(input)) as any;
    expect(stableReplay).toEqual(replay);

    const conflict = await t.mutation(reserveRef, reserveArgs(receipt({
      parametersSha256: `sha256:${"c".repeat(64)}`,
    }))) as any;
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.receiptJson).toBe(replay.receiptJson);
  });

  test("serializes concurrent reserve attempts to one canonical row", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt({ idempotencyKey: "concurrent-reserve-1" });
    const results = await Promise.all([
      t.mutation(reserveRef, reserveArgs(input)),
      t.mutation(reserveRef, reserveArgs(input)),
    ]) as any[];
    expect(results.map((entry) => entry.outcome).sort()).toEqual([
      "replay",
      "reserved",
    ]);
    const rows = await t.run(async (ctx: any) =>
      await ctx.db.query("githubProviderReceipts").collect()
    );
    expect(rows).toHaveLength(1);
  });

  test("requires reservation and immutable identity before update", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt({ idempotencyKey: "update-1" });
    const terminal = receipt({
      idempotencyKey: "update-1",
      state: "rejected",
      updatedAt: "2026-08-02T00:00:01.000Z",
      error: {
        code: "provider_rejected",
        message: "GitHub rejected the bounded request",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "inspect_authority_or_provider_rejection" },
    });

    await expect(t.mutation(updateRef, updateArgs(terminal))).rejects.toThrow(
      "GITHUB_PROVIDER_RECEIPT_NOT_RESERVED",
    );
    await t.mutation(reserveRef, reserveArgs(input));
    await expect(t.mutation(updateRef, updateArgs({
      ...terminal,
      id: "ghop_other",
    }))).rejects.toThrow(
      "GITHUB_PROVIDER_RECEIPT_UPDATE_IDENTITY_MISMATCH",
    );
    const updatedJson = await t.mutation(updateRef, updateArgs(terminal));
    expect(parseGitHubProviderReceiptJson(updatedJson as string)).toEqual(terminal);
  });

  test("survives reconnect through a fresh adapter and isolates projects", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    await seedProject(t, "other-project");
    const client = convexCaller(t);
    const first = new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret,
    });
    const input = receipt({ idempotencyKey: "reconnect-1" });
    expect((await first.reserveGitHubProviderReceipt(input)).outcome)
      .toBe("reserved");

    const second = new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret,
    });
    const recovered = await second.getGitHubProviderReceipt(
      "stensibly",
      "reconnect-1",
    );
    expect(recovered).toEqual(input);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(await second.getGitHubProviderReceipt(
      "other-project",
      "reconnect-1",
    )).toBeNull();

    const target = { kind: "ledger" };
    const composed = withConvexGitHubProviderReceiptStore(target, {
      client,
      serviceSecret,
    });
    expect(Object.is(composed, target)).toBe(true);
    const other = receipt({
      project: "other-project",
      id: "ghop_other_project",
      idempotencyKey: "reconnect-1",
    });
    expect((await composed.reserveGitHubProviderReceipt(other)).outcome)
      .toBe("reserved");
    expect(await composed.getGitHubProviderReceipt(
      "other-project",
      "reconnect-1",
    )).toEqual(other);
  });

  test("fails closed when durable identity or digest is corrupted", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "stensibly");
    const input = receipt({ idempotencyKey: "corruption-1" });
    await t.mutation(reserveRef, reserveArgs(input));
    await t.run(async (ctx: any) => {
      const row = await ctx.db
        .query("githubProviderReceipts")
        .withIndex("by_project_external", (q: any) =>
          q.eq("projectId", await projectId(ctx, "stensibly"))
            .eq("externalId", input.id)
        )
        .unique();
      await ctx.db.patch(row._id, {
        receiptSha256: `sha256:${"f".repeat(64)}`,
      });
    });
    await expect(t.query(getRef, queryArgs({
      project: "stensibly",
      idempotencyKey: "corruption-1",
    }))).rejects.toThrow("GITHUB_PROVIDER_RECEIPT_STORED_ROW_INVALID");
  });
});

function receipt(
  override: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return parseGitHubProviderReceiptJson(canonicalGitHubProviderReceiptJson({
    version: 1,
    id: "ghop_receipt_1",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_add_issue_comment",
    target: "teamleaderleo/stensibly#928:comment:new",
    actorId: "actor_juniper",
    clientId: "client_github_only",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-receipt-1",
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "reserved",
    attemptCount: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    providerRequestId: null,
    result: null,
    verification: {
      state: "not_run",
      checkedAt: null,
      sourceRevision: null,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...override,
  }));
}

function reserveArgs(value: GitHubProviderReceipt) {
  return queryArgs({
    project: value.project,
    receiptJson: canonicalGitHubProviderReceiptJson(value),
  });
}

function updateArgs(value: GitHubProviderReceipt) {
  return reserveArgs(value);
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
