import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "agent:runner", name: "Runner", kind: "agent" as const };
const executionEnvelope = {
  schemaVersion: 1 as const,
  objective: "Execute and verify the hosted direct run",
  scopeClass: "atomic" as const,
  estimate: {
    lowMinutes: 10,
    likelyMinutes: 25,
    highMinutes: 45,
    confidence: 0.7,
  },
  budget: {
    expectedMessages: 2,
    expectedToolCalls: 15,
    expectedReviewMinutes: 5,
  },
  boundaries: {
    softCheckpointMinutes: 30,
    forcedHandoffMinutes: 50,
    hardRecoveryMinutes: 60,
  },
  completion: {
    requiredOutputs: ["result", "verification"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["hosted run completes"],
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

describe("Convex direct-run execution envelopes", () => {
  test("persists, fences, replays, projects, and completes one immutable envelope", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      kind: "task",
      title: "Hosted direct run",
      nextAction: "Execute the bounded run.",
      priority: 80,
      actor,
    }) as any;
    const startInput = {
      serviceSecret: secret,
      workspace,
      itemId: item.id,
      actor,
      harness: "generic-mcp",
      model: "test-model",
      executionEnvelope,
      idempotencyKey: "hosted-direct-run-start",
    };

    const started = await t.mutation(convexApi.runs.start, startInput) as any;
    expect(started).toMatchObject({
      itemId: item.id,
      actorId: actor.id,
      status: "running",
      generation: 1,
      leaseGeneration: 1,
      executionEnvelope,
      executionRecords: [],
    });
    expect(await t.mutation(convexApi.runs.start, startInput)).toEqual(started);
    await expect(t.mutation(convexApi.runs.start, {
      ...startInput,
      executionEnvelope: {
        ...executionEnvelope,
        objective: "Changed direct-run objective",
      },
    })).rejects.toThrow("different run start request");

    await expect(t.mutation(convexApi.runs.heartbeat, {
      serviceSecret: secret,
      workspace,
      id: started.id,
      actorId: actor.id,
      checkpoint: "Missing the required fence.",
    })).rejects.toThrow("Expected generation is required");
    await expect(t.mutation(convexApi.runs.heartbeat, {
      serviceSecret: secret,
      workspace,
      id: started.id,
      actorId: actor.id,
      expectedGeneration: 2,
      checkpoint: "Stale checkpoint.",
    })).rejects.toThrow("generation changed from 2 to 1");
    const heartbeat = await t.mutation(convexApi.runs.heartbeat, {
      serviceSecret: secret,
      workspace,
      id: started.id,
      actorId: actor.id,
      expectedGeneration: started.generation,
      checkpoint: "Hosted checkpoint accepted.",
      toolCallCount: 6,
    }) as any;
    expect(heartbeat).toMatchObject({
      generation: 1,
      leaseGeneration: 1,
      status: "running",
      toolCallCount: 6,
    });

    const active = await t.query(convexApi.runs.listActive, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
    }) as any[];
    expect(active).toEqual([
      expect.objectContaining({
        id: started.id,
        generation: 1,
        executionEnvelope,
        executionRecords: [],
      }),
    ]);

    const finishInput = {
      serviceSecret: secret,
      workspace,
      id: started.id,
      actorId: actor.id,
      expectedGeneration: heartbeat.generation,
      status: "succeeded" as const,
      outcome: "Hosted direct run completed.",
      toolCallCount: 12,
      executionActual: {
        durationMinutes: 28,
        messagesConsumed: 2,
        toolCalls: 12,
        filesChanged: 3,
        reviewMinutes: 4,
        estimateErrorReasons: ["test fixture setup"],
      },
      idempotencyKey: "hosted-direct-run-finish",
    };
    await expect(t.mutation(convexApi.runs.finish, {
      ...finishInput,
      expectedGeneration: 2,
      idempotencyKey: "hosted-direct-run-stale-finish",
    })).rejects.toThrow("generation changed from 2 to 1");
    const finished = await t.mutation(convexApi.runs.finish, finishInput) as any;
    expect(finished).toMatchObject({
      generation: 2,
      leaseGeneration: 1,
      executionEnvelope,
    });
    expect(finished.executionRecords).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^evt_/),
        runId: started.id,
        runGeneration: 2,
        leaseGeneration: 1,
        transition: "finish:succeeded",
        actual: finishInput.executionActual,
      }),
    ]);
    expect(await t.mutation(convexApi.runs.finish, finishInput)).toEqual(finished);
    await expect(t.mutation(convexApi.runs.finish, {
      ...finishInput,
      executionActual: {
        ...finishInput.executionActual,
        filesChanged: 4,
      },
    })).rejects.toThrow("different run finish request");

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(detail.runs).toEqual([
      expect.objectContaining({
        id: started.id,
        status: "succeeded",
        generation: 2,
        executionEnvelope,
        executionRecords: [
          expect.objectContaining({
            runGeneration: 2,
            transition: "finish:succeeded",
            actual: finishInput.executionActual,
          }),
        ],
      }),
    ]);
  });

  test("fails closed when one run has duplicate stored envelope history", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      kind: "task",
      title: "Duplicate envelope guard",
      nextAction: "Reject conflicting history.",
      priority: 70,
      actor,
    }) as any;
    const started = await t.mutation(convexApi.runs.start, {
      serviceSecret: secret,
      workspace,
      itemId: item.id,
      actor,
      harness: "generic-mcp",
      executionEnvelope,
    }) as any;

    await t.run(async (ctx) => {
      const workspaceRow = await ctx.db
        .query("workspaces")
        .withIndex("by_slug", (q) => q.eq("slug", workspace))
        .unique();
      if (!workspaceRow) throw new Error("Test workspace missing");
      const itemRow = await ctx.db
        .query("items")
        .withIndex("by_workspace_external", (q) =>
          q.eq("workspaceId", workspaceRow._id).eq("externalId", item.id)
        )
        .unique();
      if (!itemRow) throw new Error("Test item missing");
      const id = await ctx.db.insert("events", {
        workspaceId: workspaceRow._id,
        projectId: itemRow.projectId,
        itemId: itemRow._id,
        externalId: "pending",
        type: `run.execution_envelope:${started.id}`,
        payload: {
          runId: started.id,
          generation: 1,
          leaseGeneration: 1,
          envelopeSchemaVersion: 1,
          envelope: executionEnvelope,
        },
        createdAt: Date.now() + 1,
      });
      await ctx.db.patch(id, { externalId: `evt_${id}` });
    });

    await expect(t.query(convexApi.runs.listActive, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
    })).rejects.toThrow("conflicting execution-envelope history");
  });
});
