import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "claim-lazy-expiry-activity-secret";
const createItemRef = makeFunctionReference<"mutation">("items:create");
const acquireClaimRef = makeFunctionReference<"mutation">("claims:acquire");
const listEventsRef = makeFunctionReference<"query">("events:list");
const listActivityRef = makeFunctionReference<"query">("orchestratorActivity:listObservations");
const actor = { id: "lazy expiry actor", name: "Lazy Expiry Actor", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("lazy claim expiry activity", () => {
  test("a later claim observes elapsed responsibility before acquiring a new generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T09:20:00.000Z"));
    const t = convexTest(schema, modules);
    try {
      const item = await t.mutation(createItemRef, {
        serviceSecret,
        workspace: "test",
        project: "stensibly",
        kind: "task",
        title: "Lazy expiry activity",
        priority: 50,
        idempotencyKey: "lazy_expiry_item",
      }) as any;
      const first = await t.mutation(acquireClaimRef, {
        serviceSecret,
        workspace: "test",
        id: item.id,
        actor,
        leaseSeconds: 30,
        idempotencyKey: "lazy_expiry_claim_1",
      }) as any;
      expect(first.claimGeneration).toBe(1);

      await vi.advanceTimersByTimeAsync(31_000);
      const second = await t.mutation(acquireClaimRef, {
        serviceSecret,
        workspace: "test",
        id: item.id,
        actor,
        leaseSeconds: 60,
        idempotencyKey: "lazy_expiry_claim_2",
      }) as any;
      expect(second).toMatchObject({
        status: "active",
        claimedBy: actor.id,
        claimGeneration: 3,
      });

      const history = (await t.query(listEventsRef, {
        serviceSecret,
        workspace: "test",
        id: item.id,
        limit: 32,
      }) as any).events as any[];
      const expired = history.filter((event) => event.type === "claim.expired");
      expect(expired).toHaveLength(1);
      expect(history.filter((event) => event.type === "claim.created")).toHaveLength(2);

      const durable = await t.query(listActivityRef, {
        serviceSecret,
        workspace: "test",
        project: "stensibly",
        limit: 32,
      }) as any;
      const observations = durable.observations.map((row: any) => ({
        appendOrder: row.appendOrder,
        ...JSON.parse(row.observationJson),
      }));
      expect(observations).toHaveLength(3);
      expect(observations.map((entry: any) => entry.appendOrder)).toEqual([1, 2, 3]);
      expect(observations.map((entry: any) => ({
        sourceId: entry.sourceId,
        activityClass: entry.activityClass,
        activityState: entry.activityState,
        generation: entry.responsibilityGeneration,
      }))).toEqual([
        {
          sourceId: history.find((event) => event.type === "claim.created")?.id,
          activityClass: "work_started",
          activityState: "in_progress",
          generation: 1,
        },
        {
          sourceId: expired[0].id,
          activityClass: "progress_evidence",
          activityState: "stale",
          generation: 1,
        },
        {
          sourceId: history.filter((event) => event.type === "claim.created")[1]?.id,
          activityClass: "work_started",
          activityState: "in_progress",
          generation: 3,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
