import { describe, expect, test } from "bun:test";
import {
  createTransitionIdempotencyTracker,
  readTransitionItem,
  transitionForStatus,
  validateBlockInput,
  validateUnblockInput,
} from "../site/item-block.js";

const actor = { id: "human:leo", name: "Leo", kind: "human" } as const;

describe("dashboard block and unblock input", () => {
  test("normalizes block and unblock contracts with current generation", () => {
    expect(validateBlockInput(" item_1 ", " Waiting on approval ", " Ask the owner ", actor, 7)).toEqual({
      id: "item_1",
      actor,
      action: "block",
      expectedClaimGeneration: 7,
      reason: "Waiting on approval",
      nextAction: "Ask the owner",
    });
    expect(validateUnblockInput(" item_1 ", " Resume review ", actor, 8)).toEqual({
      id: "item_1",
      actor,
      action: "unblock",
      expectedClaimGeneration: 8,
      nextAction: "Resume review",
    });
    expect(validateUnblockInput("item_1", "", actor, 0)).toEqual({
      id: "item_1",
      actor,
      action: "unblock",
      expectedClaimGeneration: 0,
    });
  });

  test("enforces actor, generation, text, and credential boundaries", () => {
    expect(() => validateBlockInput("item_1", "", "", actor, 0)).toThrow("Block reason is required");
    expect(() => validateBlockInput("item_1", "x".repeat(10_001), "", actor, 0)).toThrow("maximum 10000");
    expect(() => validateBlockInput("item_1", "blocked", "x".repeat(2_001), actor, 0)).toThrow("at most 2000");
    expect(() => validateBlockInput("item_1", "stn.tok_secret", "", actor, 0)).toThrow("Credential-shaped");
    expect(() => validateUnblockInput("item_1", "", null, 0)).toThrow("active session actor");
    expect(() => validateBlockInput("item_1", "Waiting", "", actor, undefined)).toThrow("current claim generation");
    expect(() => validateUnblockInput("item_1", "", actor, -1)).toThrow("current claim generation");
  });
});

describe("dashboard transition response", () => {
  const base = {
    id: "item_1",
    project: "alpha",
    kind: "task",
    title: "Ship it",
    priority: 50,
    claimedBy: null,
    claimExpiresAt: null,
    version: 4,
    createdAt: "2026-07-24T20:00:00.000Z",
    updatedAt: "2026-07-24T21:00:00.000Z",
  };

  test("accepts safe block and unblock continuations with exact advancement", () => {
    const block = validateBlockInput("item_1", "Waiting on approval", "Ask the owner", actor, 7);
    expect(readTransitionItem({
      item: {
        ...base,
        status: "blocked",
        summary: block.reason,
        nextAction: block.nextAction,
        claimGeneration: 8,
        internal: "ignored",
      },
    }, block)).toEqual({
      id: "item_1",
      status: "blocked",
      summary: "Waiting on approval",
      nextAction: "Ask the owner",
      claimGeneration: 8,
      version: 4,
    });
    const unblock = validateUnblockInput("item_1", "Resume review", actor, 8);
    expect(readTransitionItem({
      item: {
        ...base,
        status: "ready",
        summary: "Waiting on approval",
        nextAction: "Resume review",
        claimGeneration: 9,
      },
    }, unblock)).toEqual({
      id: "item_1",
      status: "ready",
      summary: "Waiting on approval",
      nextAction: "Resume review",
      claimGeneration: 9,
      version: 4,
    });
  });

  test("rejects mismatches, retained claims, malformed fields, and generation jumps", () => {
    const block = validateBlockInput("item_1", "Waiting", "", actor, 7);
    const valid = {
      ...base,
      status: "blocked",
      summary: "Waiting",
      nextAction: null,
      claimGeneration: 8,
    };
    expect(() => readTransitionItem({ item: { ...valid, id: "item_2" } }, block)).toThrow("different transitioned item");
    expect(() => readTransitionItem({ item: { ...valid, status: "ready" } }, block)).toThrow("did not become blocked");
    expect(() => readTransitionItem({ item: { ...valid, summary: "Different" } }, block)).toThrow("different block reason");
    expect(() => readTransitionItem({ item: { ...valid, claimedBy: "agent:other" } }, block)).toThrow("did not release its claim");
    expect(() => readTransitionItem({ item: { ...valid, summary: "stn.tok_secret" } }, block)).toThrow("Credential-shaped");
    expect(() => readTransitionItem({ item: { ...valid, claimGeneration: 7 } }, block)).toThrow("exactly once");
    expect(() => readTransitionItem({ item: { ...valid, claimGeneration: 9 } }, block)).toThrow("exactly once");
    expect(() => readTransitionItem({ item: { ...valid, version: 0 } }, block)).toThrow("invalid version");
  });
});

describe("dashboard transition idempotency and status mapping", () => {
  test("reuses keys for unchanged actions and rotates on generation, input, action, and reset", () => {
    let sequence = 0;
    const tracker = createTransitionIdempotencyTracker(() => `web_transition_${++sequence}`);
    const block = validateBlockInput("item_1", "Waiting", "", actor, 7);
    expect(tracker.keyFor(block)).toBe("web_transition_1");
    expect(tracker.keyFor({ ...block, actor: { ...actor } })).toBe("web_transition_1");
    expect(tracker.keyFor({ ...block, expectedClaimGeneration: 8 })).toBe("web_transition_2");
    expect(tracker.keyFor({ ...block, reason: "Different" })).toBe("web_transition_3");
    expect(tracker.keyFor(validateUnblockInput("item_1", "", actor, 8))).toBe("web_transition_4");
    tracker.reset();
    expect(tracker.keyFor(block)).toBe("web_transition_5");
  });

  test("maps only server-supported dashboard states", () => {
    expect(transitionForStatus("ready")).toBe("block");
    expect(transitionForStatus("active")).toBe("block");
    expect(transitionForStatus("blocked")).toBe("unblock");
    expect(transitionForStatus("done")).toBeNull();
    expect(transitionForStatus("archived")).toBeNull();
  });
});
