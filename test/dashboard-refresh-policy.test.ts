import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_REFRESH_DELAYS_MS,
  DASHBOARD_VISIBILITY_WAKE_MS,
  dashboardItemsFingerprint,
  dashboardRefreshDelay,
  dashboardRefreshMode,
  nextDashboardRefreshLevel,
  normalizeDashboardRefreshLevel,
} from "../site/dashboard-refresh-policy.js";

const first = {
  id: "item-1",
  version: 1,
  status: "ready",
  updatedAt: "2026-07-29T12:00:00.000Z",
};
const second = {
  id: "item-2",
  version: 3,
  status: "active",
  updatedAt: "2026-07-29T12:05:00.000Z",
};

describe("hosted dashboard refresh policy", () => {
  test("uses a bounded 15/45/90/180 second delay ladder", () => {
    expect(DASHBOARD_REFRESH_DELAYS_MS).toEqual([15000, 45000, 90000, 180000]);
    expect(DASHBOARD_VISIBILITY_WAKE_MS).toBe(1000);
    expect([-4, 0, 1, 2, 3, 99, "NaN"].map(dashboardRefreshDelay)).toEqual([
      15000,
      15000,
      45000,
      90000,
      180000,
      180000,
      15000,
    ]);
  });

  test("normalizes malformed persisted levels before indexing the delay ladder", () => {
    expect(normalizeDashboardRefreshLevel(undefined)).toBe(0);
    expect(normalizeDashboardRefreshLevel("NaN")).toBe(0);
    expect(normalizeDashboardRefreshLevel("2junk")).toBe(0);
    expect(normalizeDashboardRefreshLevel("1.5")).toBe(0);
    expect(normalizeDashboardRefreshLevel("-1")).toBe(0);
    expect(normalizeDashboardRefreshLevel("2")).toBe(2);
    expect(normalizeDashboardRefreshLevel("999999")).toBe(3);
  });

  test("fingerprints only stable item identity and rendered change fields", () => {
    expect(dashboardItemsFingerprint([second, first]))
      .toBe(dashboardItemsFingerprint([first, second]));
    expect(dashboardItemsFingerprint([{ ...first, title: "ignored" }, second]))
      .toBe(dashboardItemsFingerprint([first, second]));
    expect(dashboardItemsFingerprint([{ ...first, version: 2 }, second]))
      .not.toBe(dashboardItemsFingerprint([first, second]));
    expect(dashboardItemsFingerprint([{ ...first, status: "blocked" }, second]))
      .not.toBe(dashboardItemsFingerprint([first, second]));
  });

  test("backs off unchanged background reads and resets after changes or human actions", () => {
    const fingerprint = dashboardItemsFingerprint([first, second]);
    expect(nextDashboardRefreshLevel({
      previousFingerprint: fingerprint,
      nextFingerprint: fingerprint,
      currentLevel: 0,
    })).toBe(1);
    expect(nextDashboardRefreshLevel({
      previousFingerprint: fingerprint,
      nextFingerprint: fingerprint,
      currentLevel: 3,
    })).toBe(3);
    expect(nextDashboardRefreshLevel({
      previousFingerprint: fingerprint,
      nextFingerprint: dashboardItemsFingerprint([{ ...first, version: 2 }, second]),
      currentLevel: 3,
    })).toBe(0);
    expect(nextDashboardRefreshLevel({
      previousFingerprint: fingerprint,
      nextFingerprint: fingerprint,
      currentLevel: 3,
      interactive: true,
    })).toBe(0);
    expect(nextDashboardRefreshLevel({
      previousFingerprint: "",
      nextFingerprint: fingerprint,
      currentLevel: 3,
      initial: true,
    })).toBe(0);
  });

  test("exposes hidden, waking, and active refresh modes", () => {
    expect(dashboardRefreshMode({ hidden: true, level: 3 })).toBe("auto paused · hidden");
    expect(dashboardRefreshMode({ hidden: false, level: 2, waking: true }))
      .toBe("auto · waking");
    expect(dashboardRefreshMode({ hidden: false, level: 2 })).toBe("auto · 90s");
  });
});
