import { describe, expect, test } from "bun:test";
import {
  MAX_ACTIVITY_ITEMS,
  aggregateActorActivity,
  mapWithConcurrency,
  normalizeActivityCandidates,
  readActorActivityDetail,
} from "../site/actor-activity.js";

const candidate = {
  id: "item_1",
  project: "scrapbook",
  title: "Ship dashboard",
  status: "active",
};

function detailPayload() {
  return {
    item: {
      ...candidate,
      kind: "task",
      summary: null,
      priority: 80,
      nextAction: "Verify production",
      claimedBy: "agent-1",
      claimExpiresAt: "2026-07-25T00:00:00.000Z",
      version: 4,
      createdAt: "2026-07-24T20:00:00.000Z",
      updatedAt: "2026-07-24T23:00:00.000Z",
    },
    events: [
      {
        id: "event_1",
        itemId: "item_1",
        actorId: "agent-1",
        type: "item.progress",
        payload: { note: "private payload is not projected" },
        createdAt: "2026-07-24T22:55:00.000Z",
      },
      {
        id: "event_2",
        itemId: "item_1",
        actorId: null,
        type: "lease.expired",
        payload: {},
        createdAt: "2026-07-24T22:56:00.000Z",
      },
    ],
    artifacts: [],
  };
}

describe("dashboard actor activity contract", () => {
  test("deduplicates, validates, and caps board-derived candidates", () => {
    const values = Array.from({ length: 25 }, (_, index) => ({
      id: `item_${index}`,
      project: "scrapbook",
      title: `Item ${index}`,
      status: index % 2 ? "ready" : "active",
    }));
    values.splice(1, 0, { ...candidate, id: "item_0", title: "Item 0" });
    values.splice(2, 0, { ...candidate, id: "stn.tok_secret" });
    const result = normalizeActivityCandidates(values);
    expect(result).toHaveLength(MAX_ACTIVITY_ITEMS);
    expect(result[0]?.id).toBe("item_0");
    expect(new Set(result.map((entry) => entry.id)).size).toBe(result.length);
    expect(result.some((entry) => /stn\.tok_/i.test(entry.id))).toBe(false);
    expect(() => normalizeActivityCandidates(values, 21)).toThrow(/between 1 and 20/);
  });

  test("projects only bounded actor activity fields from item detail", () => {
    const detail = readActorActivityDetail(detailPayload(), candidate);
    expect(detail.item).toEqual({
      id: "item_1",
      project: "scrapbook",
      title: "Ship dashboard",
      status: "active",
      claimedBy: "agent-1",
      updatedAt: "2026-07-24T23:00:00.000Z",
    });
    expect(detail.events[0]).toEqual({
      id: "event_1",
      itemId: "item_1",
      actorId: "agent-1",
      type: "item.progress",
      createdAt: "2026-07-24T22:55:00.000Z",
    });
    expect(detail.events[0]).not.toHaveProperty("payload");
    expect(() => readActorActivityDetail(detailPayload(), { ...candidate, id: "item_2" })).toThrow(/outside the requested item boundary/);
    expect(() => readActorActivityDetail({ ...detailPayload(), item: { ...detailPayload().item, title: "stn.tok_secret" } }, candidate)).toThrow(/Credential-shaped/);
  });

  test("aggregates current claims and canonical actor events", () => {
    const detail = readActorActivityDetail(detailPayload(), candidate);
    const activity = aggregateActorActivity([detail], "2026-07-24T23:05:00.000Z") as any;
    expect(activity.sampledItems).toBe(1);
    expect(activity.observedEventCount).toBe(2);
    expect(activity.eventCount).toBe(2);
    expect(activity.systemEventCount).toBe(1);
    expect(activity.actorCount).toBe(1);
    expect(activity.actors[0]).toMatchObject({ id: "agent-1", eventCount: 1 });
    expect(activity.actors[0].currentClaims[0]).toMatchObject({ itemId: "item_1", status: "active" });
    expect(activity.actors[0].events[0]).toMatchObject({ type: "item.progress", itemTitle: "Ship dashboard" });
  });

  test("preserves result order while enforcing the concurrency cap", async () => {
    let active = 0;
    let maximum = 0;
    const values = Array.from({ length: 12 }, (_, index) => index);
    const results = await mapWithConcurrency(values, 4, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, (value % 3) + 1));
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBeLessThanOrEqual(4);
    expect(results).toEqual(values.map((value) => value * 2));
    await expect(mapWithConcurrency(values, 5, async (value) => value)).rejects.toThrow(/between 1 and 4/);
  });
});
