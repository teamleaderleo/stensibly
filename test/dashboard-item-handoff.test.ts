import { describe, expect, test } from "bun:test";
import {
  canHandoffStatus,
  createHandoffIdempotencyTracker,
  handoffEventLabel,
  readHandedOffItem,
  validateHandoffInput,
} from "../site/item-handoff.js";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" };

describe("dashboard handoff contract", () => {
  test("validates required continuation fields and optional target actor", () => {
    expect(validateHandoffInput(
      " item_1 ",
      " Current work is reviewed. ",
      " Run the production verifier. ",
      " agent-2 ",
      actor,
    )).toEqual({
      id: "item_1",
      actor,
      action: "handoff",
      summary: "Current work is reviewed.",
      nextAction: "Run the production verifier.",
      toActorId: "agent-2",
    });
    expect(validateHandoffInput("item_1", "Summary", "Next", "", actor)).not.toHaveProperty("toActorId");
  });

  test("rejects missing, oversized, and credential-shaped fields", () => {
    expect(() => validateHandoffInput("", "Summary", "Next", "", actor)).toThrow(/Item ID/);
    expect(() => validateHandoffInput("item_1", "", "Next", "", actor)).toThrow(/summary/i);
    expect(() => validateHandoffInput("item_1", "Summary", "", "", actor)).toThrow(/next action/i);
    expect(() => validateHandoffInput("item_1", "x".repeat(10_001), "Next", "", actor)).toThrow(/maximum 10000/);
    expect(() => validateHandoffInput("item_1", "Summary", "x".repeat(2_001), "", actor)).toThrow(/maximum 2000/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "x".repeat(121), actor)).toThrow(/at most 120/);
    expect(() => validateHandoffInput("item_1", "stn.tok_secret", "Next", "", actor)).toThrow(/Credential-shaped/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "stn.tok_secret", actor)).toThrow(/Credential-shaped/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "", null)).toThrow(/active session actor/);
  });

  test("accepts only a ready, released, matching handoff result", () => {
    const payload = {
      item: {
        id: "item_1",
        status: "ready",
        summary: "Current work is reviewed.",
        nextAction: "Run the production verifier.",
        claimedBy: null,
        claimExpiresAt: null,
        version: 7,
      },
    };
    expect(readHandedOffItem(payload, {
      id: "item_1",
      summary: "Current work is reviewed.",
      nextAction: "Run the production verifier.",
    })).toEqual({
      id: "item_1",
      status: "ready",
      summary: "Current work is reviewed.",
      nextAction: "Run the production verifier.",
      version: 7,
    });
    expect(() => readHandedOffItem({ item: { ...payload.item, status: "active" } }, { id: "item_1" })).toThrow(/did not become ready/);
    expect(() => readHandedOffItem({ item: { ...payload.item, claimedBy: "agent-1" } }, { id: "item_1" })).toThrow(/release its claim/);
    expect(() => readHandedOffItem({ item: { ...payload.item, id: "item_2" } }, { id: "item_1" })).toThrow(/different handed-off item/);
    expect(() => readHandedOffItem({ item: { ...payload.item, summary: "Other" } }, { summary: payload.item.summary })).toThrow(/different handoff summary/);
    expect(() => readHandedOffItem({ item: { ...payload.item, nextAction: "Other" } }, { nextAction: payload.item.nextAction })).toThrow(/different handoff next action/);
    expect(() => readHandedOffItem({ item: { ...payload.item, version: 0 } })).toThrow(/invalid version/);
  });

  test("reuses one idempotency key for unchanged input and rotates on change or reset", () => {
    let count = 0;
    const tracker = createHandoffIdempotencyTracker(() => `key-${++count}`);
    const input = validateHandoffInput("item_1", "Summary", "Next", "agent-2", actor);
    expect(tracker.keyFor(input)).toBe("key-1");
    expect(tracker.keyFor({ ...input })).toBe("key-1");
    expect(tracker.keyFor({ ...input, nextAction: "Different" })).toBe("key-2");
    tracker.reset();
    expect(tracker.keyFor(input)).toBe("key-3");
  });

  test("maps eligible statuses and labels canonical handoff history", () => {
    expect(["ready", "active", "blocked"].every(canHandoffStatus)).toBe(true);
    expect(canHandoffStatus("done")).toBe(false);
    expect(canHandoffStatus("archived")).toBe(false);
    expect(handoffEventLabel("work.handed_off")).toBe("Handoff · work.handed_off");
    expect(handoffEventLabel("item.progress")).toBe("item.progress");
  });
});
