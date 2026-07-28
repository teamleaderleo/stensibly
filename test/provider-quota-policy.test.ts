import { describe, expect, test } from "bun:test";
import {
  createDefaultVercelQuotaPolicy,
  evaluateProviderQuotaAdmission,
  parseProviderQuotaPolicy,
  type ProviderQuotaRequest,
  type ProviderQuotaSnapshot,
} from "../src/provider-quota-policy.ts";

const policy = createDefaultVercelQuotaPolicy("team_operator");

function snapshot(
  overrides: Partial<ProviderQuotaSnapshot> = {},
): ProviderQuotaSnapshot {
  return {
    observedUnits: 20,
    activeReservationUnits: 0,
    unreconciledStartedUnits: 0,
    uncertaintyUnits: 0,
    recentStartsLastHour: 2,
    expiringNextHourUnits: 1,
    observedAt: "2026-07-28T22:25:00Z",
    evaluatedAt: "2026-07-28T22:30:00Z",
    nextCapacityAt: "2026-07-28T23:00:00Z",
    ...overrides,
  };
}

function request(
  overrides: Partial<ProviderQuotaRequest> = {},
): ProviderQuotaRequest {
  return {
    requestClass: "production",
    units: 1,
    ready: true,
    equivalentActiveRequest: false,
    ...overrides,
  };
}

describe("adaptive provider quota admission", () => {
  test("admits ready work immediately while projected use is open", () => {
    const result = evaluateProviderQuotaAdmission(
      policy,
      snapshot(),
      request({ requestClass: "preview" }),
    );

    expect(result).toMatchObject({
      pressureBand: "open",
      snapshotFreshness: "fresh",
      action: "admit",
      reason: "immediate_capacity_available",
      effectiveUnits: 20,
      forecastUnits: 21,
      remainingUnits: 80,
      requiresLease: true,
    });
  });

  test("uses recent burn to enter metered pressure before the raw count reaches 50", () => {
    const result = evaluateProviderQuotaAdmission(
      policy,
      snapshot({
        observedUnits: 48,
        recentStartsLastHour: 10,
        expiringNextHourUnits: 0,
      }),
      request({ requestClass: "preview" }),
    );

    expect(result).toMatchObject({
      pressureBand: "metered",
      effectiveUnits: 48,
      forecastUnits: 58,
      action: "queue",
      reason: "preview_metered",
      requiresLease: false,
    });
  });

  test("lets production continue in metered pressure while optional previews queue", () => {
    const metered = snapshot({ observedUnits: 60, recentStartsLastHour: 0 });

    expect(evaluateProviderQuotaAdmission(policy, metered, request())).toMatchObject({
      pressureBand: "metered",
      action: "admit",
    });
    expect(evaluateProviderQuotaAdmission(
      policy,
      metered,
      request({ requestClass: "preview" }),
    )).toMatchObject({
      pressureBand: "metered",
      action: "queue",
      reason: "preview_metered",
    });
  });

  test("queues routine production at high pressure but admits rollback and incident work", () => {
    const queued = snapshot({ observedUnits: 78, recentStartsLastHour: 0 });

    expect(evaluateProviderQuotaAdmission(policy, queued, request())).toMatchObject({
      pressureBand: "queued",
      action: "queue",
      reason: "routine_queue_required",
    });
    expect(evaluateProviderQuotaAdmission(
      policy,
      queued,
      request({ requestClass: "rollback" }),
    )).toMatchObject({
      action: "admit",
      requiresLease: true,
    });
    expect(evaluateProviderQuotaAdmission(
      policy,
      queued,
      request({ requestClass: "incident" }),
    )).toMatchObject({
      action: "admit",
      requiresLease: true,
    });
  });

  test("protects the last ten units for explicit operator, rollback, or incident work", () => {
    const reserveOnly = snapshot({ observedUnits: 94, recentStartsLastHour: 0 });

    expect(evaluateProviderQuotaAdmission(policy, reserveOnly, request())).toMatchObject({
      pressureBand: "reserve_only",
      action: "queue",
      reason: "protected_reserve",
      remainingUnits: 6,
    });
    expect(evaluateProviderQuotaAdmission(
      policy,
      reserveOnly,
      request({ requestClass: "operator" }),
    )).toMatchObject({
      action: "admit",
      projectedUnitsAfterAdmission: 95,
    });
  });

  test("does not cross the hard limit even for a priority request", () => {
    expect(evaluateProviderQuotaAdmission(
      policy,
      snapshot({ observedUnits: 100, recentStartsLastHour: 0 }),
      request({ requestClass: "operator" }),
    )).toMatchObject({
      pressureBand: "closed",
      action: "defer",
      reason: "hard_limit_reached",
      remainingUnits: 0,
      requiresLease: false,
    });

    expect(evaluateProviderQuotaAdmission(
      policy,
      snapshot({ observedUnits: 99, recentStartsLastHour: 0 }),
      request({ requestClass: "rollback", units: 2 }),
    )).toMatchObject({
      action: "defer",
      reason: "insufficient_headroom",
      remainingUnits: 1,
    });
  });

  test("counts reservations, ambiguous starts, and uncertainty before granting capacity", () => {
    const result = evaluateProviderQuotaAdmission(
      policy,
      snapshot({
        observedUnits: 65,
        activeReservationUnits: 5,
        unreconciledStartedUnits: 4,
        uncertaintyUnits: 3,
        recentStartsLastHour: 0,
      }),
      request(),
    );

    expect(result).toMatchObject({
      observedUnits: 65,
      committedUnits: 9,
      effectiveUnits: 77,
      pressureBand: "queued",
      action: "queue",
    });
  });

  test("raises caution when provider reconciliation is stale or missing", () => {
    const stale = evaluateProviderQuotaAdmission(
      policy,
      snapshot({
        observedUnits: 10,
        recentStartsLastHour: 0,
        observedAt: "2026-07-28T21:00:00Z",
      }),
      request({ requestClass: "preview" }),
    );
    expect(stale).toMatchObject({
      snapshotFreshness: "stale",
      pressureBand: "metered",
      pressureUnits: 50,
      action: "queue",
    });

    const missing = evaluateProviderQuotaAdmission(
      policy,
      snapshot({ observedUnits: 10, recentStartsLastHour: 0, observedAt: null }),
      request(),
    );
    expect(missing).toMatchObject({
      snapshotFreshness: "missing",
      pressureBand: "queued",
      pressureUnits: 75,
      action: "queue",
    });
  });

  test("coalesces duplicate candidates and holds work that is not release-ready", () => {
    expect(evaluateProviderQuotaAdmission(
      policy,
      snapshot(),
      request({ equivalentActiveRequest: true }),
    )).toMatchObject({
      action: "coalesce",
      reason: "equivalent_request_active",
    });

    expect(evaluateProviderQuotaAdmission(
      policy,
      snapshot(),
      request({ ready: false }),
    )).toMatchObject({
      action: "hold",
      reason: "request_not_ready",
    });
  });

  test("rejects malformed threshold order and future provider observations", () => {
    expect(() => parseProviderQuotaPolicy({
      ...policy,
      queuedAt: 45,
    })).toThrow(
      "Provider quota thresholds must satisfy meteredAt < queuedAt < reserveOnlyAt < hardLimit",
    );

    expect(() => evaluateProviderQuotaAdmission(
      policy,
      snapshot({ observedAt: "2026-07-28T22:31:00Z" }),
      request(),
    )).toThrow("Provider observation time cannot be later than evaluation time");
  });
});
