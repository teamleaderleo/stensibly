import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_REFRESH_DELAYS_MS,
  DASHBOARD_VISIBILITY_WAKE_MS,
  acceptDashboardRefreshResult,
  clearDashboardRefreshState,
  dashboardItemsFingerprint,
  dashboardRefreshDelay,
  dashboardRefreshMode,
  nextDashboardRefreshLevel,
  normalizeDashboardRefreshLevel,
  readDashboardRefreshState,
} from "../site/dashboard-refresh-policy.js";

const first = { id: "item-1", version: 1, status: "ready", updatedAt: "2026-07-29T12:00:00.000Z" };
const second = { id: "item-2", version: 3, status: "active", updatedAt: "2026-07-29T12:05:00.000Z" };

describe("hosted dashboard refresh policy", () => {
  test("uses a bounded 15/45/90/180 second delay ladder", () => {
    expect(DASHBOARD_REFRESH_DELAYS_MS).toEqual([15000, 45000, 90000, 180000]);
    expect(DASHBOARD_VISIBILITY_WAKE_MS).toBe(1000);
    expect([-4, 0, 1, 2, 3, 99, "NaN"].map(dashboardRefreshDelay)).toEqual([
      15000, 15000, 45000, 90000, 180000, 180000, 15000,
    ]);
  });

  test("normalizes malformed persisted levels before delay lookup", () => {
    expect(normalizeDashboardRefreshLevel(undefined)).toBe(0);
    expect(normalizeDashboardRefreshLevel("NaN")).toBe(0);
    expect(normalizeDashboardRefreshLevel("2junk")).toBe(0);
    expect(normalizeDashboardRefreshLevel("1.5")).toBe(0);
    expect(normalizeDashboardRefreshLevel("-1")).toBe(0);
    expect(normalizeDashboardRefreshLevel("2")).toBe(2);
    expect(normalizeDashboardRefreshLevel("999999")).toBe(3);
  });

  test("uses a fixed-size order-independent content-minimised digest", () => {
    expect(dashboardItemsFingerprint([second, first])).toBe(dashboardItemsFingerprint([first, second]));
    expect(dashboardItemsFingerprint([{ ...first, title: "ignored" }, second])).toBe(dashboardItemsFingerprint([first, second]));
    expect(dashboardItemsFingerprint([{ ...first, version: 2 }, second])).not.toBe(dashboardItemsFingerprint([first, second]));
    expect(dashboardItemsFingerprint([{ ...first, status: "blocked" }, second])).not.toBe(dashboardItemsFingerprint([first, second]));
    const large = Array.from({ length: 20_000 }, (_, index) => ({
      id: `item-${index}-${"x".repeat(500)}`,
      version: index,
      status: index % 2 ? "active" : "ready",
      updatedAt: "2026-07-29T12:00:00.000Z",
    }));
    const digest = dashboardItemsFingerprint(large);
    expect(digest).toMatch(/^v1:20000:[0-9a-f]{32}$/);
    expect(digest.length).toBeLessThan(64);
  });

  test("backs off unchanged reads and resets after change or interaction", () => {
    const fingerprint = dashboardItemsFingerprint([first, second]);
    expect(nextDashboardRefreshLevel({ previousFingerprint: fingerprint, nextFingerprint: fingerprint, currentLevel: 0 })).toBe(1);
    expect(nextDashboardRefreshLevel({ previousFingerprint: fingerprint, nextFingerprint: fingerprint, currentLevel: 3 })).toBe(3);
    expect(nextDashboardRefreshLevel({ previousFingerprint: fingerprint, nextFingerprint: dashboardItemsFingerprint([{ ...first, version: 2 }, second]), currentLevel: 3 })).toBe(0);
    expect(nextDashboardRefreshLevel({ previousFingerprint: fingerprint, nextFingerprint: fingerprint, currentLevel: 3, interactive: true })).toBe(0);
  });

  test("publishes one complete in-memory state when storage rejects the write", () => {
    const throwingStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("quota"); },
      removeItem() { throw new Error("blocked"); },
    };
    expect(readDashboardRefreshState(throwingStorage)).toEqual({ level: 0, fingerprint: "" });
    const result = acceptDashboardRefreshResult({
      storage: throwingStorage,
      previousFingerprint: dashboardItemsFingerprint([first]),
      currentLevel: 3,
      nextItems: [first, second],
    });
    expect(result).toMatchObject({
      items: [first, second],
      level: 0,
      fingerprint: dashboardItemsFingerprint([first, second]),
      persisted: false,
    });
    expect(clearDashboardRefreshState(throwingStorage)).toBe(false);
  });

  test("persists one bounded atomic refresh record", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    };
    const result = acceptDashboardRefreshResult({ storage, previousFingerprint: "", currentLevel: 3, nextItems: [first, second], initial: true });
    expect(result.persisted).toBe(true);
    expect([...values.keys()]).toEqual(["stensiblyRefreshState"]);
    expect(values.get("stensiblyRefreshState")?.length).toBeLessThan(128);
    expect(readDashboardRefreshState(storage)).toEqual({ level: 0, fingerprint: result.fingerprint });
  });

  test("exposes hidden, waking, and active refresh modes", () => {
    expect(dashboardRefreshMode({ hidden: true, level: 3 })).toBe("auto paused · hidden");
    expect(dashboardRefreshMode({ hidden: false, level: 2, waking: true })).toBe("auto · waking");
    expect(dashboardRefreshMode({ hidden: false, level: 2 })).toBe("auto · 90s");
  });
});
