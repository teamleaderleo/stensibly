import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_SNAPSHOT_MAX_AGE_MS,
  DASHBOARD_SNAPSHOT_STORAGE_KEY,
  clearDashboardSnapshot,
  persistDashboardSnapshot,
  readDashboardSnapshot,
} from "../site/dashboard-snapshot-cache.js";

const endpoint = "https://api.stensibly.com";
const savedAt = "2026-08-10T01:00:00.000Z";
const item = {
  id: "item_airfield_1",
  project: "stensibly",
  kind: "task",
  title: "Keep the field visible",
  summary: "Replace the blocking root skeleton.",
  nextAction: "Revalidate the cached field in the background.",
  status: "active",
  priority: 82,
  claimedBy: "Keel",
  claimExpiresAt: "2026-08-10T02:00:00.000Z",
  claimGeneration: 4,
  version: 9,
  createdAt: "2026-08-09T01:00:00.000Z",
  updatedAt: "2026-08-10T00:59:00.000Z",
} as const;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}

describe("dashboard last-known field cache", () => {
  test("round-trips one bounded endpoint-bound snapshot without credentials", () => {
    const storage = memoryStorage();
    expect(persistDashboardSnapshot(storage, { endpoint, items: [item], savedAt })).toBe(true);
    const raw = storage.values.get(DASHBOARD_SNAPSHOT_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("stn.tok_");
    expect(raw).not.toContain("authorization");
    expect(readDashboardSnapshot(storage, {
      endpoint,
      now: Date.parse(savedAt) + 60_000,
    })).toEqual({
      version: 1,
      endpoint,
      savedAt,
      items: [item],
    });
  });

  test("rejects another endpoint, expired state, malformed items, and oversized payloads", () => {
    const storage = memoryStorage();
    expect(persistDashboardSnapshot(storage, { endpoint, items: [item], savedAt })).toBe(true);
    expect(readDashboardSnapshot(storage, {
      endpoint: "https://other.example",
      now: Date.parse(savedAt) + 1,
    })).toBeNull();
    expect(readDashboardSnapshot(storage, {
      endpoint,
      now: Date.parse(savedAt) + DASHBOARD_SNAPSHOT_MAX_AGE_MS + 1,
    })).toBeNull();
    expect(persistDashboardSnapshot(storage, {
      endpoint,
      items: [{ ...item, title: "stn.tok_secret" }],
      savedAt,
    })).toBe(false);
    expect(persistDashboardSnapshot(storage, {
      endpoint,
      items: Array.from({ length: 241 }, (_, index) => ({ ...item, id: `item_${index}` })),
      savedAt,
    })).toBe(false);
  });

  test("fails closed around storage exceptions and clears on explicit sign-out", () => {
    const throwingStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("quota"); },
      removeItem() { throw new Error("blocked"); },
    };
    expect(readDashboardSnapshot(throwingStorage, { endpoint })).toBeNull();
    expect(persistDashboardSnapshot(throwingStorage, { endpoint, items: [item], savedAt })).toBe(false);
    expect(clearDashboardSnapshot(throwingStorage)).toBe(false);

    const storage = memoryStorage();
    expect(persistDashboardSnapshot(storage, { endpoint, items: [item], savedAt })).toBe(true);
    expect(clearDashboardSnapshot(storage)).toBe(true);
    expect(storage.values.has(DASHBOARD_SNAPSHOT_STORAGE_KEY)).toBe(false);
  });
});
