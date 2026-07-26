import { describe, expect, test } from "bun:test";
import {
  canHandoffStatus,
  createHandoffIdempotencyTracker,
  handoffEventLabel,
  readHandedOffItem,
  validateHandoffInput,
} from "../site/item-handoff.js";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };

describe("dashboard handoff contract", () => {
  test("validates required continuation fields, target actor, and current generation", () => {
    expect(validateHandoffInput(
      " item_1 ",
      " Current work is reviewed. ",
      " Run the production verifier. ",
      " agent-2 ",
      actor,
      7,
    )).toEqual({
      id: "item_1",
      actor,
      action: "handoff",
      expectedClaimGeneration: 7,
      summary: "Current work is reviewed.",
      nextAction: "Run the production verifier.",
      toActorId: "agent-2",
    });
    expect(validateHandoffInput("item_1", "Summary", "Next", "", actor, 0))
      .toMatchObject({ expectedClaimGeneration: 0 });
  });

  test("rejects missing, oversized, credential-shaped, and unfenced fields", () => {
    expect(() => validateHandoffInput("", "Summary", "Next", "", actor, 0)).toThrow(/Item ID/);
    expect(() => validateHandoffInput("item_1", "", "Next", "", actor, 0)).toThrow(/summary/i);
    expect(() => validateHandoffInput("item_1", "Summary", "", "", actor, 0)).toThrow(/next action/i);
    expect(() => validateHandoffInput("item_1", "x".repeat(10_001), "Next", "", actor, 0)).toThrow(/maximum 10000/);
    expect(() => validateHandoffInput("item_1", "Summary", "x".repeat(2_001), "", actor, 0)).toThrow(/maximum 2000/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "x".repeat(121), actor, 0)).toThrow(/at most 120/);
    expect(() => validateHandoffInput("item_1", "stn.tok_secret", "Next", "", actor, 0)).toThrow(/Credential-shaped/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "stn.tok_secret", actor, 0)).toThrow(/Credential-shaped/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "", null, 0)).toThrow(/active session actor/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "", actor, undefined)).toThrow(/current claim generation/);
    expect(() => validateHandoffInput("item_1", "Summary", "Next", "", actor, -1)).toThrow(/current claim generation/);
  });

  test("accepts only a ready, released, matching, generation-advanced handoff result", () => {
    const payload = {
      item: {
        id: "item_1",
        status: "ready",
        summary: "Current work is reviewed.",
        nextAction: "Run the production verifier.",
        claimedBy: null,
        claimExpiresAt: null,
        claimGeneration: 8,
        version: 7,
      },
    };
    const expected = {
      id: "item_1",
      expectedClaimGeneration: 7,
      summary: "Current work is reviewed.",
      nextAction: "Run the production verifier.",
    };
    expect(readHandedOffItem(payload, expected)).toEqual({
      id: "item_1",
      status: "ready",
      summary: "Current work is reviewed.",
      nextAction: "Run the production verifier.",
      claimGeneration: 8,
      version: 7,
    });
    expect(() => readHandedOffItem({ item: { ...payload.item, status: "active" } }, expected)).toThrow(/did not become ready/);
    expect(() => readHandedOffItem({ item: { ...payload.item, claimedBy: "agent-1" } }, expected)).toThrow(/release its claim/);
    expect(() => readHandedOffItem({ item: { ...payload.item, id: "item_2" } }, expected)).toThrow(/different handed-off item/);
    expect(() => readHandedOffItem({ item: { ...payload.item, summary: "Other" } }, expected)).toThrow(/different handoff summary/);
    expect(() => readHandedOffItem({ item: { ...payload.item, nextAction: "Other" } }, expected)).toThrow(/different handoff next action/);
    expect(() => readHandedOffItem({ item: { ...payload.item, claimGeneration: 7 } }, expected)).toThrow(/exactly once/);
    expect(() => readHandedOffItem({ item: { ...payload.item, claimGeneration: 9 } }, expected)).toThrow(/exactly once/);
    expect(() => readHandedOffItem({ item: { ...payload.item, version: 0 } }, expected)).toThrow(/invalid version/);
  });

  test("reuses one idempotency key for unchanged input and rotates on generation, change, or reset", () => {
    let count = 0;
    const tracker = createHandoffIdempotencyTracker(() => `key-${++count}`);
    const input = validateHandoffInput("item_1", "Summary", "Next", "agent-2", actor, 7);
    expect(tracker.keyFor(input)).toBe("key-1");
    expect(tracker.keyFor({ ...input })).toBe("key-1");
    expect(tracker.keyFor({ ...input, expectedClaimGeneration: 8 })).toBe("key-2");
    expect(tracker.keyFor({ ...input, nextAction: "Different" })).toBe("key-3");
    tracker.reset();
    expect(tracker.keyFor(input)).toBe("key-4");
  });

  test("maps eligible statuses and labels canonical handoff history", () => {
    expect(["ready", "active", "blocked"].every(canHandoffStatus)).toBe(true);
    expect(canHandoffStatus("done")).toBe(false);
    expect(canHandoffStatus("archived")).toBe(false);
    expect(handoffEventLabel("work.handed_off")).toBe("Handoff · work.handed_off");
    expect(handoffEventLabel("item.progress")).toBe("item.progress");
  });
});
