import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "agent:legacy-runner", name: "Legacy Runner", kind: "agent" as const };
const executionEnvelope = {
  schemaVersion: 1 as const,
  objective: "Do not retrofit the historical hosted run",
  scopeClass: "atomic" as const,
  estimate: {
    lowMinutes: 10,
    likelyMinutes: 20,
    highMinutes: 30,
    confidence: 0.7,
  },
  budget: {
    expectedMessages: 2,
    expectedToolCalls: 10,
    expectedReviewMinutes: 3,
  },
  boundaries: {
    softCheckpointMinutes: 25,
    forcedHandoffMinutes: 35,
    hardRecoveryMinutes: 45,
  },
  completion: {
    requiredOutputs: ["result"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["result is verified"],
  },
  durableState: {
    accessClass: "project" as const,
    retentionClass: "standard" as const,
    redactionRequired: true,
    deleteAfter: null,
  },
};

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex historical execution-envelope replay", () => {
  test("replays legacy start and finish without fabricating execution records", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      kind: "task",
      title: "Historical hosted run",
      nextAction: "Preserve explicit missing execution metadata.",
      priority: 70,
      actor,
    }) as any;
    const fixture = await insertLegacyRun(t, item.id);
    const startInput = {
      serviceSecret: secret,
      workspace,
      itemId: item.id,
      actor,
      harness: "legacy-harness",
      idempotencyKey: fixture.startKey,
    };

    const replayedStart = await t.mutation(convexApi.runs.start, startInput) as any;
    expect(replayedStart).toMatchObject({
      id: fixture.runId,
      executionEnvelope: null,
      executionRecords: [],
    });
    await expect(t.mutation(convexApi.runs.start, {
      ...startInput,
      executionEnvelope,
    })).rejects.toThrow("cannot be retrofitted with an execution envelope");

    await markLegacyRunFinished(t, fixture);
    const finishInput = {
      serviceSecret: secret,
      workspace,
      id: fixture.runId,
      actorId: actor.id,
      status: "succeeded" as const,
      outcome: "Historical completion.",
      idempotencyKey: fixture.finishKey,
    };
    const replayedFinish = await t.mutation(convexApi.runs.finish, finishInput) as any;
    expect(replayedFinish).toMatchObject({
      id: fixture.runId,
      status: "succeeded",
      executionEnvelope: null,
      executionRecords: [],
    });
    await expect(t.mutation(convexApi.runs.finish, {
      ...finishInput,
      executionActual: { toolCalls: 4 },
    })).rejects.toThrow("cannot be retrofitted with execution actuals");
  });
});

async function insertLegacyRun(
  t: ReturnType<typeof convexTest>,
  itemExternalId: string,
) {
  return await t.run(async (ctx: any) => {
    const workspaceRow = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspace))
      .unique();
    if (!workspaceRow) throw new Error("Test workspace missing");
    const item = await ctx.db
      .query("items")
      .withIndex("by_workspace_external", (q: any) =>
        q.eq("workspaceId", workspaceRow._id).eq("externalId", itemExternalId)
      )
      .unique();
    const actorRow = await ctx.db
      .query("actors")
      .withIndex("by_workspace_external", (q: any) =>
        q.eq("workspaceId", workspaceRow._id).eq("externalId", actor.id)
      )
      .unique();
    if (!item || !actorRow) throw new Error("Legacy run fixture is incomplete");
    const startedAt = Date.parse("2026-07-26T12:00:00.000Z");
    const runDbId = await ctx.db.insert("runs", {
      workspaceId: workspaceRow._id,
      projectId: item.projectId,
      itemId: item._id,
      externalId: "pending",
      actorId: actorRow._id,
      actorExternalId: actor.id,
      harness: "legacy-harness",
      status: "running",
      startedAt,
      lastHeartbeatAt: startedAt,
    });
    const runId = `run_${runDbId}`;
    await ctx.db.patch(runDbId, { externalId: runId });
    const startKey = "legacy-hosted-run-start";
    const eventDbId = await ctx.db.insert("events", {
      workspaceId: workspaceRow._id,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actorRow._id,
      actorExternalId: actor.id,
      externalId: "pending",
      type: "run.started",
      payload: { runId, harness: "legacy-harness" },
      idempotencyKey: startKey,
      createdAt: startedAt,
    });
    await ctx.db.patch(eventDbId, { externalId: `evt_${eventDbId}` });
    return {
      runDbId,
      runId,
      itemDbId: item._id,
      workspaceDbId: workspaceRow._id,
      projectDbId: item.projectId,
      actorDbId: actorRow._id,
      startKey,
      finishKey: "legacy-hosted-run-finish",
      startedAt,
    };
  });
}

async function markLegacyRunFinished(
  t: ReturnType<typeof convexTest>,
  fixture: Awaited<ReturnType<typeof insertLegacyRun>>,
) {
  await t.run(async (ctx: any) => {
    const endedAt = fixture.startedAt + 60_000;
    await ctx.db.patch(fixture.runDbId, {
      status: "succeeded",
      outcome: "Historical completion.",
      lastHeartbeatAt: endedAt,
      endedAt,
    });
    const eventDbId = await ctx.db.insert("events", {
      workspaceId: fixture.workspaceDbId,
      projectId: fixture.projectDbId,
      itemId: fixture.itemDbId,
      actorId: fixture.actorDbId,
      actorExternalId: actor.id,
      externalId: "pending",
      type: "run.finished",
      payload: {
        runId: fixture.runId,
        status: "succeeded",
        outcome: "Historical completion.",
      },
      idempotencyKey: fixture.finishKey,
      createdAt: endedAt,
    });
    await ctx.db.patch(eventDbId, { externalId: `evt_${eventDbId}` });
  });
}
