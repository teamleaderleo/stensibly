import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "item-block-activity-secret";
const createItemRef = makeFunctionReference<"mutation">("items:create");
const acquireClaimRef = makeFunctionReference<"mutation">("claims:acquire");
const blockRef = makeFunctionReference<"mutation">("items:block");
const unblockRef = makeFunctionReference<"mutation">("items:unblock");
const handoffRef = makeFunctionReference<"mutation">("items:handoff");
const completeRef = makeFunctionReference<"mutation">("items:complete");
const listEventsRef = makeFunctionReference<"query">("events:list");
const listActivityRef = makeFunctionReference<"query">("orchestratorActivity:listObservations");

const actor = {
  id: "agent block activity",
  name: "Block Activity",
  kind: "agent" as const,
};

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

async function createItem(t: ReturnType<typeof convexTest>, suffix: string) {
  return await t.mutation(createItemRef, {
    serviceSecret,
    workspace: "test",
    project: "stensibly",
    kind: "task",
    title: `Block activity ${suffix}`,
    priority: 50,
    idempotencyKey: `item_block_activity_${suffix}`,
  }) as any;
}

async function events(t: ReturnType<typeof convexTest>, itemId: string) {
  return (await t.query(listEventsRef, {
    serviceSecret,
    workspace: "test",
    id: itemId,
    limit: 64,
  }) as any).events as any[];
}

async function activity(t: ReturnType<typeof convexTest>) {
  return await t.query(listActivityRef, {
    serviceSecret,
    workspace: "test",
    project: "stensibly",
    limit: 64,
  }) as any;
}

function parsedActivity(result: any) {
  return result.observations.map((row: any) => ({
    appendOrder: row.appendOrder,
    observation: JSON.parse(row.observationJson),
  }));
}

describe("automatic block and unblock activity producer", () => {
  test("unclaimed transitions keep responsibility absent even as claim generation advances", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "unclaimed-chain");

    const blockRequest = {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor,
      expectedClaimGeneration: 0,
      reason: "Blocked prose stays in the ledger event only.",
      nextAction: "Resolve the dependency.",
      idempotencyKey: "block_unclaimed_chain",
    };
    const blocked = await t.mutation(blockRef, blockRequest) as any;
    expect(blocked).toMatchObject({ status: "blocked", claimGeneration: 1 });
    expect(await t.mutation(blockRef, blockRequest)).toEqual(blocked);

    const unblockRequest = {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor,
      expectedClaimGeneration: blocked.claimGeneration,
      nextAction: "Dependency cleared; continue.",
      idempotencyKey: "unblock_unclaimed_chain",
    };
    const unblocked = await t.mutation(unblockRef, unblockRequest) as any;
    expect(unblocked).toMatchObject({ status: "ready", claimGeneration: 2 });
    expect(await t.mutation(unblockRef, unblockRequest)).toEqual(unblocked);

    const handoffRequest = {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor,
      expectedClaimGeneration: unblocked.claimGeneration,
      summary: "Unclaimed handoff after multiple semantic generations.",
      nextAction: "Continue elsewhere.",
      idempotencyKey: "handoff_unclaimed_chain",
    };
    const handedOff = await t.mutation(handoffRef, handoffRequest) as any;
    expect(handedOff).toMatchObject({ status: "ready", claimGeneration: 3 });
    expect(await t.mutation(handoffRef, handoffRequest)).toEqual(handedOff);

    const completeRequest = {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor,
      expectedClaimGeneration: handedOff.claimGeneration,
      summary: "Unclaimed completion after multiple semantic generations.",
      idempotencyKey: "complete_unclaimed_chain",
    };
    const completed = await t.mutation(completeRef, completeRequest) as any;
    expect(completed).toMatchObject({ status: "done", claimGeneration: 4 });
    expect(await t.mutation(completeRef, completeRequest)).toEqual(completed);

    const history = await events(t, item.id);
    const blockedEvent = history.find((event) => event.type === "work.blocked");
    const unblockedEvent = history.find((event) => event.type === "work.unblocked");
    const handoffEvent = history.find((event) => event.type === "work.handed_off");
    const completionEvent = history.find((event) => event.type === "item.completed");
    expect(blockedEvent && unblockedEvent && handoffEvent && completionEvent).toBeTruthy();

    const durable = parsedActivity(await activity(t));
    expect(durable).toHaveLength(4);
    expect(durable.map((entry: any) => entry.appendOrder)).toEqual([1, 2, 3, 4]);
    expect(durable.map((entry: any) => ({
      sourceId: entry.observation.sourceId,
      activityClass: entry.observation.activityClass,
      activityState: entry.observation.activityState,
      generation: entry.observation.responsibilityGeneration,
    }))).toEqual([
      {
        sourceId: blockedEvent.id,
        activityClass: "blocked",
        activityState: "blocked",
        generation: null,
      },
      {
        sourceId: unblockedEvent.id,
        activityClass: "progress_evidence",
        activityState: "observed",
        generation: null,
      },
      {
        sourceId: handoffEvent.id,
        activityClass: "handoff",
        activityState: "observed",
        generation: null,
      },
      {
        sourceId: completionEvent.id,
        activityClass: "completed",
        activityState: "succeeded",
        generation: null,
      },
    ]);

    const durableJson = JSON.stringify(durable);
    for (const prose of [
      blockRequest.reason,
      blockRequest.nextAction,
      unblockRequest.nextAction,
      handoffRequest.summary,
      handoffRequest.nextAction,
      completeRequest.summary,
    ]) {
      expect(durableJson).not.toContain(prose);
    }

    const counts = await t.run(async (ctx) => ({
      deliveries: (await ctx.db.query("orchestratorActivityDeliveries").collect()).length,
      observations: (await ctx.db.query("orchestratorActivityObservations").collect()).length,
    }));
    expect(counts).toEqual({ deliveries: 4, observations: 4 });
  });

  test("blocking a live claim retains the exact responsibility generation", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "claimed");
    const claimed = await t.mutation(acquireClaimRef, {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor,
      leaseSeconds: 300,
      idempotencyKey: "claim_before_block",
    }) as any;
    expect(claimed).toMatchObject({ status: "active", claimGeneration: 1 });

    const blocked = await t.mutation(blockRef, {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor,
      expectedClaimGeneration: claimed.claimGeneration,
      reason: "Waiting on an external dependency.",
      idempotencyKey: "block_claimed",
    }) as any;
    expect(blocked).toMatchObject({ status: "blocked", claimGeneration: 2 });

    const history = await events(t, item.id);
    const claimEvent = history.find((event) => event.type === "claim.created");
    const blockedEvent = history.find((event) => event.type === "work.blocked");
    const durable = parsedActivity(await activity(t));
    expect(durable).toHaveLength(2);
    expect(durable[0].observation).toMatchObject({
      sourceId: claimEvent.id,
      activityClass: "work_started",
      activityState: "in_progress",
      responsibilityGeneration: 1,
    });
    expect(durable[1].observation).toMatchObject({
      sourceId: blockedEvent.id,
      sourceClass: "ledger_event",
      activityClass: "blocked",
      activityState: "blocked",
      responsibilityGeneration: 1,
    });
  });

  test("block activity failure rolls the item transition and event back together", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "rollback");
    await t.run(async (ctx) => {
      const workspace = await ctx.db.query("workspaces").first();
      const project = await ctx.db.query("projects").first();
      if (!workspace || !project) throw new Error("test scope missing");
      await ctx.db.insert("orchestratorActivityObservations", {
        workspaceId: workspace._id,
        projectId: project._id,
        observationId: "oao_block_seed",
        observationFingerprint: `sha256:${"d".repeat(64)}`,
        sourceClass: "ledger_event",
        sourceId: "block_seed_event",
        observationJson: "{}",
        appendOrder: 2_147_483_647,
        firstAcceptedAt: Date.now(),
        createdAt: Date.now(),
      });
    });

    await expect(t.mutation(blockRef, {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor,
      expectedClaimGeneration: 0,
      reason: "This block must roll back.",
      idempotencyKey: "block_activity_rollback",
    })).rejects.toThrow("append order exhausted");

    const state = await t.run(async (ctx) => {
      const items = await ctx.db.query("items").collect();
      const current = items.find((entry) => entry.externalId === item.id);
      const allEvents = await ctx.db.query("events").collect();
      const deliveries = await ctx.db.query("orchestratorActivityDeliveries").collect();
      return {
        status: current?.status,
        claimGeneration: current?.claimGeneration,
        blockEvents: allEvents.filter((event) => event.type === "work.blocked").length,
        deliveries: deliveries.length,
      };
    });
    expect(state).toEqual({
      status: "ready",
      claimGeneration: 0,
      blockEvents: 0,
      deliveries: 0,
    });
  });
});
