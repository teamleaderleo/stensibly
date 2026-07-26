import { describe, expect, test } from "bun:test";
import {
  createLeaseRenewalIdempotencyTracker,
  leaseRenewalAvailability,
  readRenewalAuthority,
  readRenewedItem,
  validateLeaseRenewalInput,
} from "../site/item-lease-renewal.js";

const actor = { id: "agent-1", name: "Release agent", kind: "agent" as const };
const now = Date.parse("2026-07-26T00:00:00.000Z");

function detail(overrides: Record<string, unknown> = {}) {
  return {
    item: { id: "item_1" },
    control: {
      authority: {
        state: "live",
        holderActorId: "agent-1",
        generation: 7,
        expiresAt: "2026-07-26T01:00:00.000Z",
        source: "claim",
        allowedOperations: ["renew"],
        approvalRequiredOperations: [],
        ...overrides,
      },
    },
  };
}

describe("dashboard renewal authority", () => {
  test("accepts a bounded canonical server authority view", () => {
    expect(readRenewalAuthority(detail(), "item_1")).toEqual({
      status: "available",
      authority: {
        state: "live",
        holderActorId: "agent-1",
        generation: 7,
        expiresAt: "2026-07-26T01:00:00.000Z",
        source: "claim",
        allowedOperations: ["renew"],
        approvalRequiredOperations: [],
      },
    });
  });

  test("fails closed for absent, malformed, cross-item, and credential-shaped authority", () => {
    expect(readRenewalAuthority({ item: { id: "item_1" } }, "item_1")).toEqual({
      status: "absent",
      authority: null,
    });
    expect(readRenewalAuthority({ item: { id: "item_1" }, control: {} }, "item_1")).toEqual({
      status: "malformed",
      authority: null,
    });
    expect(readRenewalAuthority(detail({ holderActorId: "stn.tok_secret" }), "item_1")).toEqual({
      status: "malformed",
      authority: null,
    });
    expect(readRenewalAuthority(detail({ source: "none" }), "item_1")).toEqual({
      status: "malformed",
      authority: null,
    });
    expect(readRenewalAuthority(detail({ approvalRequiredOperations: ["renew"] }), "item_1")).toEqual({
      status: "malformed",
      authority: null,
    });
    expect(() => readRenewalAuthority(detail(), "item_2")).toThrow("different item");
  });
});

describe("dashboard renewal eligibility", () => {
  test("allows only the holder under a live server generation with renew permission", () => {
    const result = readRenewalAuthority(detail(), "item_1");
    expect(leaseRenewalAvailability(result, actor, now)).toEqual({
      available: true,
      message: expect.stringContaining("generation 7"),
    });
    expect(leaseRenewalAvailability(result, actor, now).message).toContain("server time");
  });

  test("explains every fail-closed authority branch", () => {
    expect(leaseRenewalAvailability({ status: "absent", authority: null }, actor, now).message)
      .toContain("server-owned authority view");
    expect(leaseRenewalAvailability({ status: "malformed", authority: null }, actor, now)).toEqual({
      available: false,
      message: expect.stringContaining("incompatible"),
    });
    expect(leaseRenewalAvailability(readRenewalAuthority(detail({ holderActorId: "agent-2" })), actor, now).message)
      .toContain("Only the current holder");
    expect(leaseRenewalAvailability(readRenewalAuthority(detail({ allowedOperations: [] })), actor, now).message)
      .toContain("withholds lease renewal");
    const approvalAuthority = readRenewalAuthority(detail({
      allowedOperations: [],
      approvalRequiredOperations: ["renew"],
    }));
    expect(leaseRenewalAvailability(approvalAuthority, actor, now).message)
      .toContain("requires server-recorded approval");
    expect(leaseRenewalAvailability(readRenewalAuthority(detail({ state: "expired" })), actor, now)).toEqual({
      available: false,
      message: expect.stringContaining("expired"),
    });
    expect(leaseRenewalAvailability(readRenewalAuthority(detail({ state: "superseded" })), actor, now).available)
      .toBe(false);
    expect(leaseRenewalAvailability(readRenewalAuthority(detail({ expiresAt: "2026-07-25T23:59:00.000Z" })), actor, now).message)
      .toContain("Refresh");
    expect(leaseRenewalAvailability(readRenewalAuthority(detail()), null, now).message)
      .toContain("active session actor");
  });
});

describe("dashboard renewal request and response fencing", () => {
  test("requires and sends the server-provided expected generation", () => {
    expect(validateLeaseRenewalInput(" item_1 ", "1800", actor, 7)).toEqual({
      id: "item_1",
      actor,
      leaseSeconds: 1800,
      expectedClaimGeneration: 7,
    });
    expect(() => validateLeaseRenewalInput("item_1", 1800, actor, undefined))
      .toThrow("expected claim generation");
  });

  test("keeps retry idempotency independent and rotates when generation changes", () => {
    const keys = ["renew_first", "renew_second", "renew_third"];
    const tracker = createLeaseRenewalIdempotencyTracker(() => keys.shift()!);
    const first = validateLeaseRenewalInput("item_1", 1800, actor, 7);
    expect(tracker.keyFor(first)).toBe("renew_first");
    expect(tracker.keyFor({ ...first, actor: { ...actor } })).toBe("renew_first");
    expect(tracker.keyFor({ ...first, expectedClaimGeneration: 8 })).toBe("renew_second");
    tracker.reset();
    expect(tracker.keyFor(first)).toBe("renew_third");
  });

  test("requires the renewed response to advance generation exactly once", () => {
    const payload = {
      item: {
        id: "item_1",
        status: "active",
        claimedBy: "agent-1",
        claimExpiresAt: "2026-07-26T02:00:00.000Z",
        claimGeneration: 8,
        internal: { secret: true },
      },
    };
    expect(readRenewedItem(payload, "item_1", "agent-1", 7)).toEqual({
      id: "item_1",
      status: "active",
      claimedBy: "agent-1",
      claimExpiresAt: "2026-07-26T02:00:00.000Z",
      claimGeneration: 8,
    });
    expect(() => readRenewedItem({
      item: { ...payload.item, claimGeneration: 7 },
    }, "item_1", "agent-1", 7)).toThrow("exactly once");
    expect(() => readRenewedItem({
      item: { ...payload.item, claimGeneration: 9 },
    }, "item_1", "agent-1", 7)).toThrow("exactly once");
  });
});
