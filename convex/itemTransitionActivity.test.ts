import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "item-transition-activity-secret";
const createItemRef = makeFunctionReference<"mutation">("items:create");
const acquireClaimRef = makeFunctionReference<"mutation">("claims:acquire");
const handoffRef = makeFunctionReference<"mutation">("items:handoff");
const completeRef = makeFunctionReference<"mutation">("items:complete");
const listEventsRef = makeFunctionReference<"query">("events:list");
const listActivityRef = makeFunctionReference<"query">("orchestratorActivity:listObservations");

const alpha = {
  id: "agent transition alpha",
  name: "Transition Alpha",
  kind: "agent" as const,
};
const beta = {
  id: "agent transition beta",
  name: "Transition Beta",
  kind: "agent" as const,
};

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

async function createItem(t: ReturnType<typeof convexTest>, suffix = "1") {
  return await t.mutation(createItemRef, {
    serviceSecret,
    workspace: "test",
    project: "stensibly",
    kind: "task",
    title: `Transition activity ${suffix}`,
    priority: 50,
    idempotencyKey: `item_transition_activity_${suffix}`,
  }) as any;
}

async function acquire(
  t: ReturnType<typeof convexTest>,
  itemId: string,
  actor: typeof alpha,
  idempotencyKey: string,
) {
  return await t.mutation(acquireClaimRef, {
    serviceSecret,
    workspace: "test",
    id: itemId,
    actor,
    leaseSeconds: 300,
    idempotencyKey,
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

describe("automatic item transition activity producer", () => {
  test("handoff and completion join claim activity without retaining transition prose", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t);
    const alphaClaim = await acquire(t, item.id, alpha, "transition_claim_alpha");

    const handoffRequest = {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor: alpha,
      expectedClaimGeneration: alphaClaim.claimGeneration,
      summary: "Private handoff summary stays in the canonical event only.",
      nextAction: "Continue with the next bounded slice.",
      toActorId: beta.id,
      idempotencyKey: "transition_handoff",
    };
    const handedOff = await t.mutation(handoffRef, handoffRequest) as any;
    expect(handedOff).toMatchObject({ status: "ready", claimGeneration: 2 });
    expect(await t.mutation(handoffRef, handoffRequest)).toEqual(handedOff);

    const betaClaim = await acquire(t, item.id, beta, "transition_claim_beta");
    expect(betaClaim).toMatchObject({ status: "active", claimGeneration: 3 });

    const completeRequest = {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor: beta,
      expectedClaimGeneration: betaClaim.claimGeneration,
      summary: "Private completion summary stays in the canonical event only.",
      idempotencyKey: "transition_complete",
    };
    const completed = await t.mutation(completeRef, completeRequest) as any;
    expect(completed).toMatchObject({ status: "done", claimGeneration: 4 });
    expect(await t.mutation(completeRef, completeRequest)).toEqual(completed);

    const history = await events(t, item.id);
    const createdClaim = history.find((event) => event.type === "claim.created" && event.actorId === alpha.id);
    const handoff = history.find((event) => event.type === "work.handed_off");
    const betaCreatedClaim = history.find((event) => event.type === "claim.created" && event.actorId === beta.id);
    const completion = history.find((event) => event.type === "item.completed");
    expect(createdClaim && handoff && betaCreatedClaim && completion).toBeTruthy();

    const durable = parsedActivity(await activity(t));
    expect(durable).toHaveLength(4);
    expect(durable.map((entry: any) => entry.appendOrder)).toEqual([1, 2, 3, 4]);
    expect(durable.map((entry: any) => ({
      sourceClass: entry.observation.sourceClass,
      sourceId: entry.observation.sourceId,
      activityClass: entry.observation.activityClass,
      activityState: entry.observation.activityState,
      generation: entry.observation.responsibilityGeneration,
    }))).toEqual([
      {
        sourceClass: "responsibility",
        sourceId: createdClaim.id,
        activityClass: "work_started",
        activityState: "in_progress",
        generation: 1,
      },
      {
        sourceClass: "ledger_event",
        sourceId: handoff.id,
        activityClass: "handoff",
        activityState: "observed",
        generation: 1,
      },
      {
        sourceClass: "responsibility",
        sourceId: betaCreatedClaim.id,
        activityClass: "work_started",
        activityState: "in_progress",
        generation: 3,
      },
      {
        sourceClass: "ledger_event",
        sourceId: completion.id,
        activityClass: "completed",
        activityState: "succeeded",
        generation: 3,
      },
    ]);

    const durableJson = JSON.stringify(durable);
    expect(durableJson).not.toContain(handoffRequest.summary);
    expect(durableJson).not.toContain(handoffRequest.nextAction);
    expect(durableJson).not.toContain(handoffRequest.toActorId);
    expect(durableJson).not.toContain(completeRequest.summary);

    const counts = await t.run(async (ctx) => ({
      deliveries: (await ctx.db.query("orchestratorActivityDeliveries").collect()).length,
      observations: (await ctx.db.query("orchestratorActivityObservations").collect()).length,
    }));
    expect(counts).toEqual({ deliveries: 4, observations: 4 });
  });

  test("unclaimed completion keeps responsibility generation absent", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "unclaimed");
    const finisher = {
      id: "unclaimed transition finisher",
      name: "Unclaimed Finisher",
      kind: "agent" as const,
    };
    const completed = await t.mutation(completeRef, {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor: finisher,
      expectedClaimGeneration: 0,
      summary: "Completed directly from ready state.",
      idempotencyKey: "transition_complete_unclaimed",
    }) as any;
    expect(completed).toMatchObject({ status: "done", claimGeneration: 1 });

    const history = await events(t, item.id);
    const completion = history.find((event) => event.type === "item.completed");
    expect(completion).toBeTruthy();
    const durable = parsedActivity(await activity(t));
    expect(durable).toHaveLength(1);
    expect(durable[0]).toMatchObject({
      appendOrder: 1,
      observation: {
        sourceClass: "ledger_event",
        sourceId: completion.id,
        activityClass: "completed",
        activityState: "succeeded",
        workItemId: item.id,
        responsibilityGeneration: null,
      },
    });
    expect(durable[0].observation.actorId).toMatch(/^actor:/u);
    expect(durable[0].observation.actorId).not.toContain(finisher.id);
  });

  test("completion activity failure rolls the item transition and event back together", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "rollback");
    await t.run(async (ctx) => {
      const workspace = await ctx.db.query("workspaces").first();
      const project = await ctx.db.query("projects").first();
      if (!workspace || !project) throw new Error("test scope missing");
      await ctx.db.insert("orchestratorActivityObservations", {
        workspaceId: workspace._id,
        projectId: project._id,
        observationId: "oao_transition_seed",
        observationFingerprint: `sha256:${"c".repeat(64)}`,
        sourceClass: "ledger_event",
        sourceId: "transition_seed_event",
        observationJson: "{}",
        appendOrder: 2_147_483_647,
        firstAcceptedAt: Date.now(),
        createdAt: Date.now(),
      });
    });

    await expect(t.mutation(completeRef, {
      serviceSecret,
      workspace: "test",
      id: item.id,
      actor: beta,
      expectedClaimGeneration: 0,
      summary: "This transition must roll back.",
      idempotencyKey: "transition_complete_rollback",
    })).rejects.toThrow("append order exhausted");

    const state = await t.run(async (ctx) => {
      const items = await ctx.db.query("items").collect();
      const current = items.find((entry) => entry.externalId === item.id);
      const allEvents = await ctx.db.query("events").collect();
      const deliveries = await ctx.db.query("orchestratorActivityDeliveries").collect();
      return {
        status: current?.status,
        claimGeneration: current?.claimGeneration,
        completionEvents: allEvents.filter((event) => event.type === "item.completed").length,
        deliveries: deliveries.length,
      };
    });
    expect(state).toEqual({
      status: "ready",
      claimGeneration: 0,
      completionEvents: 0,
      deliveries: 0,
    });
  });
});
