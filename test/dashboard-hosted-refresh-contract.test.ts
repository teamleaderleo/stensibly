import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const app = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const policy = readFileSync(new URL("../site/dashboard-refresh-policy.js", import.meta.url), "utf8");

describe("hosted dashboard refresh integration", () => {
  test("uses the bounded policy instead of a fixed interval", () => {
    expect(app).toContain("from './dashboard-refresh-policy.js'");
    expect(app).toContain("acceptDashboardRefreshResult({");
    expect(app).toContain("dashboardRefreshDelay(refreshLevel)");
    expect(app).not.toContain("const REFRESH_INTERVAL_MS");
    expect(app).not.toContain("setInterval(");
  });

  test("stops hidden polling and wakes after visibility returns", () => {
    expect(app).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
    expect(app).toContain("if (!interactive && !initial && document.hidden)");
    expect(app).toContain("DASHBOARD_VISIBILITY_WAKE_MS");
    expect(policy).toContain("auto paused · hidden");
    expect(policy).toContain("auto · waking");
  });

  test("keeps manual and post-mutation refreshes interactive", () => {
    expect(app).toContain("refreshCurrent({ interactive: true })");
    expect(app).toContain("await refreshCurrent({ interactive: true });");
  });

  test("publishes accepted results independently of optional session persistence", () => {
    expect(app).toContain("const browserSessionStorage = optionalSessionStorage()");
    expect(app).toContain("items = nextState.items;");
    expect(app).toContain("refreshLevel = nextState.level;");
    expect(app).toContain("refreshFingerprint = nextState.fingerprint;");
    expect(app).toContain("clearDashboardRefreshState(browserSessionStorage)");
    expect(app).not.toContain("sessionStorage.");
    expect(policy).toContain("stensiblyRefreshState");
    expect(policy).not.toContain("item.title");
    expect(policy).not.toContain("item.summary");
    expect(policy).not.toContain("item.nextAction");
  });
});
