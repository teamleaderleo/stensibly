import { describe, expect, test } from "bun:test";
import {
  parseAccountUsageReservationReceipt,
  reconcileAccountUsage,
  reserveAccountUsage,
  settleAccountUsage,
  type ReserveAccountUsageInput,
} from "../src/account-usage-reservation.js";

const at = (second: number): string =>
  `2026-08-26T00:00:${String(second).padStart(2, "0")}.000Z`;
const hash = (digit: number): string => `sha256:${String(digit).repeat(64)}`;

function input(
  overrides: Partial<ReserveAccountUsageInput> = {},
): ReserveAccountUsageInput {
  return {
    subject: {
      kind: "account",
      id: "acct-alpha",
      workspace: "workspace-alpha",
    },
    serviceClass: "hosted_write",
    windowId: "2026-08-beta",
    requestIdentity: "request-alpha",
    units: 1,
    admissionDecisionFingerprint: hash(1),
    currentTime: at(1),
    ...overrides,
  };
}

describe("account usage reservation receipts", () => {
  test("reserves once and returns the original receipt on exact replay", () => {
    const first = reserveAccountUsage(input());
    const replay = reserveAccountUsage(input({ currentTime: at(9) }), first);

    expect(replay).toEqual(first);
    expect(replay.reservedAt).toBe(at(1));
    expect(replay.updatedAt).toBe(at(1));
    expect(replay.state).toBe("reserved");
    expect(replay.usage).toEqual({ consumed: 0, reserved: 1 });
    expect(replay.grantsAuthority).toBe(false);
    expect(replay.grantsProviderBudget).toBe(false);
    expect(Object.isFrozen(replay)).toBe(true);
    expect(parseAccountUsageReservationReceipt(replay)).toEqual(replay);
  });

  test("conflicts when replay crosses account, workspace, service, window, units, or admission evidence", () => {
    const first = reserveAccountUsage(input());
    const changed: ReserveAccountUsageInput[] = [
      input({ subject: { kind: "account", id: "acct-beta", workspace: "workspace-alpha" } }),
      input({ subject: { kind: "account", id: "acct-alpha", workspace: "workspace-beta" } }),
      input({ subject: { kind: "authorization", id: "acct-alpha", workspace: "workspace-alpha" } }),
      input({ serviceClass: "hosted_read" }),
      input({ windowId: "2026-09-beta" }),
      input({ requestIdentity: "request-beta" }),
      input({ units: 2 }),
      input({ admissionDecisionFingerprint: hash(2) }),
    ];

    for (const candidate of changed) {
      expect(() => reserveAccountUsage(candidate, first)).toThrow("conflicts");
    }
  });

  test("holds ambiguous usage as reserved until explicit reconciliation consumes it", () => {
    const reserved = reserveAccountUsage(input({ units: 3 }));
    const ambiguous = settleAccountUsage(reserved, {
      outcome: "ambiguous",
      settlementReference: "dispatch-timeout-alpha",
      currentTime: at(2),
    });

    expect(ambiguous.state).toBe("ambiguous");
    expect(ambiguous.usage).toEqual({ consumed: 0, reserved: 3 });
    expect(settleAccountUsage(ambiguous, {
      outcome: "ambiguous",
      settlementReference: "dispatch-timeout-alpha",
      currentTime: at(8),
    })).toEqual(ambiguous);
    expect(() => settleAccountUsage(ambiguous, {
      outcome: "consumed",
      settlementReference: "dispatch-timeout-alpha",
      currentTime: at(3),
    })).toThrow("explicit reconciliation");

    const consumed = reconcileAccountUsage(ambiguous, {
      outcome: "consumed",
      reconciliationReference: "readback-alpha",
      currentTime: at(4),
    });
    expect(consumed.state).toBe("consumed");
    expect(consumed.usage).toEqual({ consumed: 3, reserved: 0 });
    expect(consumed.settlementReference).toBe("dispatch-timeout-alpha");
    expect(consumed.reconciliationReference).toBe("readback-alpha");
    expect(reconcileAccountUsage(consumed, {
      outcome: "consumed",
      reconciliationReference: "readback-alpha",
      currentTime: at(9),
    })).toEqual(consumed);
    expect(() => reconcileAccountUsage(consumed, {
      outcome: "released",
      reconciliationReference: "readback-alpha",
      currentTime: at(9),
    })).toThrow("conflicts");
  });

  test("can reconcile ambiguous usage to released without consuming allowance", () => {
    const ambiguous = settleAccountUsage(reserveAccountUsage(input({ units: 2 })), {
      outcome: "ambiguous",
      settlementReference: "dispatch-timeout-release",
      currentTime: at(2),
    });
    const released = reconcileAccountUsage(ambiguous, {
      outcome: "released",
      reconciliationReference: "readback-absent",
      currentTime: at(3),
    });

    expect(released.state).toBe("released");
    expect(released.usage).toEqual({ consumed: 0, reserved: 0 });
  });

  test("settles directly once and rejects a contradictory terminal outcome", () => {
    const reserved = reserveAccountUsage(input());
    const consumed = settleAccountUsage(reserved, {
      outcome: "consumed",
      settlementReference: "operation-receipt-alpha",
      currentTime: at(2),
    });

    expect(consumed.usage).toEqual({ consumed: 1, reserved: 0 });
    expect(settleAccountUsage(consumed, {
      outcome: "consumed",
      settlementReference: "operation-receipt-alpha",
      currentTime: at(8),
    })).toEqual(consumed);
    expect(() => settleAccountUsage(consumed, {
      outcome: "released",
      settlementReference: "operation-receipt-alpha",
      currentTime: at(8),
    })).toThrow("conflicts");
    expect(() => reconcileAccountUsage(consumed, {
      outcome: "consumed",
      reconciliationReference: "late-readback",
      currentTime: at(8),
    })).toThrow("conflicts");
  });

  test("rejects tampered derived accounting and receipt identity", () => {
    const receipt = reserveAccountUsage(input({ units: 4 }));
    expect(() => parseAccountUsageReservationReceipt({
      ...receipt,
      usage: { consumed: 4, reserved: 0 },
    })).toThrow("accounting");
    expect(() => parseAccountUsageReservationReceipt({
      ...receipt,
      receiptFingerprint: hash(9),
    })).toThrow("receipt fingerprint");
    expect(() => parseAccountUsageReservationReceipt({
      ...receipt,
      intentFingerprint: hash(8),
    })).toThrow("intent fingerprint");
  });

  test("rejects malformed transition evidence and time reversal", () => {
    const reserved = reserveAccountUsage(input());
    expect(() => parseAccountUsageReservationReceipt({
      ...reserved,
      settlementReference: "impossible",
    })).toThrow("invalid settlement evidence");
    expect(() => settleAccountUsage(reserved, {
      outcome: "consumed",
      settlementReference: "operation-alpha",
      currentTime: at(0),
    })).toThrow("precedes existing evidence");
    expect(() => reconcileAccountUsage(reserved, {
      outcome: "released",
      reconciliationReference: "readback-alpha",
      currentTime: at(2),
    })).toThrow("before an ambiguous outcome");
  });

  test("rejects credential-like retained identities and invalid arithmetic", () => {
    expect(() => reserveAccountUsage(input({
      requestIdentity: "stn.tok_abcdefghijklmnop",
    }))).toThrow("credential-like");
    expect(() => reserveAccountUsage(input({ units: 0 }))).toThrow("positive safe integer");
    expect(() => reserveAccountUsage(input({ units: Number.MAX_SAFE_INTEGER + 1 }))).toThrow("positive safe integer");
    expect(() => reserveAccountUsage(input({ admissionDecisionFingerprint: "sha256:nope" }))).toThrow("SHA-256");
    expect(() => reserveAccountUsage(input({ currentTime: "2026-08-26T00:00:01Z" }))).toThrow("canonical UTC");
  });
});
