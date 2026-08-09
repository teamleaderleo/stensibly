import { describe, expect, test } from "bun:test";

const siteFile = (name: string) => Bun.file(new URL(`../site/${name}`, import.meta.url)).text();

describe("production studio control", () => {
  test("ships one dark-first application layer without the retired airport stack", async () => {
    const html = await siteFile("index.html");
    const studioIndex = html.indexOf('href="/studio-control.css"');

    expect(html).toContain('<html lang="en" data-theme="dark" data-dashboard-view="overview">');
    expect(studioIndex).toBeGreaterThan(html.indexOf('href="/root-mode-status.css"'));
    for (const retired of [
      "login-scrapbook.css",
      "calm-root.css",
      "crunch-root.css",
      "operator-root.css",
      "airspace-operator.css",
      "flight-deck",
      "traffic-layer",
      "Studio Airfield",
    ]) expect(html).not.toContain(retired);
    expect(html).toContain("<h1>Know what needs you.</h1>");
    expect(html).toContain('id="github-sign-in"');
  });

  test("puts operational answers first and moves mechanics into deliberate views", async () => {
    const html = await siteFile("index.html");

    expect(html).toContain('data-dashboard-view-panel="overview"');
    expect(html).toContain('id="focus-list"');
    expect(html).toContain('id="recent-list"');
    expect(html).toContain('data-dashboard-view-panel="work" hidden');
    expect(html).toContain('data-dashboard-view-panel="system" hidden');
    expect(html.indexOf('id="focus-list"')).toBeLessThan(html.indexOf('id="board"'));
    expect(html.indexOf('id="board"')).toBeLessThan(html.indexOf('id="session-context-panel"'));
    expect(html.indexOf('id="metric-blocked"')).toBeLessThan(html.indexOf('id="metric-active"'));
  });

  test("keeps theme and view as device-local preferences", async () => {
    const [html, preferences] = await Promise.all([
      siteFile("index.html"),
      siteFile("ui-preferences.js"),
    ]);

    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('data-dashboard-view-target="overview"');
    expect(preferences).toContain("const THEME_KEY = 'stensiblyTheme'");
    expect(preferences).toContain("const VIEW_KEY = 'stensiblyDashboardView'");
    expect(preferences).toContain("applyTheme(readPreference(THEME_KEY, themes) || 'dark')");
    expect(preferences).toContain("applyView(readPreference(VIEW_KEY, views) || 'overview'");
    expect(preferences).not.toMatch(/sessionStorage|document\.cookie|fetch\s*\(/);
  });

  test("renders a bounded priority and recent-change overview over exact board records", async () => {
    const app = await siteFile("app.js");

    expect(app).toContain("const attentionRank = { blocked: 0, active: 1, ready: 2, done: 3 }");
    expect(app).toContain(".filter((item) => item.status !== 'done')");
    expect(app).toContain(".slice(0, 8)");
    expect(app).toContain("data-overview-item-id");
    expect(app).toContain("board.querySelectorAll('button.card[data-item-id]')");
    expect(app).not.toMatch(/renderAirfield|renderTower|flightCallsign|data-flight-item-id/);
  });

  test("uses flat light and dark palettes with narrow and reduced-motion support", async () => {
    const css = await siteFile("studio-control.css");

    expect(css).toContain('html[data-theme="dark"]');
    expect(css).toContain('html[data-theme="light"]');
    expect(css).toContain("--bg: #0c0e11");
    expect(css).toContain("--bg: #f2f3f5");
    expect(css).toContain(".overview-grid");
    expect(css).toContain("@media (max-width: 680px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });

  test("keeps connection controls and work mutations intact", async () => {
    const html = await siteFile("index.html");
    for (const marker of [
      'id="connect-form"',
      'id="hosted-sign-in"',
      'id="hosted-sign-out"',
      'name="endpoint"',
      'name="token"',
      'id="change-connection"',
      'id="disconnect-connection"',
      'id="project-filter"',
      'id="create-item"',
      'id="refresh"',
      'id="item-detail-dialog"',
      'id="create-item-dialog"',
    ]) expect(html).toContain(marker);
  });

  test("keeps loading in the background and capacity dormant until opened", async () => {
    const [app, statusCss, capacity] = await Promise.all([
      siteFile("app.js"),
      siteFile("root-mode-status.css"),
      siteFile("provider-capacity-entry.js"),
    ]);

    expect(app).toContain("readDashboardSnapshot(browserLocalStorage, { endpoint })");
    expect(app).toContain("items = dashboardSnapshot ? [...dashboardSnapshot.items] : []");
    expect(app).toContain("void refreshCurrent({ initial: true })");
    expect(statusCss).toContain("position: absolute");
    expect(statusCss).toContain("clip: rect(0, 0, 0, 0)");
    expect(capacity).toContain("panel?.addEventListener('toggle', refreshWhenOpened)");
    expect(capacity).not.toMatch(/queueMicrotask|MutationObserver/);
  });
});
