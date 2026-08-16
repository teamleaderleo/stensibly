import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "claim-activity-producer-secret";
const createItemRef = makeFunctionReference<"mutation">("items:create");
const acquireClaimRef = makeFunctionReference<"mutation">("claims:acquire");
const renewClaimRef = makeFunctionReference<"mutation">("claims:renew");
const releaseClaimRef = makeFunctionReference<"mutation">("claims:release");
const listEventsRef = makeFunctionReference<"query">("events:list");
const listActivityRef = makeFunctionReference<"query">("orchestratorActivity:listObservations");
const actor = {
  id: "agent claim producer",
  name: "Claim Producer",
  kind: "agent" as const,
};

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

async function acquire(
  t: ReturnType<typeof convexTest>,
  itemId: string,
  options: { leaseSeconds?: number; idempotencyKey?: string } = {},
) {
  return await t.mutation(acquireClaimRef, {
    serviceSecret,
    workspace: "test",
    id: itemId,
    actor,
    leaseSeconds: options.leaseSeconds ?? 300,
    idempotencyKey: options.idempotencyKey ?? "claim_activity_1",
  }) as any;
}

async function renew(
  t: ReturnType<typeof convexTest>,
  itemId: string,
  expectedClaimGeneration: number,
  options: { leaseSeconds?: number; idempotencyKey?: string } = {},
) {
  return await t.mutation(renewClaimRef, {
    serviceSecret,
    workspace: "test",
    id: itemId,
    actor,
    leaseSeconds: options.leaseSeconds ?? 300,
    expectedClaimGeneration,
    idempotencyKey: options.idempotencyKey ?? "renew_activity_1",
  }) as any;
}

async function release(
  t: ReturnType<typeof convexTest>,
  itemId: string,
  expectedClaimGeneration: number,
  idempotencyKey = "release_activity_1",
) {
  return await t.mutation(releaseClaimRef, {
    serviceSecret,
    workspace: "test",
    id: itemId,
    actor,
    expectedClaimGeneration,
    idempotencyKey,
  }) as any;
}

async function events(t: ReturnType<typeof convexTest>, itemId: string) {
  return (await t.query(listEventsRef, {
    serviceSecret,
    workspace: "test",
    id: itemId,
    limit: 32,
  }) as any).events as any[];
}

async function activity(t: ReturnType<typeof convexTest>) {
  return await t.query(listActivityRef, {
    serviceSecret,
    workspace: "test",
    project: "stensibly",
    limit: 32,
  }) as any;
}

function parsedActivity(result: any) {
  return result.observations.map((row: any) => ({
    appendOrder: row.appendOrder,
    observation: JSON.parse(row.observationJson),
  }));
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

    const history = await events(t, item.id);
    const claimEvent = history.find((event: any) => event.type === "claim.created");
    expect(claimEvent).toBeTruthy();

    const durable = await activity(t);
    expect(durable.truncated).toBe(false);
    expect(durable.observations).toHaveLength(1);
    expect(durable.observations[0].appendOrder).toBe(1);

    const observation = JSON.parse(durable.observations[0].observationJson);
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

    const durable = await activity(t);
    expect(durable.observations).toHaveLength(1);

    const counts = await t.run(async (ctx) => ({
      deliveries: (await ctx.db.query("orchestratorActivityDeliveries").collect()).length,
      observations: (await ctx.db.query("orchestratorActivityObservations").collect()).length,
    }));
    expect(counts).toEqual({ deliveries: 1, observations: 1 });
  });

  test("renew and release extend the same content-minimised responsibility timeline", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t);
    const claimed = await acquire(t, item.id);
    const renewed = await renew(t, item.id, claimed.claimGeneration, {
      leaseSeconds: 600,
      idempotencyKey: "renew_activity_timeline",
    });
    expect(renewed.claimGeneration).toBe(2);
    expect(await renew(t, item.id, claimed.claimGeneration, {
      leaseSeconds: 600,
      idempotencyKey: "renew_activity_timeline",
    })).toEqual(renewed);

    const released = await release(
      t,
      item.id,
      renewed.claimGeneration,
      "release_activity_timeline",
    );
    expect(released).toMatchObject({ status: "ready", claimGeneration: 3 });
    expect(await release(
      t,
      item.id,
      renewed.claimGeneration,
      "release_activity_timeline",
    )).toEqual(released);

    const history = await events(t, item.id);
    const createdEvent = history.find((event) => event.type === "claim.created");
    const renewedEvent = history.find((event) => event.type === "claim.renewed");
    const releasedEvent = history.find((event) => event.type === "claim.released");
    expect(createdEvent && renewedEvent && releasedEvent).toBeTruthy();

    const durable = parsedActivity(await activity(t));
    expect(durable).toHaveLength(3);
    expect(durable.map((entry: any) => entry.appendOrder)).toEqual([1, 2, 3]);
    expect(durable.map((entry: any) => ({
      sourceId: entry.observation.sourceId,
      activityClass: entry.observation.activityClass,
      activityState: entry.observation.activityState,
      generation: entry.observation.responsibilityGeneration,
    }))).toEqual([
      {
        sourceId: createdEvent.id,
        activityClass: "work_started",
        activityState: "in_progress",
        generation: 1,
      },
      {
        sourceId: renewedEvent.id,
        activityClass: "progress_evidence",
        activityState: "in_progress",
        generation: 2,
      },
      {
        sourceId: releasedEvent.id,
        activityClass: "progress_evidence",
        activityState: "observed",
        generation: 2,
      },
    ]);
    expect(new Set(durable.map((entry: any) => entry.observation.actorId)).size).toBe(1);

    const counts = await t.run(async (ctx) => ({
      deliveries: (await ctx.db.query("orchestratorActivityDeliveries").collect()).length,
      observations: (await ctx.db.query("orchestratorActivityObservations").collect()).length,
    }));
    expect(counts).toEqual({ deliveries: 3, observations: 3 });
  });

  test("renewal makes the old expiry timer quiet and the current expiry becomes stale activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T09:10:00.000Z"));
    const t = convexTest(schema, modules);
    try {
      const item = await createItem(t);
      const claimed = await acquire(t, item.id, {
        leaseSeconds: 30,
        idempotencyKey: "claim_expiry_activity",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const renewed = await renew(t, item.id, claimed.claimGeneration, {
        leaseSeconds: 60,
        idempotencyKey: "renew_expiry_activity",
      });
      expect(renewed.claimGeneration).toBe(2);

      await vi.advanceTimersByTimeAsync(25_000);
      await t.finishInProgressScheduledFunctions();
      expect((await activity(t)).observations).toHaveLength(2);
      expect((await events(t, item.id)).filter((event) => event.type === "claim.expired"))
        .toHaveLength(0);

      await vi.advanceTimersByTimeAsync(40_000);
      await t.finishInProgressScheduledFunctions();
      const detail = await t.run(async (ctx) => {
        const rows = await ctx.db.query("items").collect();
        return rows.find((row) => row.externalId === item.id);
      });
      expect(detail).toMatchObject({ status: "ready", claimGeneration: 3 });

      const history = await events(t, item.id);
      const expiredEvents = history.filter((event) => event.type === "claim.expired");
      expect(expiredEvents).toHaveLength(1);
      const durable = parsedActivity(await activity(t));
      expect(durable).toHaveLength(3);
      expect(durable[2]).toMatchObject({
        appendOrder: 3,
        observation: {
          sourceClass: "responsibility",
          sourceId: expiredEvents[0].id,
          activityClass: "progress_evidence",
          activityState: "stale",
          workItemId: item.id,
          responsibilityGeneration: 2,
          relatedEvidenceIds: [expiredEvents[0].id],
        },
      });
    } finally {
      vi.useRealTimers();
    }
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
      const allEvents = await ctx.db.query("events").collect();
      const deliveries = await ctx.db.query("orchestratorActivityDeliveries").collect();
      return {
        status: current?.status,
        claimGeneration: current?.claimGeneration,
        claimant: current?.claimedByExternalId ?? null,
        claimEvents: allEvents.filter((event) => event.type === "claim.created").length,
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

  test("release telemetry failure leaves the live claim and its event history untouched", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t);
    const claimed = await acquire(t, item.id);
    await t.run(async (ctx) => {
      const workspace = await ctx.db.query("workspaces").first();
      const project = await ctx.db.query("projects").first();
      if (!workspace || !project) throw new Error("test scope missing");
      await ctx.db.insert("orchestratorActivityObservations", {
        workspaceId: workspace._id,
        projectId: project._id,
        observationId: "oao_release_seed",
        observationFingerprint: `sha256:${"b".repeat(64)}`,
        sourceClass: "ledger_event",
        sourceId: "release_seed_event",
        observationJson: "{}",
        appendOrder: 2_147_483_647,
        firstAcceptedAt: Date.now(),
        createdAt: Date.now(),
      });
    });

    await expect(release(
      t,
      item.id,
      claimed.claimGeneration,
      "release_activity_rollback",
    )).rejects.toThrow("append order exhausted");

    const state = await t.run(async (ctx) => {
      const items = await ctx.db.query("items").collect();
      const current = items.find((entry) => entry.externalId === item.id);
      const allEvents = await ctx.db.query("events").collect();
      const deliveries = await ctx.db.query("orchestratorActivityDeliveries").collect();
      return {
        status: current?.status,
        claimGeneration: current?.claimGeneration,
        claimant: current?.claimedByExternalId ?? null,
        releaseEvents: allEvents.filter((event) => event.type === "claim.released").length,
        deliveries: deliveries.length,
      };
    });
    expect(state).toEqual({
      status: "active",
      claimGeneration: 1,
      claimant: "agent claim producer",
      releaseEvents: 0,
      deliveries: 1,
    });
  });
});
