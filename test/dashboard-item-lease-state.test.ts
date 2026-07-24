import { describe, expect, test } from "bun:test";
import {
  actionEmptyState,
  classifyLease,
  describeLease,
} from "../site/item-lease-state.js";

const now = Date.parse("2026-07-25T12:00:00.000Z");
const actor = { id: "agent:alpha", name: "Alpha", kind: "agent" } as const;

describe("dashboard lease state", () => {
  test("classifies no lease and invalid claim combinations", () => {
    expect(classifyLease({ status: "ready", claimedBy: null, claimExpiresAt: null }, now).state).toBe("none");
    expect(classifyLease({ status: "ready", claimedBy: actor.id, claimExpiresAt: "2026-07-25T13:00:00.000Z" }, now).state).toBe("invalid");
    expect(classifyLease({ status: "active", claimedBy: null, claimExpiresAt: "2026-07-25T13:00:00.000Z" }, now).state).toBe("invalid");
    expect(classifyLease({ status: "active", claimedBy: actor.id, claimExpiresAt: "not-a-date" }, now).state).toBe("invalid");
  });

  test("classifies healthy, expiring, and expired active leases", () => {
    expect(classifyLease({
      status: "active",
      claimedBy: actor.id,
      claimExpiresAt: "2026-07-25T13:00:00.000Z",
    }, now).state).toBe("healthy");
    expect(classifyLease({
      status: "active",
      claimedBy: actor.id,
      claimExpiresAt: "2026-07-25T12:10:00.000Z",
    }, now).state).toBe("expiring");
    const expired = classifyLease({
      status: "active",
      claimedBy: actor.id,
      claimExpiresAt: "2026-07-25T11:59:00.000Z",
    }, now);
    expect(expired.state).toBe("expired");
    expect(expired.secondsRemaining).toBe(-60);
  });

  test("describes actor-relative urgency and server authority", () => {
    expect(describeLease({
      status: "active",
      claimedBy: actor.id,
      claimExpiresAt: "2026-07-25T12:10:00.000Z",
    }, actor, now)).toContain("active session actor");
    expect(describeLease({
      status: "active",
      claimedBy: "agent:beta",
      claimExpiresAt: "2026-07-25T11:59:00.000Z",
    }, actor, now)).toContain("server decides recovery or takeover");
    expect(describeLease({
      status: "active",
      claimedBy: null,
      claimExpiresAt: null,
    }, actor, now)).toContain("incomplete or invalid lease fields");
  });

  test("provides precise authorization and unavailable action states", () => {
    expect(actionEmptyState("claim", "ready", false, true)).toContain("read-only");
    expect(actionEmptyState("claim", "ready", true, false)).toContain("active session actor");
    expect(actionEmptyState("claim", "blocked", true, true)).toContain("Unblock it");
    expect(actionEmptyState("transition", "done", true, true)).toContain("done");
    expect(actionEmptyState("complete", "done", true, true)).toContain("already complete");
    expect(actionEmptyState("complete", "ready", true, true)).toBeNull();
  });

  test("rejects invalid time and expiry window inputs", () => {
    expect(() => classifyLease({}, Number.NaN)).toThrow("time must be valid");
    expect(() => classifyLease({}, now, -1)).toThrow("non-negative");
  });
});
