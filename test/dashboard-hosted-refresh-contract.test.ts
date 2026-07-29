import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const app = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const policy = readFileSync(
  new URL("../site/dashboard-refresh-policy.js", import.meta.url),
  "utf8",
);

describe("hosted dashboard refresh integration", () => {
  test("uses the bounded policy instead of a fixed interval", () => {
    expect(app).toContain("from './dashboard-refresh-policy.js'");
    expect(app).toContain("dashboardItemsFingerprint(nextItems)");
    expect(app).toContain("nextDashboardRefreshLevel({");
    expect(app).toContain("dashboardRefreshDelay(refreshLevel)");
    expect(app).not.toContain("const REFRESH_INTERVAL_MS");
    expect(app).not.toContain("setInterval(");
  });

  test("stops hidden polling and wakes after visibility returns", () => {
    expect(app).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
    expect(app).toContain("if (!interactive && !initial && document.hidden)");
    expect(app).toContain("if (document.hidden) {");
    expect(app).toContain("DASHBOARD_VISIBILITY_WAKE_MS");
    expect(policy).toContain("auto paused · hidden");
    expect(policy).toContain("auto · waking");
  });

  test("keeps manual and post-mutation refreshes interactive", () => {
    expect(app).toContain("refreshCurrent({ interactive: true })");
    expect(app).toContain("onChanged: async () => {");
    expect(app).toContain("await refreshCurrent({ interactive: true });");
  });

  test("persists only bounded refresh state and a content-free fingerprint", () => {
    expect(app).toContain("sessionStorage.stensiblyRefreshLevel");
    expect(app).toContain("sessionStorage.stensiblyItemsFingerprint");
    expect(app).not.toContain("sessionStorage.stensiblyItems =");
    expect(app).not.toContain("sessionStorage.stensiblyTitles");
  });
});
