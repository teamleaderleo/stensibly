import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const leo = { id: "leo", name: "Leo", kind: "human" as const };
const alpha = { id: "alpha", name: "Alpha", kind: "agent" as const };
const beta = { id: "beta", name: "Beta", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("item reservation visibility", () => {
  test("shows item holders and workspace-wide resource capacity without other item identities", async () => {
    const t = convexTest(schema, modules);
    const visibleItem = await createItem(t, "Use the shared benchmark pool", "scrapbook");
    const otherProjectItem = await createItem(t, "Compete without leaking identity", "secret");

    const visibleReservation = await t.mutation(convexApi.reservations.acquire, {
      serviceSecret: secret,
      workspace,
      resource: "gpu:benchmark-pool",
      mode: "shared",
      capacity: 5,
      units: 2,
      leaseSeconds: 900,
      actor: alpha,
      project: "scrapbook",
      itemId: visibleItem.id,
    }) as any;
    await t.mutation(convexApi.reservations.acquire, {
      serviceSecret: secret,
      workspace,
      resource: "gpu:benchmark-pool",
      mode: "shared",
      capacity: 5,
      units: 2,
      leaseSeconds: 900,
      actor: beta,
      project: "secret",
      itemId: otherProjectItem.id,
    });

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: visibleItem.id,
    }) as any;
    expect(detail.reservations).toEqual([
      expect.objectContaining({
        id: visibleReservation.id,
        resource: "gpu:benchmark-pool",
        mode: "shared",
        capacity: 5,
        units: 2,
        usedUnits: 4,
        availableUnits: 1,
        holderActorId: alpha.id,
      }),
    ]);
    expect(detail.reservations[0]).not.toHaveProperty("itemId");
    expect(detail.reservations[0]).not.toHaveProperty("project");
    expect(JSON.stringify(detail.reservations)).not.toContain(otherProjectItem.id);
    expect(JSON.stringify(detail.reservations)).not.toContain(beta.id);

    await t.mutation(convexApi.reservations.release, {
      serviceSecret: secret,
      workspace,
      id: visibleReservation.id,
      actorId: alpha.id,
    });
    const releasedDetail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: visibleItem.id,
    }) as any;
    expect(releasedDetail.reservations).toEqual([]);
  });

  test("omits elapsed reservations before scheduled cleanup finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    try {
      const t = convexTest(schema, modules);
      const item = await createItem(t, "Outlive a delayed reservation timer", "scrapbook");
      await t.mutation(convexApi.reservations.acquire, {
        serviceSecret: secret,
        workspace,
        resource: "browser:test-slot",
        mode: "exclusive",
        capacity: 1,
        units: 1,
        leaseSeconds: 30,
        actor: leo,
        project: "scrapbook",
        itemId: item.id,
      });

      const active = await t.query(convexApi.items.get, {
        serviceSecret: secret,
        workspace,
        id: item.id,
      }) as any;
      expect(active.reservations).toHaveLength(1);
      expect(active.reservations[0]).toMatchObject({ usedUnits: 1, availableUnits: 0 });

      await vi.advanceTimersByTimeAsync(31_000);
      const elapsed = await t.query(convexApi.items.get, {
        serviceSecret: secret,
        workspace,
        id: item.id,
      }) as any;
      expect(elapsed.reservations).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function createItem(t: any, title: string, project: string) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project,
    kind: "task",
    title,
    nextAction: "Continue.",
    priority: 50,
    actor: leo,
  }) as any;
}
