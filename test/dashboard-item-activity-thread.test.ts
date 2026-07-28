import { describe, expect, test } from "bun:test";
import {
  activityEventAnchorId,
  activityThreadFilterOptions,
  filterActivityThread,
  projectActivityThread,
} from "../site/item-activity-thread.js";

const actorCallsignKey = (actorId: string, callsign: string) =>
  `actor+callsign:${JSON.stringify([actorId, callsign])}`;

describe("dashboard item activity thread projection", () => {
  test("preserves canonical order and keeps callsigns distinct under one actor", () => {
    const entries = projectActivityThread([
      {
        id: "evt_1",
        type: "work.progress",
        actorId: "github:13091533",
        createdAt: "2026-07-28T10:00:00.000Z",
        payload: { callsign: "Keystone", runId: "run_1", summary: "Reviewed the parser." },
      },
      {
        id: "evt_2",
        type: "review.requested",
        actorId: "github:13091533",
        createdAt: "2026-07-28T10:01:00.000Z",
        payload: { callsign: "Tern", runId: "run_2", summary: "Requested exact-head review." },
      },
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["evt_1", "evt_2"]);
    expect(entries.map((entry) => entry.actorKey)).toEqual([
      actorCallsignKey("github:13091533", "Keystone"),
      actorCallsignKey("github:13091533", "Tern"),
    ]);
    expect(activityThreadFilterOptions(entries).actors).toEqual([
      {
        value: actorCallsignKey("github:13091533", "Keystone"),
        label: "Keystone · github:13091533",
      },
      {
        value: actorCallsignKey("github:13091533", "Tern"),
        label: "Tern · github:13091533",
      },
    ]);
  });

  test("derives stable collision-safe anchors from exact public event IDs", () => {
    expect(activityEventAnchorId("evt_review/1", 0)).toBe("activity-event-evt_review%2F1");
    expect(activityEventAnchorId("evt_review%2F1", 0)).toBe("activity-event-evt_review%252F1");
    expect(activityEventAnchorId("", 4)).toBe("activity-event-5");
    expect(activityEventAnchorId("bad\u202eid", 2)).toBe("activity-event-3");

    const entries = projectActivityThread([
      { id: "evt_first", type: "work.progress", payload: {} },
      { id: "evt_review/1", type: "review.requested", payload: {} },
      { type: "legacy.event", payload: {} },
    ]);
    expect(entries.map((entry) => entry.anchorId)).toEqual([
      "activity-event-evt_first",
      "activity-event-evt_review%2F1",
      "activity-event-3",
    ]);
  });

  test("keeps different actors separate when they reuse one callsign", () => {
    const entries = projectActivityThread([
      { id: "evt_1", type: "work.progress", actorId: "actor_a", payload: { callsign: "Lantern" } },
      { id: "evt_2", type: "work.progress", actorId: "actor_b", payload: { callsign: "Lantern" } },
    ]);
    const first = actorCallsignKey("actor_a", "Lantern");
    const second = actorCallsignKey("actor_b", "Lantern");

    expect(activityThreadFilterOptions(entries).actors).toEqual([
      { value: first, label: "Lantern · actor_a" },
      { value: second, label: "Lantern · actor_b" },
    ]);
    expect(filterActivityThread(entries, { actor: first }).map((entry) => entry.id)).toEqual(["evt_1"]);
    expect(filterActivityThread(entries, { actor: second }).map((entry) => entry.id)).toEqual(["evt_2"]);
  });

  test("renders payload relationship names as flat data without causal authority", () => {
    const entries = projectActivityThread([
      { id: "evt_1", type: "work.progress", payload: {} },
      { id: "evt_2", type: "review.requested", payload: { replyToEventId: "evt_1" } },
      { id: "evt_3", type: "review.accepted", payload: { causedByEventId: "evt_2" } },
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(entries.every((entry) => !("relationship" in entry) && !("depth" in entry))).toBe(true);
    expect(entries[1]?.payloadEntries).toContainEqual({ key: "replyToEventId", value: "evt_1" });
    expect(entries[2]?.payloadEntries).toContainEqual({ key: "causedByEventId", value: "evt_2" });
  });

  test("filters by actor, run, and event type without reordering", () => {
    const entries = projectActivityThread([
      { id: "evt_1", type: "work.progress", actorId: "alpha", payload: { runId: "run_1" } },
      { id: "evt_2", type: "review.requested", actorId: "beta", payload: { runId: "run_2" } },
      { id: "evt_3", type: "work.progress", actorId: "alpha", payload: { runId: "run_1" } },
    ]);

    const alpha = `actor:${JSON.stringify("alpha")}`;
    expect(filterActivityThread(entries, { actor: alpha }).map((entry) => entry.id))
      .toEqual(["evt_1", "evt_3"]);
    expect(filterActivityThread(entries, { run: "run_2" }).map((entry) => entry.id))
      .toEqual(["evt_2"]);
    expect(filterActivityThread(entries, { type: "work.progress" }).map((entry) => entry.id))
      .toEqual(["evt_1", "evt_3"]);
    expect(filterActivityThread(entries).map((entry) => entry.id))
      .toEqual(["evt_1", "evt_2", "evt_3"]);
  });

  test("rejects unsafe or unbounded descriptive metadata", () => {
    const [entry] = projectActivityThread([{
      id: "evt_1",
      type: "work.progress",
      actorId: "actor_a",
      payload: {
        callsign: "Lan\u202Etern",
        actorDisplayName: "A".repeat(161),
        runId: "R".repeat(201),
        summary: "S".repeat(501),
      },
    }]);

    expect(entry).toMatchObject({
      actorKey: `actor:${JSON.stringify("actor_a")}`,
      actorLabel: "actor_a",
      callsign: "",
      actorName: "",
      runId: "",
      summary: "",
    });
  });
});
