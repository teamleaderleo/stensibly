import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "./_generated/dataModel";
import { dispatchHostedExactGeneration } from "./lib/exactDispatch";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const supervisor = {
  id: "service:hosted-exact-dispatch",
  name: "Hosted Exact Dispatch",
  kind: "service" as const,
};
const runner = {
  id: "agent:hosted-exact-runner",
  name: "Hosted Exact Runner",
  kind: "agent" as const,
};
const executionEnvelope = {
  schemaVersion: 1 as const,
  objective: "Execute one exact hosted work generation",
  scopeClass: "atomic" as const,
  estimate: { lowMinutes: 5, likelyMinutes: 10, highMinutes: 20, confidence: 0.8 },
  budget: { expectedMessages: 2, expectedToolCalls: 6, expectedReviewMinutes: 2 },
  boundaries: { softCheckpointMinutes: 10, forcedHandoffMinutes: 20, hardRecoveryMinutes: 30 },
  completion: {
    requiredOutputs: ["result"],
    verificationRequired: true,
    continuationStateRequired: false,
    acceptanceChecks: ["exact generation consumed once"],
  },
  durableState: {
    accessClass: "project" as const,
    retentionClass: "standard" as const,
    redactionRequired: true,
    deleteAfter: null,
  },
};

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted exact-generation dispatch", () => {
  test("reserves generation zero as one and runner pickup does not advance it again", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seed(t, "Reserve hosted generation zero");
    const outcome = await dispatch(t, fixture, 0, Date.now());

    expect(outcome.status).toBe("dispatched");
    if (outcome.status !== "dispatched") throw new Error("expected dispatch");
    expect(outcome).toMatchObject({
      expectedClaimGeneration: 0,
      claimedGeneration: 1,
      item: {
        externalId: fixture.item.externalId,
        status: "active",
        claimGeneration: 1,
        claimedByExternalId: supervisor.id,
      },
      run: {
        status: "queued",
        generation: 1,
        leaseGeneration: 1,
        actorExternalId: supervisor.id,
      },
    });

    const claimed = await t.mutation(convexApi.runnerRuns.claim, {
      serviceSecret: secret,
      workspace,
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runId: outcome.run.externalId,
      externalRunId: "hosted-exact-runner-session",
      leaseSeconds: 900,
      idempotencyKey: "hosted-exact-runner-pickup",
      concurrency: { globalLimit: 4, projectLimit: 2 },
    }) as any;
    expect(claimed).toMatchObject({ id: outcome.run.externalId, status: "starting" });

    const itemAfterPickup = await itemState(t, fixture.item._id);
    expect(itemAfterPickup).toMatchObject({
      status: "active",
      claimGeneration: 1,
      claimedByExternalId: runner.id,
    });
  });

  test("returns stale generation without reserving a later ready incarnation", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seed(t, "Fence stale hosted generation");
    const claimed = await t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret,
      workspace,
      id: fixture.item.externalId,
      actor: supervisor,
      leaseSeconds: 900,
    }) as any;
    await t.mutation(convexApi.claims.release, {
      serviceSecret: secret,
      workspace,
      id: fixture.item.externalId,
      actor: supervisor,
      expectedClaimGeneration: claimed.claimGeneration,
    });

    expect(await dispatch(t, fixture, 0, Date.now())).toEqual({
      status: "stale_generation",
      expectedClaimGeneration: 0,
      currentClaimGeneration: 2,
    });
    expect(await runCount(t, fixture.item._id)).toBe(0);
  });

  test("does not duplicate a work item that already has a live queued run", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seed(t, "Reject duplicate hosted dispatch");
    const now = Date.now();
    expect((await dispatch(t, fixture, 0, now)).status).toBe("dispatched");
    expect(await dispatch(t, fixture, 1, now + 1)).toEqual({
      status: "unavailable",
      expectedClaimGeneration: 1,
    });
    expect(await runCount(t, fixture.item._id)).toBe(1);
  });

  test("a later failure in the same Convex transaction restores the exact reservation baseline", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seed(t, "Roll back hosted exact dispatch");
    const before = await itemState(t, fixture.item._id);

    await expect(t.run(async (ctx) => {
      const outcome = await dispatchHostedExactGeneration(ctx, {
        workspaceId: fixture.workspaceId,
        itemId: fixture.item._id,
        actor: fixture.actor,
        expectedClaimGeneration: 0,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: null,
        leaseSeconds: 900,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        executionEnvelope,
        eventSource: "hosted_exact_dispatch_test",
        sourceEvidence: { receiptWillFail: true },
        now: Date.now(),
      });
      expect(outcome.status).toBe("dispatched");
      throw new Error("forced post-dispatch receipt failure");
    })).rejects.toThrow("forced post-dispatch receipt failure");

    const after = await itemState(t, fixture.item._id);
    expect(after).toMatchObject({
      status: before!.status,
      claimGeneration: before!.claimGeneration,
      claimedByActorId: before!.claimedByActorId,
      claimedByExternalId: before!.claimedByExternalId,
      claimExpiresAt: before!.claimExpiresAt,
      version: before!.version,
      updatedAt: before!.updatedAt,
    });
    expect(await runCount(t, fixture.item._id)).toBe(0);
    const events = await t.run(async (ctx) =>
      (await ctx.db.query("events").collect()).filter((event) => event.itemId === fixture.item._id)
    );
    expect(events.filter((event) => event.type === "claim.created")).toHaveLength(0);
    expect(events.filter((event) => event.type === "run.queued")).toHaveLength(0);
  });
});

async function dispatch(
  t: ReturnType<typeof convexTest>,
  fixture: Awaited<ReturnType<typeof seed>>,
  expectedClaimGeneration: number,
  now: number,
) {
  return await t.run(async (ctx) =>
    await dispatchHostedExactGeneration(ctx, {
      workspaceId: fixture.workspaceId,
      itemId: fixture.item._id,
      actor: fixture.actor,
      expectedClaimGeneration,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: null,
      leaseSeconds: 900,
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      executionEnvelope,
      eventSource: "hosted_exact_dispatch_test",
      now,
    })
  );
}

async function seed(t: ReturnType<typeof convexTest>, title: string) {
  const item = await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project: "hosted-exact-dispatch",
    kind: "task",
    title,
    nextAction: `Execute ${title}.`,
    priority: 80,
    actor: supervisor,
  }) as any;
  return await t.run(async (ctx) => {
    const workspaceRow = (await ctx.db.query("workspaces").collect())
      .find((entry) => entry.slug === workspace);
    const itemRow = (await ctx.db.query("items").collect())
      .find((entry) => entry.externalId === item.id);
    const actorRow = (await ctx.db.query("actors").collect())
      .find((entry) => entry.externalId === supervisor.id);
    if (!workspaceRow || !itemRow || !actorRow) throw new Error("Hosted exact dispatch fixture disappeared");
    return {
      workspaceId: workspaceRow._id,
      item: itemRow,
      actor: actorRow,
    } as {
      workspaceId: typeof workspaceRow._id;
      item: Doc<"items">;
      actor: Doc<"actors">;
    };
  });
}

async function itemState(t: ReturnType<typeof convexTest>, itemId: Doc<"items">["_id"]) {
  return await t.run(async (ctx) => await ctx.db.get("items", itemId));
}

async function runCount(t: ReturnType<typeof convexTest>, itemId: Doc<"items">["_id"]) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("queuedRuns").collect()).filter((run) => run.itemId === itemId).length
  );
}
