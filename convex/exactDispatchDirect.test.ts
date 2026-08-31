/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const baseArgs = { serviceSecret: "test-service-secret", workspace: "dispatch-test" };
beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", baseArgs.serviceSecret));
const actor = {
  id: "service:owned-workstation-dispatch",
  name: "Owned workstation dispatcher",
  kind: "service" as const,
};
const envelope = {
  schemaVersion: 1 as const,
  objective: "Run one exact bounded repository query on an eligible owned workstation.",
  scopeClass: "atomic" as const,
  estimate: { lowMinutes: 0, likelyMinutes: 1, highMinutes: 3, confidence: 0.8 },
  budget: { expectedMessages: 1, expectedToolCalls: 1, expectedReviewMinutes: 0 },
  boundaries: { softCheckpointMinutes: 1, forcedHandoffMinutes: 2, hardRecoveryMinutes: 3 },
  completion: {
    requiredOutputs: ["bounded repo-query/v1 receipt"],
    verificationRequired: true,
    continuationStateRequired: false,
    acceptanceChecks: ["receipt binds exact source and profile"],
  },
  durableState: {
    accessClass: "project" as const,
    retentionClass: "standard" as const,
    redactionRequired: true,
    deleteAfter: null,
  },
};

describe("hosted direct exact dispatch", () => {
  test("queues one exact runner-neutral run and replays from its canonical event", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      ...baseArgs,
      project: "glaeda",
      kind: "task",
      title: "Query one exact Glaeda candidate",
      priority: 90,
      actor,
      idempotencyKey: "create-direct-dispatch-item",
    }) as any;
    const input = {
      ...baseArgs,
      project: "glaeda",
      itemId: item.id as string,
      expectedClaimGeneration: 0,
      actor,
      runnerType: "glaeda-workstation",
      runnerProfile: "repo-query/v1",
      runnerProfileVersion: `sha256:${"a".repeat(64)}`,
      executionEnvelope: envelope,
      leaseSeconds: 900,
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      idempotencyKey: "dispatch-owned-workstation-query",
    };
    const dispatched = await t.mutation(convexApi.exactDispatch.dispatch, input) as any;
    expect(dispatched).toMatchObject({
      status: "dispatched",
      replay: false,
      expectedClaimGeneration: 0,
      claimedGeneration: 1,
      item: { id: item.id, status: "active", claimGeneration: 1 },
      run: {
        status: "queued",
        runnerType: "glaeda-workstation",
        runnerProfile: "repo-query/v1",
        runnerProfileVersion: input.runnerProfileVersion,
        generation: 1,
        leaseGeneration: 1,
        executionEnvelope: envelope,
      },
    });

    const replay = await t.mutation(convexApi.exactDispatch.dispatch, input) as any;
    expect(replay.replay).toBe(true);
    expect(replay.run).toEqual(dispatched.run);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("queuedRuns").collect()).toHaveLength(1);
      const event = (await ctx.db.query("events").collect())
        .find((entry) => entry.idempotencyKey === input.idempotencyKey);
      expect(event).toMatchObject({
        type: "run.queued",
        actorExternalId: actor.id,
        payload: {
          runId: dispatched.run.id,
          claimedGeneration: 1,
          requestFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });
    });
  });

  test("refuses stale or changed direct-dispatch requests without another run", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      ...baseArgs,
      project: "glaeda",
      kind: "task",
      title: "Fence hosted direct dispatch",
      priority: 90,
      actor,
    }) as any;
    const input = {
      ...baseArgs,
      project: "glaeda",
      itemId: item.id as string,
      expectedClaimGeneration: 0,
      actor,
      runnerType: "glaeda-workstation",
      runnerProfile: "repo-query/v1",
      runnerProfileVersion: `sha256:${"b".repeat(64)}`,
      executionEnvelope: envelope,
      leaseSeconds: 900,
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      idempotencyKey: "dispatch-owned-workstation-fence",
    };
    await t.mutation(convexApi.exactDispatch.dispatch, input);
    await expect(t.mutation(convexApi.exactDispatch.dispatch, {
      ...input,
      runnerProfile: "verify-focused/v1",
    })).rejects.toThrow(/another operation/);
    await expect(t.mutation(convexApi.exactDispatch.dispatch, {
      ...input,
      idempotencyKey: "dispatch-owned-workstation-stale",
    })).rejects.toThrow(/not currently eligible/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("queuedRuns").collect()).toHaveLength(1);
    });
  });
});
