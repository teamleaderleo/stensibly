import { describe, expect, test } from "bun:test";
import {
  evaluateCallsignLifecycle,
  type CallsignLifecycleRequestInput,
  type PriorCallsignState,
} from "../src/callsign-lifecycle.ts";

const fourteenDays = 14 * 24 * 60 * 60;

function request(
  overrides: Partial<CallsignLifecycleRequestInput> = {},
): CallsignLifecycleRequestInput {
  return {
    requestedCallsign: "night-jar",
    newRunId: "run_new_holder",
    evaluatedAt: "2026-07-30T00:00:00Z",
    mode: "reuse",
    priorHolder: {
      callsign: "Nightjar",
      runId: "run_old_holder",
      state: "dormant",
      lastActiveAt: "2026-07-01T00:00:00Z",
    },
    policy: {
      version: "rotation-v1",
      coolingOffSeconds: fourteenDays,
    },
    ...overrides,
  };
}

describe("callsign lifecycle", () => {
  test("makes a quiet callsign reusable without rewriting prior attribution", () => {
    const result = evaluateCallsignLifecycle(request());

    expect(result).toEqual({
      version: 1,
      requestedCallsign: "night-jar",
      collisionKey: "nightjar",
      newRunId: "run_new_holder",
      evaluatedAt: "2026-07-30T00:00:00.000Z",
      mode: "reuse",
      priorHolder: {
        callsign: "Nightjar",
        collisionKey: "nightjar",
        runId: "run_old_holder",
        state: "dormant",
        lastActiveAt: "2026-07-01T00:00:00.000Z",
        releasedAt: null,
        retiredAt: null,
      },
      policy: {
        version: "rotation-v1",
        coolingOffSeconds: fourteenDays,
        explicitReleaseBypassesCoolingOff: false,
      },
      inheritance: null,
      decision: "reusable",
      eligible: true,
      coolingOffUntil: null,
      previouslyUsed: true,
      lineageKind: "reuse",
      priorAttributionPreserved: true,
      activatesCallsign: false,
      requiresDurableAcceptance: true,
      identityContinuity: false,
      authorityTransferred: false,
      responsibilityTransferred: false,
      fingerprint: "sha256:a4869c8dc90fd67191130196850768ff2889722676a034ff468c108aadf127bc",
    });
  });

  test("retains the exact historical display while comparing its canonical collision key", () => {
    const historicalDisplay = "Ｎｉｇｈｔ  Ｊａｒ";
    const result = evaluateCallsignLifecycle(request({
      priorHolder: {
        callsign: historicalDisplay,
        runId: "run_old_holder",
        state: "dormant",
        lastActiveAt: "2026-07-01T00:00:00Z",
      },
    }));

    expect(result.priorHolder.callsign).toBe(historicalDisplay);
    expect(result.priorHolder.collisionKey).toBe("nightjar");
    expect(result.requestedCallsign).toBe("night-jar");
    expect(result.collisionKey).toBe("nightjar");
    expect(result.priorAttributionPreserved).toBe(true);
  });

  test("blocks active use and reports the exact cooling-off boundary", () => {
    const active = evaluateCallsignLifecycle(request({
      priorHolder: {
        callsign: "Nightjar",
        runId: "run_old_holder",
        state: "active",
        lastActiveAt: "2026-07-29T23:00:00Z",
      },
    }));
    expect(active).toMatchObject({
      decision: "blocked_active",
      eligible: false,
      coolingOffUntil: null,
      lineageKind: null,
    });

    const cooling = evaluateCallsignLifecycle(request({
      evaluatedAt: "2026-07-14T23:59:59Z",
    }));
    expect(cooling).toMatchObject({
      decision: "blocked_cooling_off",
      eligible: false,
      coolingOffUntil: "2026-07-15T00:00:00.000Z",
    });

    const boundary = evaluateCallsignLifecycle(request({
      evaluatedAt: "2026-07-15T00:00:00Z",
    }));
    expect(boundary.decision).toBe("reusable");
  });

  test("allows an explicit release to bypass cooling only when policy says so", () => {
    const priorHolder = {
      callsign: "Nightjar",
      runId: "run_old_holder",
      state: "released" as const,
      lastActiveAt: "2026-07-28T00:00:00Z",
      releasedAt: "2026-07-29T00:00:00Z",
    };

    const cooling = evaluateCallsignLifecycle(request({
      priorHolder,
      policy: {
        version: "rotation-v1",
        coolingOffSeconds: fourteenDays,
      },
    }));
    expect(cooling).toMatchObject({
      decision: "blocked_cooling_off",
      coolingOffUntil: "2026-08-12T00:00:00.000Z",
    });

    const reusable = evaluateCallsignLifecycle(request({
      priorHolder,
      policy: {
        version: "rotation-v1",
        coolingOffSeconds: fourteenDays,
        explicitReleaseBypassesCoolingOff: true,
      },
    }));
    expect(reusable).toMatchObject({ decision: "reusable", eligible: true });
  });

  test("keeps retired callsigns unavailable", () => {
    const result = evaluateCallsignLifecycle(request({
      priorHolder: {
        callsign: "Nightjar",
        runId: "run_old_holder",
        state: "retired",
        lastActiveAt: "2026-06-01T00:00:00Z",
        retiredAt: "2026-06-02T00:00:00Z",
      },
    }));

    expect(result).toMatchObject({
      decision: "blocked_retired",
      eligible: false,
      lineageKind: null,
      priorAttributionPreserved: true,
    });
  });

  test("supports explicit inheritance from an active prior holder", () => {
    const result = evaluateCallsignLifecycle(request({
      mode: "inherit",
      priorHolder: {
        callsign: "Nightjar",
        runId: "run_old_holder",
        state: "active",
        lastActiveAt: "2026-07-30T00:00:00Z",
      },
      inheritance: {
        fromRunId: "run_old_holder",
        transferReference: "issue:301#comment-5092139414",
      },
    }));

    expect(result).toMatchObject({
      decision: "inherited",
      eligible: true,
      lineageKind: "inherit",
      inheritance: {
        fromRunId: "run_old_holder",
        transferReference: "issue:301#comment-5092139414",
      },
      priorAttributionPreserved: true,
      activatesCallsign: false,
      requiresDurableAcceptance: true,
      identityContinuity: false,
      authorityTransferred: false,
      responsibilityTransferred: false,
    });
  });

  test("requires exact inheritance provenance and a distinct new run", () => {
    expect(() => evaluateCallsignLifecycle(request({
      mode: "inherit",
    }))).toThrow("requires transfer metadata");

    expect(() => evaluateCallsignLifecycle(request({
      mode: "inherit",
      inheritance: {
        fromRunId: "run_someone_else",
        transferReference: "handoff:7",
      },
    }))).toThrow("must match the prior holder run ID");

    expect(() => evaluateCallsignLifecycle(request({
      newRunId: "run_old_holder",
    }))).toThrow("must differ from the prior holder run ID");

    expect(() => evaluateCallsignLifecycle(request({
      inheritance: {
        fromRunId: "run_old_holder",
        transferReference: "handoff:7",
      },
    }))).toThrow("reuse cannot include inheritance metadata");
  });

  test("uses the generator collision rules and rejects a different callsign", () => {
    const equivalent = evaluateCallsignLifecycle(request({
      requestedCallsign: "night_jar",
    }));
    expect(equivalent.collisionKey).toBe("nightjar");

    expect(() => evaluateCallsignLifecycle(request({
      requestedCallsign: "Teacup",
    }))).toThrow("must match the prior holder collision key");
  });

  test("rejects inconsistent states, malformed time, and invalid policy", () => {
    expect(() => evaluateCallsignLifecycle(request({
      priorHolder: {
        callsign: "Nightjar",
        runId: "run_old_holder",
        state: "released",
        lastActiveAt: "2026-07-01T00:00:00Z",
      },
    }))).toThrow("requires release time");

    expect(() => evaluateCallsignLifecycle(request({
      priorHolder: {
        callsign: "Nightjar",
        runId: "run_old_holder",
        state: "active",
        lastActiveAt: "2026-07-01T00:00:00Z",
        releasedAt: "2026-07-02T00:00:00Z",
      },
    }))).toThrow("cannot include release or retirement time");

    expect(() => evaluateCallsignLifecycle(request({
      priorHolder: {
        callsign: "Nightjar",
        runId: "run_old_holder",
        state: "captured" as PriorCallsignState,
        lastActiveAt: "2026-07-01T00:00:00Z",
      },
    }))).toThrow("Unknown prior callsign state");

    expect(() => evaluateCallsignLifecycle(request({
      evaluatedAt: "2026-02-30T00:00:00Z",
    }))).toThrow("valid calendar timestamp");

    expect(() => evaluateCallsignLifecycle(request({
      policy: {
        version: "rotation-v1",
        coolingOffSeconds: -1,
      },
    }))).toThrow("must be an integer from 0");
  });

  test("changes the fingerprint for material lifecycle decisions", () => {
    const reusable = evaluateCallsignLifecycle(request());
    const inherited = evaluateCallsignLifecycle(request({
      mode: "inherit",
      inheritance: {
        fromRunId: "run_old_holder",
        transferReference: "handoff:7",
      },
    }));
    const longerRotation = evaluateCallsignLifecycle(request({
      policy: {
        version: "rotation-v2",
        coolingOffSeconds: 60 * 24 * 60 * 60,
      },
    }));

    expect(inherited.fingerprint).not.toBe(reusable.fingerprint);
    expect(longerRotation.fingerprint).not.toBe(reusable.fingerprint);
    expect(evaluateCallsignLifecycle(request())).toEqual(reusable);
  });
});
