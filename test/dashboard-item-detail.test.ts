import { describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import {
  createRequestGate,
  dependencyBlocksCurrent,
  dependencyRelationship,
  payloadEntries,
  readItemDetail,
  readPublicEvent,
  redactCredentialText,
  reservationCapacityLabel,
  reservationIsFull,
  runIsActive,
  runStatusLabel,
  safeArtifactHref,
  safeRequestId,
} from "../site/item-detail.js";

describe("dashboard item detail response", () => {
  test("accepts matching item collections and filters malformed entries", () => {
    const validDependency = {
      id: "dep_1",
      direction: "outgoing" as const,
      kind: "depends_on" as const,
      itemId: "item_2",
      title: "Finish the API",
      status: "active",
      createdAt: "2026-07-25T00:00:00.000Z",
    };
    const validReservation = {
      id: "res_1",
      resource: "gpu:benchmark-pool",
      mode: "shared" as const,
      capacity: 5,
      units: 2,
      usedUnits: 4,
      availableUnits: 1,
      holderActorId: "alpha",
      expiresAt: "2026-07-25T01:00:00.000Z",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:30:00.000Z",
    };
    const validRun = {
      id: "run_1",
      itemId: "item_1",
      actorId: "alpha",
      harness: "codex",
      model: "gpt-5.6",
      externalRunId: "external-1",
      repository: "teamleaderleo/stensibly",
      branch: "feat/run-visibility",
      worktree: "/tmp/stensibly-run",
      status: "waiting" as const,
      childAgentCount: 2,
      toolCallCount: 14,
      startedAt: "2026-07-25T00:00:00.000Z",
      lastHeartbeatAt: "2026-07-25T00:30:00.000Z",
      endedAt: null,
      outcome: null,
    };
    const payload = {
      item: { id: "item_1", title: "Inspect me" },
      historyContractVersion: 1,
      eventsTruncated: false,
      events: [{
        id: "evt_1",
        itemId: "item_1",
        actorId: "alpha",
        type: "work.progressed",
        payload: { summary: "Implemented the bounded reader." },
        createdAt: "2026-07-25T00:40:00.000Z",
      }, null, "bad", { id: "evt_bad" }],
      artifacts: [{ id: "art_1" }, []],
      dependencies: [
        validDependency,
        null,
        { direction: "sideways", kind: "depends_on", itemId: "item_3" },
      ],
      reservations: [
        validReservation,
        null,
        { id: "res_bad", resource: "gpu", mode: "shared", capacity: 2, units: 3 },
      ],
      runs: [
        validRun,
        null,
        { ...validRun, id: "run_bad", itemId: "item_2" },
      ],
    };

    expect(readItemDetail(payload, "item_1")).toEqual({
      historyContractVersion: 1,
      eventsTruncated: false,
      item: payload.item,
      events: [{
        id: "evt_1",
        itemId: "item_1",
        actorId: "alpha",
        type: "work.progressed",
        payload: { summary: "Implemented the bounded reader." },
        createdAt: "2026-07-25T00:40:00.000Z",
      }],
      artifacts: [{ id: "art_1" }],
      dependencies: [validDependency],
      reservations: [validReservation],
      runs: [validRun],
    });
  });

  test("preserves legacy unknown completeness and requires an exact declared envelope", () => {
    const legacy = {
      item: { id: "item_1" },
      events: [],
      artifacts: [],
    };
    expect(readItemDetail(legacy, "item_1")).toMatchObject({
      historyContractVersion: null,
      eventsTruncated: null,
      events: [],
    });

    const hosted = {
      ...legacy,
      historyContractVersion: 1,
      eventsTruncated: false,
    };
    expect(readItemDetail(hosted, "item_1")).toMatchObject({
      historyContractVersion: 1,
      eventsTruncated: false,
      events: [],
    });
    expect(() => readItemDetail({ ...hosted, historyContractVersion: 2 }, "item_1"))
      .toThrow("incompatible history contract");
    expect(() => readItemDetail({ ...hosted, historyContractVersion: undefined }, "item_1"))
      .toThrow("incompatible history contract");
    expect(() => readItemDetail({ ...hosted, eventsTruncated: undefined }, "item_1"))
      .toThrow("missing event-history completeness");
    expect(() => readItemDetail({ ...legacy, eventsTruncated: false }, "item_1"))
      .toThrow("incompatible history contract");
  });

  test("reads the real SQLite API detail with unknown completeness", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = store.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Read local history",
        priority: 50,
        actor: { id: "leo", name: "Leo", kind: "human" },
      });
      const app = createServerApp(store);
      const response = await app.request(`/api/v1/items/${encodeURIComponent(item.id)}`);
      expect(response.status).toBe(200);

      const detail = readItemDetail(await response.json(), item.id);
      expect(detail.historyContractVersion).toBeNull();
      expect(detail.eventsTruncated).toBeNull();
      expect(detail.item).toMatchObject({ id: item.id, project: "scrapbook" });
      expect(detail.events.map((event) => event.type)).toContain("item.created");
    } finally {
      store.close();
    }
  });

  test("keeps attributable public events while dropping malformed cores", () => {
    const event = (actorId: string) => ({
      id: `evt_${actorId}`,
      itemId: "item_1",
      actorId,
      type: "review.responded",
      payload: "legacy prose",
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    expect(readPublicEvent(event("plover"), "item_1")).toEqual({
      ...event("plover"),
      payload: {},
    });
    expect(readPublicEvent(event("keystone"), "item_1")?.actorId).toBe("keystone");
    expect(readPublicEvent({ ...event("plover"), actorId: null }, "item_1")?.actorId).toBeNull();
    const missingActor = { ...event("plover") } as Record<string, unknown>;
    delete missingActor.actorId;
    expect(readPublicEvent(missingActor, "item_1")).toBeNull();
    expect(readPublicEvent({ ...event("plover"), itemId: "item_2" }, "item_1")).toBeNull();
    expect(readPublicEvent({ ...event("plover"), createdAt: "not-a-time" }, "item_1")).toBeNull();
    expect(readPublicEvent({ ...event("plover"), type: "bad\nkind" }, "item_1")).toBeNull();
    expect(readPublicEvent(event("plo\u0085ver"), "item_1")).toBeNull();
    expect(readPublicEvent(event("plo\u2028ver"), "item_1")).toBeNull();
    expect(readPublicEvent(event("plo\u202ever"), "item_1")).toBeNull();
    expect(readPublicEvent(event("plo\u2066ver"), "item_1")).toBeNull();
  });

  test("bounds public event payload keys without losing the event", () => {
    const payload = Object.fromEntries([
      ["constructor", "ignored"],
      ["bad\u0085key", "ignored"],
      ["bad\u2066key", "ignored"],
      ...Array.from({ length: 25 }, (_, index) => [`field_${index}`, index]),
    ]);
    const event = readPublicEvent({
      id: "evt_1",
      itemId: "item_1",
      actorId: null,
      type: "system.updated",
      payload,
      createdAt: "2026-07-25T00:00:00.000Z",
    }, "item_1");
    expect(event).not.toBeNull();
    expect(Object.keys(event?.payload || {})).toHaveLength(20);
    expect(Object.hasOwn(event?.payload || {}, "constructor")).toBe(false);
    expect(Object.hasOwn(event?.payload || {}, "bad\u0085key")).toBe(false);
    expect(Object.hasOwn(event?.payload || {}, "bad\u2066key")).toBe(false);
    expect(event?.payload).toHaveProperty("field_0", 0);
    expect(event?.payload).not.toHaveProperty("field_20");
  });

  test("rejects malformed and mismatched responses", () => {
    expect(() => readItemDetail(null)).toThrow("incompatible item detail");
    expect(() => readItemDetail({ item: {}, events: [], artifacts: [], historyContractVersion: 1, eventsTruncated: false })).toThrow("missing an item ID");
    expect(() => readItemDetail({ item: { id: "item_2" }, events: [], artifacts: [], historyContractVersion: 1, eventsTruncated: false }, "item_1"))
      .toThrow("different item");
    expect(() => readItemDetail({ item: { id: "item_1" }, events: [], historyContractVersion: 1, eventsTruncated: false })).toThrow("missing events or artifacts");
    expect(() => readItemDetail({ item: { id: "item_1" }, events: [], artifacts: [], dependencies: {}, historyContractVersion: 1, eventsTruncated: false }))
      .toThrow("incompatible dependencies");
    expect(() => readItemDetail({ item: { id: "item_1" }, events: [], artifacts: [], reservations: {}, historyContractVersion: 1, eventsTruncated: false }))
      .toThrow("incompatible reservations");
    expect(() => readItemDetail({ item: { id: "item_1" }, events: [], artifacts: [], runs: {}, historyContractVersion: 1, eventsTruncated: false }))
      .toThrow("incompatible runs");
  });
});

describe("dashboard dependency relationships", () => {
  test("describes both sides of dependency links", () => {
    expect(dependencyRelationship({ direction: "outgoing", kind: "depends_on" })).toBe("Depends on");
    expect(dependencyRelationship({ direction: "incoming", kind: "depends_on" })).toBe("Required by");
    expect(dependencyRelationship({ direction: "outgoing", kind: "blocks" })).toBe("Blocks");
    expect(dependencyRelationship({ direction: "incoming", kind: "blocks" })).toBe("Blocked by");
    expect(dependencyRelationship({ direction: "outgoing", kind: "related_to" })).toBe("Related to");
  });

  test("flags only unresolved links that block the current item", () => {
    expect(dependencyBlocksCurrent({ direction: "outgoing", kind: "depends_on", status: "active" })).toBe(true);
    expect(dependencyBlocksCurrent({ direction: "incoming", kind: "blocks", status: "ready" })).toBe(true);
    expect(dependencyBlocksCurrent({ direction: "outgoing", kind: "depends_on", status: "done" })).toBe(false);
    expect(dependencyBlocksCurrent({ direction: "outgoing", kind: "blocks", status: "active" })).toBe(false);
    expect(dependencyBlocksCurrent({ direction: "outgoing", kind: "depends_on", status: "" })).toBe(false);
  });
});

describe("dashboard reservation capacity", () => {
  test("describes live usage and remaining capacity", () => {
    expect(reservationCapacityLabel({ capacity: 5, usedUnits: 4, availableUnits: 1 }))
      .toBe("4 of 5 units used · 1 available");
    expect(reservationCapacityLabel({ capacity: 1, usedUnits: 1, availableUnits: 0 }))
      .toBe("1 of 1 units used · 0 available");
    expect(reservationCapacityLabel({ capacity: 0, usedUnits: 0, availableUnits: 0 }))
      .toBe("Capacity unavailable");
  });

  test("marks only validated zero-availability snapshots as full", () => {
    expect(reservationIsFull({ availableUnits: 0 })).toBe(true);
    expect(reservationIsFull({ availableUnits: 1 })).toBe(false);
    expect(reservationIsFull({ availableUnits: -1 })).toBe(false);
    expect(reservationIsFull({})).toBe(false);
  });
});

describe("dashboard agent run state", () => {
  test("labels active and terminal states", () => {
    expect(runIsActive({ status: "running" })).toBe(true);
    expect(runIsActive({ status: "waiting" })).toBe(true);
    expect(runIsActive({ status: "succeeded" })).toBe(false);
    expect(runStatusLabel({ status: "failed" })).toBe("failed");
    expect(runStatusLabel({})).toBe("status unavailable");
  });

  test("filters impossible lifecycle and counter combinations", () => {
    const base = {
      id: "run_1",
      itemId: "item_1",
      actorId: "alpha",
      harness: "codex",
      model: null,
      externalRunId: null,
      repository: null,
      branch: null,
      worktree: null,
      status: "running",
      childAgentCount: 0,
      toolCallCount: 1,
      startedAt: "2026-07-25T00:00:00.000Z",
      lastHeartbeatAt: "2026-07-25T00:01:00.000Z",
      endedAt: null,
      outcome: null,
    };
    const payload = (run: Record<string, unknown>) => ({
      item: { id: "item_1" },
      events: [],
      artifacts: [],
      historyContractVersion: 1,
      eventsTruncated: false,
      runs: [run],
    });
    expect(readItemDetail(payload({ ...base, endedAt: "2026-07-25T00:02:00.000Z" }), "item_1").runs)
      .toEqual([]);
    expect(readItemDetail(payload({ ...base, status: "succeeded" }), "item_1").runs)
      .toEqual([]);
    expect(readItemDetail(payload({ ...base, childAgentCount: -1 }), "item_1").runs)
      .toEqual([]);
    expect(readItemDetail(payload({ ...base, lastHeartbeatAt: "2026-07-24T23:59:00.000Z" }), "item_1").runs)
      .toEqual([]);
  });
});

describe("dashboard artifact links", () => {
  test("allows only explicit HTTP and HTTPS links", () => {
    expect(safeArtifactHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeArtifactHref("http://localhost:3000/file")).toBe("http://localhost:3000/file");
    expect(safeArtifactHref("javascript:alert(1)")).toBeNull();
    expect(safeArtifactHref("file:///tmp/private")).toBeNull();
    expect(safeArtifactHref("git:teamleaderleo/stensibly@abc123")).toBeNull();
    expect(safeArtifactHref("not a url")).toBeNull();
  });
});

describe("dashboard event payloads", () => {
  test("formats primitive, nested, HTML-looking, and undefined values as text", () => {
    expect(payloadEntries({
      summary: "<img src=x onerror=alert(1)>",
      count: 2,
      complete: false,
      nested: { next: "ship" },
      empty: null,
      missing: undefined,
    })).toEqual([
      { key: "summary", value: "<img src=x onerror=alert(1)>" },
      { key: "count", value: "2" },
      { key: "complete", value: "false" },
      { key: "nested", value: '{"next":"ship"}' },
      { key: "empty", value: "null" },
      { key: "missing", value: "undefined" },
    ]);
  });

  test("bounds value length and entry count", () => {
    expect(payloadEntries({ note: "x".repeat(20) }, 5)).toEqual([
      { key: "note", value: "xxxxx…" },
    ]);
    expect(payloadEntries({ one: 1, two: 2, three: 3 }, 20, 2)).toEqual([
      { key: "one", value: "1" },
      { key: "two", value: "2" },
    ]);
    expect(payloadEntries(["not", "an", "object"])).toEqual([]);
  });
});

describe("dashboard credential redaction", () => {
  test("removes active and token-shaped values from rendered text", () => {
    expect(redactCredentialText("failed stn.tok_secret.value")).toBe("failed [redacted token]");
    expect(redactCredentialText("prefix active-token suffix", "active-token"))
      .toBe("prefix [redacted token] suffix");
    expect(payloadEntries({ secret: "stn.tok_secret.value" })).toEqual([
      { key: "secret", value: "[redacted token]" },
    ]);
  });
});

describe("dashboard detail request IDs", () => {
  test("allows compact IDs and rejects credential-shaped or unsafe values", () => {
    expect(safeRequestId("req_abc-123:4")).toBe("req_abc-123:4");
    expect(safeRequestId("stn.tok_secret")).toBeNull();
    expect(safeRequestId("prefix-active-token", "active-token")).toBeNull();
    expect(safeRequestId("contains spaces")).toBeNull();
    expect(safeRequestId("x".repeat(161))).toBeNull();
  });
});

describe("dashboard detail request gate", () => {
  test("invalidates old requests after a newer request or close", () => {
    const gate = createRequestGate();
    const first = gate.begin();
    expect(gate.isCurrent(first)).toBe(true);

    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);

    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });
});
