import { afterEach, describe, expect, test } from "bun:test";
import { ConvexWorkLedger } from "../src/convex-ledger.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const item = {
  id: "item_1",
  project: "scrapbook",
  kind: "task" as const,
  title: "Use the benchmark pool",
  summary: null,
  status: "ready" as const,
  priority: 50,
  nextAction: null,
  claimedBy: null,
  claimExpiresAt: null,
  version: 1,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:00.000Z",
};

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("item reservation detail composition", () => {
  test("combines canonical item detail with a trusted-time reservation query", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const reservations = [{
      id: "res_1",
      resource: "gpu:benchmark-pool",
      mode: "shared" as const,
      capacity: 5,
      units: 2,
      usedUnits: 4,
      availableUnits: 1,
      holderActorId: "alpha",
      expiresAt: "2026-07-25T12:15:00.000Z",
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    }];
    const ledger = new ConvexWorkLedger({
      client: {
        query: async (_reference, args) => {
          calls.push(args);
          return calls.length === 1
            ? { item, events: [], artifacts: [], runs: [], dependencies: [] }
            : reservations;
        },
        mutation: async () => {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "default",
    });

    const before = Date.now();
    const detail = await ledger.getItem(item.id);
    const after = Date.now();
    const itemCall = calls[0];
    const reservationCall = calls[1];
    if (!itemCall || !reservationCall) {
      throw new Error("Expected both item and reservation queries");
    }

    expect(detail).toEqual({
      item,
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      reservations,
    });
    expect(calls).toHaveLength(2);
    expect(itemCall).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      id: item.id,
    });
    expect(reservationCall).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      itemId: item.id,
    });
    expect(reservationCall.now as number).toBeGreaterThanOrEqual(before);
    expect(reservationCall.now as number).toBeLessThanOrEqual(after);
  });

  test("keeps local REST item detail explicit and compatible", async () => {
    store = new StensiblyStore(":memory:");
    const created = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep local detail compatible",
      priority: 50,
      actor: { id: "leo", name: "Leo", kind: "human" },
    });
    const app = createServerApp(store);

    const response = await app.request(`/api/v1/items/${encodeURIComponent(created.id)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dependencies: [],
      reservations: [],
    });
  });
});
