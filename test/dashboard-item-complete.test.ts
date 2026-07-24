import { describe, expect, test } from "bun:test";
import {
  canCompleteStatus,
  createCompleteIdempotencyTracker,
  readCompletedItem,
  validateCompleteInput,
} from "../site/item-complete.js";

const actor = { id: "human:leo", name: "Leo", kind: "human" } as const;

describe("dashboard completion contract", () => {
  test("validates optional bounded summary and active actor", () => {
    expect(validateCompleteInput("item_1", "Shipped with evidence", actor)).toEqual({
      id: "item_1",
      actor,
      action: "complete",
      summary: "Shipped with evidence",
    });
    expect(validateCompleteInput("item_1", "", actor)).toEqual({
      id: "item_1",
      actor,
      action: "complete",
    });
  });

  test("rejects invalid and credential-shaped fields", () => {
    expect(() => validateCompleteInput("", "done", actor)).toThrow("Item ID is required");
    expect(() => validateCompleteInput("item_1", "x".repeat(10_001), actor)).toThrow("at most 10000");
    expect(() => validateCompleteInput("item_1", "stn.tok_deadbeef", actor)).toThrow("Credential-shaped");
    expect(() => validateCompleteInput("item_1", "done", null)).toThrow("active session actor");
  });

  test("reduces a matching completed item to safe continuation fields", () => {
    const completed = readCompletedItem({
      item: {
        id: "item_1",
        status: "done",
        summary: "Shipped with evidence",
        claimedBy: null,
        claimExpiresAt: null,
        version: 4,
        tokenId: "must-not-survive",
        nextAction: "ignored",
      },
    }, { id: "item_1", summary: "Shipped with evidence" });
    expect(completed).toEqual({
      id: "item_1",
      status: "done",
      summary: "Shipped with evidence",
      version: 4,
    });
    expect(completed).not.toHaveProperty("tokenId");
    expect(completed).not.toHaveProperty("nextAction");
  });

  test("accepts preserved summary when no replacement was requested", () => {
    expect(readCompletedItem({
      item: {
        id: "item_1",
        status: "done",
        summary: "Existing summary",
        claimedBy: null,
        claimExpiresAt: null,
        version: 2,
      },
    }, { id: "item_1" }).summary).toBe("Existing summary");
  });

  test("rejects mismatched or malformed completion responses", () => {
    const base = {
      id: "item_1",
      status: "done",
      summary: "Done",
      claimedBy: null,
      claimExpiresAt: null,
      version: 2,
    };
    expect(() => readCompletedItem({ item: { ...base, id: "item_2" } }, { id: "item_1" })).toThrow("different completed item");
    expect(() => readCompletedItem({ item: { ...base, status: "ready" } })).toThrow("did not become done");
    expect(() => readCompletedItem({ item: { ...base, claimedBy: actor.id } })).toThrow("did not release");
    expect(() => readCompletedItem({ item: { ...base, version: 0 } })).toThrow("invalid version");
    expect(() => readCompletedItem({ item: base }, { summary: "Different" })).toThrow("different completion summary");
  });

  test("reuses one key for unchanged retries and rotates on input changes and reset", () => {
    let sequence = 0;
    const tracker = createCompleteIdempotencyTracker(() => `web_complete_${++sequence}`);
    const first = { id: "item_1", actor, action: "complete" as const, summary: "one" };
    expect(tracker.keyFor(first)).toBe("web_complete_1");
    expect(tracker.keyFor({ ...first })).toBe("web_complete_1");
    expect(tracker.keyFor({ ...first, summary: "two" })).toBe("web_complete_2");
    tracker.reset();
    expect(tracker.keyFor(first)).toBe("web_complete_3");
  });

  test("maps only eligible statuses to completion", () => {
    expect(canCompleteStatus("ready")).toBe(true);
    expect(canCompleteStatus("active")).toBe(true);
    expect(canCompleteStatus("blocked")).toBe(true);
    expect(canCompleteStatus("done")).toBe(false);
    expect(canCompleteStatus("archived")).toBe(false);
  });
});
