import { describe, expect, test } from "bun:test";
import {
  canCompleteStatus,
  createCompleteIdempotencyTracker,
  readCompletedItem,
  validateCompleteInput,
} from "../site/item-complete.js";

const actor = { id: "human:leo", name: "Leo", kind: "human" } as const;

describe("dashboard completion contract", () => {
  test("validates optional bounded summary, active actor, and current generation", () => {
    expect(validateCompleteInput("item_1", "Shipped with evidence", actor, 7)).toEqual({
      id: "item_1",
      actor,
      action: "complete",
      expectedClaimGeneration: 7,
      summary: "Shipped with evidence",
    });
    expect(validateCompleteInput("item_1", "", actor, 0)).toEqual({
      id: "item_1",
      actor,
      action: "complete",
      expectedClaimGeneration: 0,
    });
  });

  test("rejects invalid, credential-shaped, and unfenced fields", () => {
    expect(() => validateCompleteInput("", "done", actor, 0)).toThrow("Item ID is required");
    expect(() => validateCompleteInput("item_1", "x".repeat(10_001), actor, 0)).toThrow("at most 10000");
    expect(() => validateCompleteInput("item_1", "stn.tok_deadbeef", actor, 0)).toThrow("Credential-shaped");
    expect(() => validateCompleteInput("item_1", "done", null, 0)).toThrow("active session actor");
    expect(() => validateCompleteInput("item_1", "done", actor, undefined)).toThrow("current claim generation");
    expect(() => validateCompleteInput("item_1", "done", actor, -1)).toThrow("current claim generation");
  });

  test("reduces a matching completed item to safe continuation fields", () => {
    const completed = readCompletedItem({
      item: {
        id: "item_1",
        status: "done",
        summary: "Shipped with evidence",
        claimedBy: null,
        claimExpiresAt: null,
        claimGeneration: 8,
        version: 4,
        tokenId: "must-not-survive",
        nextAction: "ignored",
      },
    }, {
      id: "item_1",
      expectedClaimGeneration: 7,
      summary: "Shipped with evidence",
    });
    expect(completed).toEqual({
      id: "item_1",
      status: "done",
      summary: "Shipped with evidence",
      claimGeneration: 8,
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
        claimGeneration: 1,
        version: 2,
      },
    }, { id: "item_1", expectedClaimGeneration: 0 }).summary).toBe("Existing summary");
  });

  test("rejects mismatched, malformed, or non-advancing completion responses", () => {
    const base = {
      id: "item_1",
      status: "done",
      summary: "Done",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: 3,
      version: 2,
    };
    const expected = { id: "item_1", expectedClaimGeneration: 2 };
    expect(() => readCompletedItem({ item: { ...base, id: "item_2" } }, expected)).toThrow("different completed item");
    expect(() => readCompletedItem({ item: { ...base, status: "ready" } }, expected)).toThrow("did not become done");
    expect(() => readCompletedItem({ item: { ...base, claimedBy: actor.id } }, expected)).toThrow("did not release");
    expect(() => readCompletedItem({ item: { ...base, version: 0 } }, expected)).toThrow("invalid version");
    expect(() => readCompletedItem({ item: { ...base, claimGeneration: 2 } }, expected)).toThrow("exactly once");
    expect(() => readCompletedItem({ item: { ...base, claimGeneration: 4 } }, expected)).toThrow("exactly once");
    expect(() => readCompletedItem({ item: base }, { ...expected, summary: "Different" })).toThrow("different completion summary");
  });

  test("reuses one key for unchanged retries and rotates on generation, input, and reset", () => {
    let sequence = 0;
    const tracker = createCompleteIdempotencyTracker(() => `web_complete_${++sequence}`);
    const first = {
      id: "item_1",
      actor,
      action: "complete" as const,
      expectedClaimGeneration: 7,
      summary: "one",
    };
    expect(tracker.keyFor(first)).toBe("web_complete_1");
    expect(tracker.keyFor({ ...first })).toBe("web_complete_1");
    expect(tracker.keyFor({ ...first, expectedClaimGeneration: 8 })).toBe("web_complete_2");
    expect(tracker.keyFor({ ...first, summary: "two" })).toBe("web_complete_3");
    tracker.reset();
    expect(tracker.keyFor(first)).toBe("web_complete_4");
  });

  test("maps only eligible statuses to completion", () => {
    expect(canCompleteStatus("ready")).toBe(true);
    expect(canCompleteStatus("active")).toBe(true);
    expect(canCompleteStatus("blocked")).toBe(true);
    expect(canCompleteStatus("done")).toBe(false);
    expect(canCompleteStatus("archived")).toBe(false);
  });
});
