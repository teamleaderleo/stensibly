import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "claim-activity-producer-secret";
const createItemRef = makeFunctionReference<"mutation">("items:create");
const acquireClaimRef = makeFunctionReference<"mutation">("claims:acquire");
const listEventsRef = makeFunctionReference<"query">("events:list");
const listActivityRef = makeFunctionReference<"query">("orchestratorActivity:listObservations");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

async function createItem(t: ReturnType<typeof convexTest>) {
  return await t.mutation(createItemRef, {
    serviceSecret,
    workspace: "test",
    project: "stensibly",
    kind: "task",
    title: "Claim producer dogfood",
    priority: 50,
    idempotencyKey: "item_claim_activity_1",
  }) as any;
}

async function acquire(t: ReturnType<typeof convexTest>, itemId: string) {
  return await t.mutation(acquireClaimRef, {
    serviceSecret,
    workspace: "test",
    id: itemId,
    actor: {
      id: "agent claim producer",
      name: "Claim Producer",
      kind: "agent",
    },
    leaseSeconds: 300,
    idempotencyKey: "claim_activity_1",
  }) as any;
}

describe("automatic claim activity producer", () => {
  test("one ordinary claim emits one durable responsibility observation", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t);
    const claimed = await acquire(t, item.id);
    expect(claimed).toMatchObject({
      id: item.id,
      project: "stensibly",
      status: "active",
      claimedBy: "agent claim producer",
      claimGeneration: 1,
    });

    const history = await t.query(listEventsRef, {
      serviceSecret,
      workspace: "test",
      id: item.id,
      limit: 32,
    }) as any;
    const claimEvent = history.events.find((event: any) => event.type === "claim.created");
    expect(claimEvent).toBeTruthy();

    const activity = await t.query(listActivityRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      limit: 32,
    }) as any;
    expect(activity.truncated).toBe(false);
    expect(activity.observations).toHaveLength(1);
    expect(activity.observations[0].appendOrder).toBe(1);

    const observation = JSON.parse(activity.observations[0].observationJson);
    expect(observation).toMatchObject({
      workspace: "test",
      project: "stensibly",
      sourceClass: "responsibility",
      sourceId: claimEvent.id,
      activityClass: "work_started",
      activityState: "in_progress",
      workItemId: item.id,
      responsibilityGeneration: 1,
      relatedEvidenceIds: [claimEvent.id],
      disclosure: {
        containsPrivateReasoning: false,
        containsRawPrompt: false,
        containsProviderBody: false,
        containsCredentialMaterial: false,
        containsUnboundedLogText: false,
      },
    });
    expect(observation.actorId).toMatch(/^actor:/u);
    expect(observation.actorId).not.toContain("agent claim producer");
    expect(observation.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("exact claim replay creates no second activity delivery or observation", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t);
    const first = await acquire(t, item.id);
    const replay = await acquire(t, item.id);
    expect(replay).toEqual(first);

    const activity = await t.query(listActivityRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      limit: 32,
    }) as any;
    expect(activity.observations).toHaveLength(1);

    const counts = await t.run(async (ctx) => ({
      deliveries: (await ctx.db.query("orchestratorActivityDeliveries").collect()).length,
      observations: (await ctx.db.query("orchestratorActivityObservations").collect()).length,
    }));
    expect(counts).toEqual({ deliveries: 1, observations: 1 });
  });

  test("activity persistence failure rolls the claim and claim event back together", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t);
    await t.run(async (ctx) => {
      const workspace = await ctx.db.query("workspaces").first();
      const project = await ctx.db.query("projects").first();
      if (!workspace || !project) throw new Error("test scope missing");
      await ctx.db.insert("orchestratorActivityObservations", {
        workspaceId: workspace._id,
        projectId: project._id,
        observationId: "oao_seed",
        observationFingerprint: `sha256:${"a".repeat(64)}`,
        sourceClass: "ledger_event",
        sourceId: "seed_event",
        observationJson: "{}",
        appendOrder: 2_147_483_647,
        firstAcceptedAt: Date.now(),
        createdAt: Date.now(),
      });
    });

    await expect(acquire(t, item.id)).rejects.toThrow("append order exhausted");
    const state = await t.run(async (ctx) => {
      const items = await ctx.db.query("items").collect();
      const current = items.find((entry) => entry.externalId === item.id);
      const events = await ctx.db.query("events").collect();
      const deliveries = await ctx.db.query("orchestratorActivityDeliveries").collect();
      return {
        status: current?.status,
        claimGeneration: current?.claimGeneration,
        claimant: current?.claimedByExternalId ?? null,
        claimEvents: events.filter((event) => event.type === "claim.created").length,
        deliveries: deliveries.length,
      };
    });
    expect(state).toEqual({
      status: "ready",
      claimGeneration: 0,
      claimant: null,
      claimEvents: 0,
      deliveries: 0,
    });
  });
});
