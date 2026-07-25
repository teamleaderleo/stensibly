import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "item-reservation-visibility-secret";
const workspace = "test";
const createdAt = Date.parse("2026-07-25T12:00:00.000Z");
const alpha = { id: "alpha", name: "Alpha", kind: "agent" as const };
const beta = { id: "beta", name: "Beta", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
  vi.useFakeTimers();
  vi.setSystemTime(createdAt);
});

describe("item reservation visibility", () => {
  test("shows item holders and workspace-wide capacity without other identities", async () => {
    const t = convexTest(schema, modules);
    const visibleItem = await createItem(t, "scrapbook", "Use the benchmark pool");
    const privateItem = await createItem(t, "private-project", "Compete privately");

    const visibleReservation = await reserve(t, {
      itemId: visibleItem.id,
      project: "scrapbook",
      actor: alpha,
      resource: "gpu:benchmark-pool",
      capacity: 5,
      units: 2,
    });
    await reserve(t, {
      itemId: privateItem.id,
      project: "private-project",
      actor: beta,
      resource: "gpu:benchmark-pool",
      capacity: 5,
      units: 2,
    });

    const reservations = await t.query(convexApi.itemReservations.list, {
      serviceSecret,
      workspace,
      itemId: visibleItem.id,
      now: createdAt + 1_000,
    }) as any[];

    expect(reservations).toEqual([
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
    expect(reservations[0]).not.toHaveProperty("itemId");
    expect(reservations[0]).not.toHaveProperty("project");
    expect(JSON.stringify(reservations)).not.toContain(privateItem.id);
    expect(JSON.stringify(reservations)).not.toContain(beta.id);
  });

  test("omits elapsed and released reservations before scheduled cleanup", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "scrapbook", "Use a temporary browser slot");
    const reservation = await t.mutation(convexApi.reservations.acquire, {
      serviceSecret,
      workspace,
      resource: "browser:test-slot",
      mode: "exclusive",
      capacity: 1,
      units: 1,
      leaseSeconds: 30,
      actor: leo,
      project: "scrapbook",
      itemId: item.id,
    }) as any;

    const active = await t.query(convexApi.itemReservations.list, {
      serviceSecret,
      workspace,
      itemId: item.id,
      now: createdAt + 10_000,
    }) as any[];
    expect(active).toEqual([
      expect.objectContaining({ usedUnits: 1, availableUnits: 0 }),
    ]);

    const elapsed = await t.query(convexApi.itemReservations.list, {
      serviceSecret,
      workspace,
      itemId: item.id,
      now: createdAt + 31_000,
    });
    expect(elapsed).toEqual([]);

    await t.mutation(convexApi.reservations.release, {
      serviceSecret,
      workspace,
      id: reservation.id,
      actorId: leo.id,
    });
    const released = await t.query(convexApi.itemReservations.list, {
      serviceSecret,
      workspace,
      itemId: item.id,
      now: createdAt + 20_000,
    });
    expect(released).toEqual([]);
  });

  test("rejects invalid trusted timestamps", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "scrapbook", "Validate reservation time");

    await expect(t.query(convexApi.itemReservations.list, {
      serviceSecret,
      workspace,
      itemId: item.id,
      now: -1,
    })).rejects.toThrow("Reservation visibility time must be a valid Unix timestamp");
  });
});

async function createItem(
  t: ReturnType<typeof convexTest>,
  project: string,
  title: string,
) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret,
    workspace,
    project,
    kind: "task",
    title,
    nextAction: "Continue.",
    priority: 50,
    actor: leo,
  }) as any;
}

async function reserve(
  t: ReturnType<typeof convexTest>,
  input: {
    itemId: string;
    project: string;
    actor: typeof alpha | typeof beta;
    resource: string;
    capacity: number;
    units: number;
  },
) {
  return await t.mutation(convexApi.reservations.acquire, {
    serviceSecret,
    workspace,
    mode: "shared",
    leaseSeconds: 900,
    ...input,
  }) as any;
}
