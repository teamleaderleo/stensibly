import { describe, expect, test } from "bun:test";
import {
  createRequestGate,
  payloadEntries,
  readItemDetail,
  safeArtifactHref,
} from "../site/item-detail.js";

describe("dashboard item detail response", () => {
  test("accepts a matching item with event and artifact arrays", () => {
    const payload = {
      item: { id: "item_1", title: "Inspect me" },
      events: [{ id: "evt_1" }, null, "bad"],
      artifacts: [{ id: "art_1" }, []],
    };

    expect(readItemDetail(payload, "item_1")).toEqual({
      item: payload.item,
      events: [{ id: "evt_1" }],
      artifacts: [{ id: "art_1" }],
    });
  });

  test("rejects malformed and mismatched responses", () => {
    expect(() => readItemDetail(null)).toThrow("incompatible item detail");
    expect(() => readItemDetail({ item: {}, events: [], artifacts: [] })).toThrow("missing an item ID");
    expect(() => readItemDetail({ item: { id: "item_2" }, events: [], artifacts: [] }, "item_1"))
      .toThrow("different item");
    expect(() => readItemDetail({ item: { id: "item_1" }, events: [] })).toThrow("missing events or artifacts");
  });
});

describe("dashboard artifact links", () => {
  test("allows explicit HTTP and HTTPS links", () => {
    expect(safeArtifactHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeArtifactHref("http://localhost:3000/file")).toBe("http://localhost:3000/file");
  });

  test("keeps other URI schemes and malformed values as text", () => {
    expect(safeArtifactHref("javascript:alert(1)")).toBeNull();
    expect(safeArtifactHref("file:///tmp/private")).toBeNull();
    expect(safeArtifactHref("git:teamleaderleo/stensibly@abc123")).toBeNull();
    expect(safeArtifactHref("not a url")).toBeNull();
    expect(safeArtifactHref(null)).toBeNull();
  });
});

describe("dashboard event payloads", () => {
  test("formats primitive and nested values without HTML interpretation", () => {
    expect(payloadEntries({
      summary: "<img src=x onerror=alert(1)>",
      count: 2,
      complete: false,
      nested: { next: "ship" },
      empty: null,
    })).toEqual([
      { key: "summary", value: "<img src=x onerror=alert(1)>" },
      { key: "count", value: "2" },
      { key: "complete", value: "false" },
      { key: "nested", value: '{"next":"ship"}' },
      { key: "empty", value: "null" },
    ]);
  });

  test("bounds long values", () => {
    expect(payloadEntries({ note: "x".repeat(20) }, 5)).toEqual([
      { key: "note", value: "xxxxx…" },
    ]);
    expect(payloadEntries(["not", "an", "object"])).toEqual([]);
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
