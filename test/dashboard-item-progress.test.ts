import { describe, expect, test } from "bun:test";
import {
  PROGRESS_EVENT_TYPE,
  createProgressIdempotencyTracker,
  readProgressEvent,
  validateProgressInput,
} from "../site/item-progress.js";

const actor = { id: "human:leo", name: "Leo", kind: "human" } as const;

describe("dashboard progress contract", () => {
  test("validates the bounded progress payload and exact event type", () => {
    expect(validateProgressInput("item_1", "Implemented the parser", "Review the PR", actor)).toEqual({
      id: "item_1",
      actor,
      type: PROGRESS_EVENT_TYPE,
      payload: { summary: "Implemented the parser", nextAction: "Review the PR" },
    });
    expect(validateProgressInput("item_1", "Implemented the parser", "", actor).payload).toEqual({
      summary: "Implemented the parser",
    });
  });

  test("rejects missing, oversized, and credential-shaped fields", () => {
    expect(() => validateProgressInput("item_1", "", "", actor)).toThrow("Progress summary is required");
    expect(() => validateProgressInput("item_1", "x".repeat(10_001), "", actor)).toThrow("maximum 10000");
    expect(() => validateProgressInput("item_1", "ok", "x".repeat(2_001), actor)).toThrow("at most 2000");
    expect(() => validateProgressInput("item_1", "stn.tok_deadbeef", "", actor)).toThrow("Credential-shaped");
    expect(() => validateProgressInput("item_1", "ok", "", null)).toThrow("active session actor");
  });

  test("reduces a matching server event to safe continuation fields", () => {
    const event = readProgressEvent({
      event: {
        id: "event_1",
        itemId: "item_1",
        actorId: actor.id,
        type: PROGRESS_EVENT_TYPE,
        payload: { summary: "Implemented the parser", nextAction: "Review the PR", private: "ignored" },
        createdAt: "2026-07-24T20:00:00.000Z",
        tokenId: "must-not-survive",
      },
    }, {
      itemId: "item_1",
      actorId: actor.id,
      summary: "Implemented the parser",
      nextAction: "Review the PR",
    });
    expect(event).toEqual({
      id: "event_1",
      itemId: "item_1",
      actorId: actor.id,
      type: PROGRESS_EVENT_TYPE,
      createdAt: "2026-07-24T20:00:00.000Z",
    });
    expect(event).not.toHaveProperty("payload");
    expect(event).not.toHaveProperty("tokenId");
  });

  test("rejects mismatched and malformed event responses", () => {
    const base = {
      id: "event_1",
      itemId: "item_1",
      actorId: actor.id,
      type: PROGRESS_EVENT_TYPE,
      payload: { summary: "Implemented" },
      createdAt: "2026-07-24T20:00:00.000Z",
    };
    expect(() => readProgressEvent({ event: { ...base, itemId: "item_2" } }, { itemId: "item_1" })).toThrow("different item");
    expect(() => readProgressEvent({ event: { ...base, actorId: "agent:other" } }, { actorId: actor.id })).toThrow("different actor");
    expect(() => readProgressEvent({ event: { ...base, type: "item.warning" } })).toThrow("different event type");
    expect(() => readProgressEvent({ event: { ...base, createdAt: "not-a-date" } })).toThrow("invalid timestamp");
    expect(() => readProgressEvent({ event: { ...base, payload: {} } })).toThrow("missing its summary");
  });

  test("reuses one key for unchanged retries and rotates when input changes or resets", () => {
    let sequence = 0;
    const tracker = createProgressIdempotencyTracker(() => `web_progress_${++sequence}`);
    const first = { id: "item_1", actor, type: PROGRESS_EVENT_TYPE, payload: { summary: "one" } };
    expect(tracker.keyFor(first)).toBe("web_progress_1");
    expect(tracker.keyFor({ ...first, payload: { summary: "one" } })).toBe("web_progress_1");
    expect(tracker.keyFor({ ...first, payload: { summary: "two" } })).toBe("web_progress_2");
    tracker.reset();
    expect(tracker.keyFor(first)).toBe("web_progress_3");
  });
});
