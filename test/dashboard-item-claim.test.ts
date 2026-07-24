import { describe, expect, test } from "bun:test";
import {
  createClaimIdempotencyTracker,
  describeClaim,
  readClaimedItem,
  validateClaimInput,
} from "../site/item-claim.js";

const actor = { id: "agent-1", name: "Release agent", kind: "agent" as const };

describe("dashboard claim input", () => {
  test("normalizes the server claim contract", () => {
    expect(validateClaimInput(" item_1 ", "1800", actor)).toEqual({
      id: "item_1",
      actor,
      leaseSeconds: 1800,
    });
  });

  test("enforces actor, lease, and credential boundaries", () => {
    expect(() => validateClaimInput("item_1", 29, actor)).toThrow("30 to 86400");
    expect(() => validateClaimInput("item_1", 86401, actor)).toThrow("30 to 86400");
    expect(() => validateClaimInput("item_1", 30.5, actor)).toThrow("whole number");
    expect(() => validateClaimInput("item_1", 30, null)).toThrow("active session actor");
    expect(() => validateClaimInput("stn.tok_secret.value", 30, actor)).toThrow("Credential-shaped");
    expect(() => validateClaimInput("x".repeat(241), 30, actor)).toThrow("maximum 240");
  });
});

describe("dashboard claimed-item response", () => {
  test("returns only the safe claim continuation fields", () => {
    expect(readClaimedItem({
      item: {
        id: "item_1",
        status: "active",
        claimedBy: "agent-1",
        claimExpiresAt: "2026-07-25T01:00:00.000Z",
        tokenId: "tok_private",
        internal: { secret: true },
      },
    }, "item_1", "agent-1")).toEqual({
      id: "item_1",
      status: "active",
      claimedBy: "agent-1",
      claimExpiresAt: "2026-07-25T01:00:00.000Z",
    });
  });

  test("rejects mismatched, inactive, malformed, and credential-shaped responses", () => {
    expect(() => readClaimedItem(null)).toThrow("incompatible claimed-item");
    expect(() => readClaimedItem({ item: { id: "item_2", status: "active", claimedBy: "agent-1", claimExpiresAt: "2026-07-25T01:00:00.000Z" } }, "item_1", "agent-1"))
      .toThrow("different claimed item");
    expect(() => readClaimedItem({ item: { id: "item_1", status: "ready", claimedBy: "agent-1", claimExpiresAt: "2026-07-25T01:00:00.000Z" } }, "item_1", "agent-1"))
      .toThrow("did not become active");
    expect(() => readClaimedItem({ item: { id: "item_1", status: "active", claimedBy: "other", claimExpiresAt: "2026-07-25T01:00:00.000Z" } }, "item_1", "agent-1"))
      .toThrow("different claimant");
    expect(() => readClaimedItem({ item: { id: "item_1", status: "active", claimedBy: "agent-1", claimExpiresAt: "not-a-date" } }, "item_1", "agent-1"))
      .toThrow("invalid lease expiry");
    expect(() => readClaimedItem({ item: { id: "item_1", status: "active", claimedBy: "stn.tok_secret", claimExpiresAt: "2026-07-25T01:00:00.000Z" } }))
      .toThrow("Credential-shaped");
  });
});

describe("dashboard claim idempotency", () => {
  test("reuses a key for the same item, actor, and lease and rotates on change", () => {
    const keys = ["web_first", "web_second", "web_third"];
    const tracker = createClaimIdempotencyTracker(() => keys.shift()!);
    const first = validateClaimInput("item_1", 1800, actor);
    expect(tracker.keyFor(first)).toBe("web_first");
    expect(tracker.keyFor({ ...first, actor: { ...actor } })).toBe("web_first");
    expect(tracker.keyFor({ ...first, leaseSeconds: 3600 })).toBe("web_second");
    tracker.reset();
    expect(tracker.current()).toBe("");
    expect(tracker.keyFor(first)).toBe("web_third");
  });
});

describe("dashboard claim descriptions", () => {
  const now = Date.parse("2026-07-25T00:00:00.000Z");

  test("describes unclaimed, owned, held, expired, and invalid leases", () => {
    expect(describeClaim({ claimedBy: null, claimExpiresAt: null }, actor, now))
      .toBe("This item has no current claimant.");
    expect(describeClaim({ claimedBy: "agent-1", claimExpiresAt: "2026-07-25T01:00:00.000Z" }, actor, now))
      .toContain("the active actor");
    expect(describeClaim({ claimedBy: "other", claimExpiresAt: "2026-07-25T01:00:00.000Z" }, actor, now))
      .toContain("Held by other");
    expect(describeClaim({ claimedBy: "other", claimExpiresAt: "2026-07-24T23:59:00.000Z" }, actor, now))
      .toContain("has expired");
    expect(describeClaim({ claimedBy: "other", claimExpiresAt: "bad" }, actor, now))
      .toContain("expiry is invalid");
  });
});
