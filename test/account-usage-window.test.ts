import { describe, expect, test } from "bun:test";
import {
  compileAccountEntitlementAdmission,
  type AccountEntitlement,
} from "../src/account-entitlement-admission.js";
import {
  reconcileAccountUsage,
  reserveAccountUsage,
  settleAccountUsage,
  type AccountUsageReservationReceipt,
} from "../src/account-usage-reservation.js";
import {
  ACCOUNT_USAGE_WINDOW_MAX_RECEIPTS,
  compileAccountUsageWindowEvidence,
} from "../src/account-usage-window.js";

const subject = {
  kind: "account" as const,
  id: "acct_public_beta_1",
  workspace: "default",
};
const decisionFingerprint = `sha256:${"a".repeat(64)}`;
const observedAt = "2026-08-26T12:00:10.000Z";

function reserved(
  requestIdentity: string,
  units: number,
  override: Partial<Parameters<typeof reserveAccountUsage>[0]> = {},
): AccountUsageReservationReceipt {
  return reserveAccountUsage({
    subject,
    serviceClass: "hosted_read",
    windowId: "window_2026_08",
    requestIdentity,
    units,
    admissionDecisionFingerprint: decisionFingerprint,
    currentTime: "2026-08-26T12:00:00.000Z",
    ...override,
  });
}

function input(receipts: unknown[], override: Record<string, unknown> = {}) {
  return {
    subject,
    serviceClass: "hosted_read",
    windowId: "window_2026_08",
    observedAt,
    receipts,
    ...override,
  };
}

function entitlement(usage: ReturnType<typeof compileAccountUsageWindowEvidence>["usage"]): AccountEntitlement {
  return {
    version: 1,
    subject,
    serviceClass: "hosted_read",
    revision: "entitlement_r1",
    sourceReference: "entitlement:fixture:r1",
    status: "active",
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: null,
    allowance: {
      kind: "window",
      windowId: "window_2026_08",
      limit: 10,
      resetAt: "2026-09-01T00:00:00.000Z",
      usage,
    },
  };
}

describe("account usage window evidence", () => {
  test("sums consumed and reserved usage while released receipts contribute zero", () => {
    const consumed = settleAccountUsage(reserved("request_consumed", 3), {
      outcome: "consumed",
      settlementReference: "settlement_consumed",
      currentTime: "2026-08-26T12:00:01.000Z",
    });
    const held = reserved("request_reserved", 5);
    const released = settleAccountUsage(reserved("request_released", 7), {
      outcome: "released",
      settlementReference: "settlement_released",
      currentTime: "2026-08-26T12:00:02.000Z",
    });

    const evidence = compileAccountUsageWindowEvidence(input([
      released,
      held,
      consumed,
    ]));

    expect(evidence.usage).toEqual({
      state: "known",
      consumed: 3,
      reserved: 5,
      observedAt,
    });
    expect(evidence.receiptCount).toBe(3);
    expect(evidence.receiptSetFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.evidenceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.grantsAuthority).toBe(false);
    expect(evidence.grantsProviderBudget).toBe(false);
  });

  test("feeds exact consumed plus reserved evidence into entitlement admission", () => {
    const consumed = settleAccountUsage(reserved("request_consumed", 3), {
      outcome: "consumed",
      settlementReference: "settlement_consumed",
      currentTime: "2026-08-26T12:00:01.000Z",
    });
    const held = reserved("request_reserved", 5);
    const evidence = compileAccountUsageWindowEvidence(input([consumed, held]));

    const allowed = compileAccountEntitlementAdmission({
      subject,
      serviceClass: "hosted_read",
      requestIdentity: "request_next_allowed",
      units: 2,
      currentTime: observedAt,
      entitlement: entitlement(evidence.usage),
    });
    expect(allowed).toMatchObject({
      outcome: "admit",
      reason: "allowed",
      remaining: 2,
      grantsAuthority: false,
    });

    const denied = compileAccountEntitlementAdmission({
      subject,
      serviceClass: "hosted_read",
      requestIdentity: "request_next_denied",
      units: 3,
      currentTime: observedAt,
      entitlement: entitlement(evidence.usage),
    });
    expect(denied).toMatchObject({
      outcome: "deny",
      reason: "allowance_exhausted",
      remaining: 2,
      grantsAuthority: false,
    });
  });

  test("keeps an ambiguous operation reserved until reconciliation settles it", () => {
    const ambiguous = settleAccountUsage(reserved("request_ambiguous", 4), {
      outcome: "ambiguous",
      settlementReference: "dispatch_unknown",
      currentTime: "2026-08-26T12:00:01.000Z",
    });
    const before = compileAccountUsageWindowEvidence(input([ambiguous]));
    expect(before.usage).toMatchObject({ consumed: 0, reserved: 4 });

    const reconciled = reconcileAccountUsage(ambiguous, {
      outcome: "consumed",
      reconciliationReference: "readback_consumed",
      currentTime: "2026-08-26T12:00:02.000Z",
    });
    const after = compileAccountUsageWindowEvidence(input([reconciled]));
    expect(after.usage).toMatchObject({ consumed: 4, reserved: 0 });
    expect(after.receiptSetFingerprint).not.toBe(before.receiptSetFingerprint);
  });

  test("is deterministic across storage row order", () => {
    const first = reserved("request_a", 1);
    const second = settleAccountUsage(reserved("request_b", 2), {
      outcome: "consumed",
      settlementReference: "settlement_b",
      currentTime: "2026-08-26T12:00:01.000Z",
    });

    const forward = compileAccountUsageWindowEvidence(input([first, second]));
    const reverse = compileAccountUsageWindowEvidence(input([second, first]));
    expect(reverse).toEqual(forward);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.usage)).toBe(true);
    expect(Object.isFrozen(forward.subject)).toBe(true);
  });

  test("represents an observed empty window as authoritative zero usage", () => {
    const evidence = compileAccountUsageWindowEvidence(input([]));
    expect(evidence.usage).toEqual({
      state: "known",
      consumed: 0,
      reserved: 0,
      observedAt,
    });
    expect(evidence.receiptCount).toBe(0);
  });

  test("fails closed on duplicate request identities even when receipts are byte-equivalent", () => {
    const receipt = reserved("request_duplicate", 1);
    expect(() => compileAccountUsageWindowEvidence(input([
      receipt,
      receipt,
    ]))).toThrow("duplicate request identity");
  });

  test("fails closed when the storage query leaks another account, workspace, service, or window", () => {
    const cases = [
      reserved("foreign_account", 1, {
        subject: { ...subject, id: "acct_other" },
      }),
      reserved("foreign_workspace", 1, {
        subject: { ...subject, workspace: "other" },
      }),
      reserved("foreign_service", 1, {
        serviceClass: "hosted_write",
      }),
      reserved("foreign_window", 1, {
        windowId: "window_other",
      }),
    ];

    for (const receipt of cases) {
      expect(() => compileAccountUsageWindowEvidence(input([receipt])))
        .toThrow("foreign receipt");
    }
  });

  test("rejects receipt evidence newer than the completed window observation", () => {
    const late = settleAccountUsage(reserved("request_late", 1), {
      outcome: "consumed",
      settlementReference: "settlement_late",
      currentTime: "2026-08-26T12:00:11.000Z",
    });
    expect(() => compileAccountUsageWindowEvidence(input([late])))
      .toThrow("future receipt evidence");
  });

  test("rejects tampered receipts before accounting them", () => {
    const receipt = reserved("request_tampered", 2);
    const tampered = {
      ...receipt,
      usage: { consumed: 2, reserved: 0 },
    };
    expect(() => compileAccountUsageWindowEvidence(input([tampered])))
      .toThrow("accounting is not derived correctly");
  });

  test("rejects unsafe aggregate arithmetic", () => {
    const first = reserved("request_max", Number.MAX_SAFE_INTEGER);
    const second = reserved("request_one", 1);
    expect(() => compileAccountUsageWindowEvidence(input([first, second])))
      .toThrow("safe integer accounting");
  });

  test("rejects malformed scope, observation time, unknown fields, and unbounded receipt sets", () => {
    expect(() => compileAccountUsageWindowEvidence(input([], {
      serviceClass: "other",
    }))).toThrow("service class is invalid");
    expect(() => compileAccountUsageWindowEvidence(input([], {
      observedAt: "2026-08-26T12:00:10Z",
    }))).toThrow("canonical UTC");
    expect(() => compileAccountUsageWindowEvidence({
      ...input([]),
      extra: true,
    })).toThrow("unknown fields");
    expect(() => compileAccountUsageWindowEvidence(input(
      Array.from({ length: ACCOUNT_USAGE_WINDOW_MAX_RECEIPTS + 1 }, () => null),
    ))).toThrow("bounded window limit");
  });
});
