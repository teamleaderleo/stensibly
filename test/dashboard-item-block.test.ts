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
  test("normalizes block and unblock contracts", () => {
    expect(validateBlockInput(" item_1 ", " Waiting on approval ", " Ask the owner ", actor)).toEqual({
      id: "item_1",
      actor,
      action: "block",
      reason: "Waiting on approval",
      nextAction: "Ask the owner",
    });
    expect(validateUnblockInput(" item_1 ", " Resume review ", actor)).toEqual({
      id: "item_1",
      actor,
      action: "unblock",
      nextAction: "Resume review",
    });
    expect(validateUnblockInput("item_1", "", actor)).toEqual({ id: "item_1", actor, action: "unblock" });
  });

  test("enforces actor, text, and credential boundaries", () => {
    expect(() => validateBlockInput("item_1", "", "", actor)).toThrow("Block reason is required");
    expect(() => validateBlockInput("item_1", "x".repeat(10_001), "", actor)).toThrow("maximum 10000");
    expect(() => validateBlockInput("item_1", "blocked", "x".repeat(2_001), actor)).toThrow("at most 2000");
    expect(() => validateBlockInput("item_1", "stn.tok_secret", "", actor)).toThrow("Credential-shaped");
    expect(() => validateUnblockInput("item_1", "", null)).toThrow("active session actor");
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

  test("accepts safe block and unblock continuations", () => {
    const block = validateBlockInput("item_1", "Waiting on approval", "Ask the owner", actor);
    expect(readTransitionItem({ item: { ...base, status: "blocked", summary: block.reason, nextAction: block.nextAction, internal: "ignored" } }, block)).toEqual({
      id: "item_1",
      status: "blocked",
      summary: "Waiting on approval",
      nextAction: "Ask the owner",
      version: 4,
    });
    const unblock = validateUnblockInput("item_1", "Resume review", actor);
    expect(readTransitionItem({ item: { ...base, status: "ready", summary: "Waiting on approval", nextAction: "Resume review" } }, unblock)).toEqual({
      id: "item_1",
      status: "ready",
      summary: "Waiting on approval",
      nextAction: "Resume review",
      version: 4,
    });
  });

  test("rejects mismatches, retained claims, and malformed fields", () => {
    const block = validateBlockInput("item_1", "Waiting", "", actor);
    expect(() => readTransitionItem({ item: { ...base, id: "item_2", status: "blocked", summary: "Waiting", nextAction: null } }, block)).toThrow("different transitioned item");
    expect(() => readTransitionItem({ item: { ...base, status: "ready", summary: "Waiting", nextAction: null } }, block)).toThrow("did not become blocked");
    expect(() => readTransitionItem({ item: { ...base, status: "blocked", summary: "Different", nextAction: null } }, block)).toThrow("different block reason");
    expect(() => readTransitionItem({ item: { ...base, status: "blocked", summary: "Waiting", nextAction: null, claimedBy: "agent:other" } }, block)).toThrow("did not release its claim");
    expect(() => readTransitionItem({ item: { ...base, status: "blocked", summary: "stn.tok_secret", nextAction: null } }, block)).toThrow("Credential-shaped");
    expect(() => readTransitionItem({ item: { ...base, status: "blocked", summary: "Waiting", nextAction: null, version: 0 } }, block)).toThrow("invalid version");
  });
});

describe("dashboard transition idempotency and status mapping", () => {
  test("reuses keys for unchanged actions and rotates on input/action/reset", () => {
    let sequence = 0;
    const tracker = createTransitionIdempotencyTracker(() => `web_transition_${++sequence}`);
    const block = validateBlockInput("item_1", "Waiting", "", actor);
    expect(tracker.keyFor(block)).toBe("web_transition_1");
    expect(tracker.keyFor({ ...block, actor: { ...actor } })).toBe("web_transition_1");
    expect(tracker.keyFor({ ...block, reason: "Different" })).toBe("web_transition_2");
    expect(tracker.keyFor(validateUnblockInput("item_1", "", actor))).toBe("web_transition_3");
    tracker.reset();
    expect(tracker.keyFor(block)).toBe("web_transition_4");
  });

  test("maps only server-supported dashboard states", () => {
    expect(transitionForStatus("ready")).toBe("block");
    expect(transitionForStatus("active")).toBe("block");
    expect(transitionForStatus("blocked")).toBe("unblock");
    expect(transitionForStatus("done")).toBeNull();
    expect(transitionForStatus("archived")).toBeNull();
  });
});
