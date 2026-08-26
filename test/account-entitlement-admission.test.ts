import { describe, expect, test } from "bun:test";
import {
  compileAccountEntitlementAdmission,
  type AccountEntitlement,
  type AccountEntitlementAdmissionInput,
} from "../src/account-entitlement-admission.ts";

const currentTime = "2026-08-26T08:00:00.000Z";

function entitlement(
  overrides: Partial<AccountEntitlement> = {},
): AccountEntitlement {
  return {
    version: 1,
    subject: {
      kind: "account",
      id: "acct_leo",
      workspace: "default",
    },
    serviceClass: "hosted_write",
    revision: "entitlement:beta:v1",
    sourceReference: "github:teamleaderleo/stensibly#1694",
    status: "active",
    effectiveFrom: "2026-08-20T00:00:00.000Z",
    effectiveUntil: "2026-09-20T00:00:00.000Z",
    allowance: { kind: "unlimited" },
    ...overrides,
  };
}

function input(
  overrides: Partial<AccountEntitlementAdmissionInput> = {},
): AccountEntitlementAdmissionInput {
  return {
    subject: {
      kind: "account",
      id: "acct_leo",
      workspace: "default",
    },
    serviceClass: "hosted_write",
    requestIdentity: "request:write:001",
    units: 1,
    currentTime,
    entitlement: entitlement(),
    ...overrides,
  };
}

describe("account entitlement admission", () => {
  test("admits an explicitly unlimited current entitlement without granting authority", () => {
    const result = compileAccountEntitlementAdmission(input());

    expect(result).toMatchObject({
      outcome: "admit",
      reason: "allowed",
      subjectId: "acct_leo",
      serviceClass: "hosted_write",
      units: 1,
      entitlementRevision: "entitlement:beta:v1",
      remaining: null,
      grantsAuthority: false,
    });
    expect(result.decisionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("counts both consumed and reserved usage before admitting a limited request", () => {
    const result = compileAccountEntitlementAdmission(input({
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:2026-08-26",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 6,
            reserved: 2,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));

    expect(result).toMatchObject({
      outcome: "admit",
      reason: "allowed",
      windowId: "window:2026-08-26",
      resetAt: "2026-08-27T00:00:00.000Z",
      remaining: 2,
      grantsAuthority: false,
    });
  });

  test("denies a multi-unit request when the authoritative remaining allowance is smaller", () => {
    const insufficient = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:multi-unit",
      units: 2,
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:multi-unit",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 8,
            reserved: 1,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));
    const exactFit = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:single-unit",
      units: 1,
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:multi-unit",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 8,
            reserved: 1,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));

    expect(insufficient).toMatchObject({
      outcome: "deny",
      reason: "allowance_exhausted",
      units: 2,
      remaining: 1,
    });
    expect(exactFit).toMatchObject({
      outcome: "admit",
      reason: "allowed",
      units: 1,
      remaining: 1,
    });
  });

  test("denies exhausted, unknown, suspended, and expired entitlement state explicitly", () => {
    const exhausted = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:exhausted",
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:exhausted",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 9,
            reserved: 1,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));
    expect(exhausted).toMatchObject({
      outcome: "deny",
      reason: "allowance_exhausted",
      remaining: 0,
    });

    const unknown = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:unknown",
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:unknown",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: { state: "unknown" },
        },
      }),
    }));
    expect(unknown).toMatchObject({
      outcome: "deny",
      reason: "usage_unknown",
      remaining: null,
    });

    const suspended = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:suspended",
      entitlement: entitlement({ status: "suspended" }),
    }));
    expect(suspended).toMatchObject({ outcome: "deny", reason: "suspended" });

    const expired = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:expired",
      currentTime: "2026-09-20T00:00:00.000Z",
    }));
    expect(expired).toMatchObject({
      outcome: "deny",
      reason: "entitlement_expired",
    });
  });

  test("treats reset or future-dated usage evidence as unknown", () => {
    const staleWindow = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:stale-window",
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:stale",
          limit: 10,
          resetAt: "2026-08-26T07:00:00.000Z",
          usage: {
            state: "known",
            consumed: 1,
            reserved: 0,
            observedAt: "2026-08-26T06:59:00.000Z",
          },
        },
      }),
    }));
    expect(staleWindow).toMatchObject({
      outcome: "deny",
      reason: "usage_unknown",
      windowId: "window:stale",
      remaining: null,
    });

    const futureUsage = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:future-usage",
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:future",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 1,
            reserved: 0,
            observedAt: "2026-08-26T08:01:00.000Z",
          },
        },
      }),
    }));
    expect(futureUsage).toMatchObject({
      outcome: "deny",
      reason: "usage_unknown",
      windowId: "window:future",
      remaining: null,
    });
  });

  test("fails account, workspace, and service-class mismatches closed without exposing foreign entitlement metadata", () => {
    const cases: AccountEntitlementAdmissionInput[] = [
      input({
        subject: { kind: "account", id: "acct_other", workspace: "default" },
      }),
      input({
        subject: { kind: "account", id: "acct_leo", workspace: "other" },
      }),
      input({ serviceClass: "hosted_read" }),
    ];

    for (const request of cases) {
      const result = compileAccountEntitlementAdmission(request);
      expect(result).toMatchObject({
        outcome: "deny",
        reason: "no_entitlement",
        entitlementRevision: null,
        entitlementSourceReference: null,
        windowId: null,
        resetAt: null,
        remaining: null,
        grantsAuthority: false,
      });
      expect(JSON.stringify(result)).not.toContain("entitlement:beta:v1");
      expect(JSON.stringify(result)).not.toContain("stensibly#1694");
    }
  });

  test("rejects a foreign entitlement before inspecting its allowance details", () => {
    const foreign = entitlement({
      subject: { kind: "account", id: "acct_foreign", workspace: "default" },
      revision: "entitlement:foreign:secret",
      sourceReference: "github:private/foreign#1",
      allowance: {
        kind: "window",
        windowId: "foreign:window",
        limit: -1,
        resetAt: "definitely-not-a-time",
        usage: {
          state: "known",
          consumed: -100,
          reserved: -100,
          observedAt: "also-not-a-time",
        },
      },
    } as AccountEntitlement);

    const result = compileAccountEntitlementAdmission(input({
      entitlement: foreign,
    }));

    expect(result).toMatchObject({
      outcome: "deny",
      reason: "no_entitlement",
      entitlementRevision: null,
      entitlementSourceReference: null,
      windowId: null,
      remaining: null,
    });
    expect(JSON.stringify(result)).not.toContain("foreign");
  });

  test("binds the decision fingerprint to the stable subject, request identity, units, and current usage", () => {
    const first = compileAccountEntitlementAdmission(input({
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:fingerprint",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 2,
            reserved: 1,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));
    const replay = compileAccountEntitlementAdmission(input({
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:fingerprint",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 2,
            reserved: 1,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));
    const differentRequest = compileAccountEntitlementAdmission(input({
      requestIdentity: "request:write:002",
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:fingerprint",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 2,
            reserved: 1,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));
    const differentUnits = compileAccountEntitlementAdmission(input({
      units: 2,
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:fingerprint",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 2,
            reserved: 1,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }));
    const changedUsage = compileAccountEntitlementAdmission(input({
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:fingerprint",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: 3,
            reserved: 1,
            observedAt: "2026-08-26T07:59:30.000Z",
          },
        },
      }),
    }));

    expect(replay.decisionFingerprint).toBe(first.decisionFingerprint);
    expect(differentRequest.decisionFingerprint).not.toBe(first.decisionFingerprint);
    expect(differentUnits.decisionFingerprint).not.toBe(first.decisionFingerprint);
    expect(changedUsage.decisionFingerprint).not.toBe(first.decisionFingerprint);
    expect(changedUsage.remaining).toBe(6);
  });

  test("rejects invalid allowance arithmetic, request units, and intervals before producing a decision", () => {
    expect(() => compileAccountEntitlementAdmission(input({ units: 0 }))).toThrow("usage units");

    expect(() => compileAccountEntitlementAdmission(input({
      entitlement: entitlement({
        allowance: {
          kind: "window",
          windowId: "window:negative",
          limit: 10,
          resetAt: "2026-08-27T00:00:00.000Z",
          usage: {
            state: "known",
            consumed: -1,
            reserved: 0,
            observedAt: "2026-08-26T07:59:00.000Z",
          },
        },
      }),
    }))).toThrow("consumed usage");

    expect(() => compileAccountEntitlementAdmission(input({
      entitlement: entitlement({
        effectiveFrom: "2026-09-20T00:00:00.000Z",
        effectiveUntil: "2026-09-20T00:00:00.000Z",
      }),
    }))).toThrow("effective interval");
  });
});
