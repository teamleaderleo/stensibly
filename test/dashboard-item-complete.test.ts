import { describe, expect, test } from "bun:test";
import {
  canCompleteStatus,
  createCompletionIdempotencyTracker,
  readCompletedItem,
  validateCompleteInput,
} from "../site/item-complete.js";

const actor = { id: "human:leo", name: "Leo", kind: "human" } as const;

describe("dashboard completion input", () => {
  test("normalizes optional summaries without sending blank replacements", () => {
    expect(validateCompleteInput(" item_1 ", " Completed with evidence ", actor)).toEqual({
      id: "item_1",
      actor,
      action: "complete",
      summary: "Completed with evidence",
    });
    expect(validateCompleteInput("item_1", "   ", actor)).toEqual({
      id: "item_1",
      actor,
      action: "complete",
    });
  });

  test("enforces actor, text, and credential boundaries", () => {
    expect(() => validateCompleteInput("item_1", "x".repeat(10_001), actor)).toThrow("at most 10000");
    expect(() => validateCompleteInput("item_1", "stn.tok_secret", actor)).toThrow("Credential-shaped");
    expect(() => validateCompleteInput("item_1", "", null)).toThrow("active session actor");
  });
});

describe("dashboard completion response", () => {
  const base = {
    id: "item_1",
    status: "done",
    summary: "Original summary",
    nextAction: null,
    claimedBy: null,
    claimExpiresAt: null,
    version: 4,
  };

  test("accepts safe preserve and replace continuations", () => {
    const preserve = validateCompleteInput("item_1", "", actor);
    expect(readCompletedItem({ item: { ...base, private: "ignored" } }, { ...preserve, previousSummary: "Original summary" })).toEqual({
      id: "item_1",
      status: "done",
      summary: "Original summary",
      nextAction: null,
      version: 4,
    });
    const replace = validateCompleteInput("item_1", "Completed with evidence", actor);
    expect(readCompletedItem({ item: { ...base, summary: "Completed with evidence" } }, { ...replace, previousSummary: "Original summary" })).toEqual({
      id: "item_1",
      status: "done",
      summary: "Completed with evidence",
      nextAction: null,
      version: 4,
    });
  });

  test("rejects mismatched status, summary, next action, lease, and version", () => {
    const preserve = validateCompleteInput("item_1", "", actor);
    expect(() => readCompletedItem({ item: { ...base, id: "item_2" } }, preserve)).toThrow("different completed item");
    expect(() => readCompletedItem({ item: { ...base, status: "active" } }, preserve)).toThrow("did not become done");
    expect(() => readCompletedItem({ item: { ...base, summary: "Changed" } }, { ...preserve, previousSummary: "Original summary" })).toThrow("did not preserve");
    expect(() => readCompletedItem({ item: { ...base, nextAction: "Still here" } }, preserve)).toThrow("did not clear its next action");
    expect(() => readCompletedItem({ item: { ...base, claimedBy: "agent:other" } }, preserve)).toThrow("did not release its claim");
    expect(() => readCompletedItem({ item: { ...base, version: 0 } }, preserve)).toThrow("invalid version");
    expect(() => readCompletedItem({ item: { ...base, summary: "stn.tok_secret" } }, preserve)).toThrow("Credential-shaped");
  });
});

describe("dashboard completion idempotency and status mapping", () => {
  test("reuses a key for unchanged completion and rotates on summary or reset", () => {
    let sequence = 0;
    const tracker = createCompletionIdempotencyTracker(() => `web_complete_${++sequence}`);
    const first = validateCompleteInput("item_1", "", actor);
    expect(tracker.keyFor(first)).toBe("web_complete_1");
    expect(tracker.keyFor({ ...first, actor: { ...actor } })).toBe("web_complete_1");
    expect(tracker.keyFor(validateCompleteInput("item_1", "Final", actor))).toBe("web_complete_2");
    tracker.reset();
    expect(tracker.keyFor(first)).toBe("web_complete_3");
  });

  test("presents completion only for nonterminal workflow states", () => {
    expect(canCompleteStatus("ready")).toBe(true);
    expect(canCompleteStatus("active")).toBe(true);
    expect(canCompleteStatus("blocked")).toBe(true);
    expect(canCompleteStatus("done")).toBe(false);
    expect(canCompleteStatus("archived")).toBe(false);
  });
});
