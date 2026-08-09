import { describe, expect, test } from "bun:test";

const siteFile = (name: string) => Bun.file(new URL(`../site/${name}`, import.meta.url)).text();

describe("production operator workspace", () => {
  test("loads the operator layer last and preserves the signed-out composition", async () => {
    const html = await siteFile("index.html");
    const crunchIndex = html.indexOf('href="/crunch-root.css"');
    const operatorIndex = html.indexOf('href="/operator-root.css"');

    expect(crunchIndex).toBeGreaterThan(0);
    expect(operatorIndex).toBeGreaterThan(crunchIndex);
    expect(html).toContain("<h1>Your agents are already out there.</h1>");
    expect(html).toContain('id="github-sign-in"');
  });

  test("puts operator state ahead of account mechanics", async () => {
    const html = await siteFile("index.html");

    expect(html).toContain('<p class="eyebrow">Studio airspace</p>');
    expect(html).toContain('class="dashboard-lede"');
    expect(html.indexOf('id="metric-blocked"')).toBeLessThan(html.indexOf('id="metric-active"'));
    expect(html.indexOf('id="metric-active"')).toBeLessThan(html.indexOf('id="metric-ready"'));
    expect(html.indexOf('id="board"')).toBeLessThan(html.indexOf('id="session-context-panel"'));
    expect(html).toContain("Crews on frequency");
    expect(html).not.toContain("People and agents working here");
  });

  test("keeps provider capacity available without placing it above work", async () => {
    const [entry, css] = await Promise.all([
      siteFile("provider-capacity-entry.js"),
      siteFile("operator-root.css"),
    ]);

    expect(entry).toContain('sessionContext.insertAdjacentHTML(\'beforebegin\', panelMarkup())');
    expect(entry).toContain('<details class="provider-capacity"');
    expect(entry).toContain('<summary class="provider-capacity-head">');
    expect(entry).not.toContain("metrics.insertAdjacentHTML");
    expect(css).toContain(".provider-capacity[open] .provider-capacity-head");
  });

  test("ranks work by intervention and keeps card controls valid", async () => {
    const app = await siteFile("app.js");
    const blocked = app.indexOf("['blocked', 'Needs attention'");
    const active = app.indexOf("['active', 'In motion'");
    const ready = app.indexOf("['ready', 'Ready next'");
    const done = app.indexOf("['done', 'Done'");

    expect(blocked).toBeGreaterThan(0);
    expect(active).toBeGreaterThan(blocked);
    expect(ready).toBeGreaterThan(active);
    expect(done).toBeGreaterThan(ready);
    expect(app).toContain('class="card-title"');
    expect(app).toContain('class="card-next"');
    expect(app).not.toContain('<h4>${escapeHtml(item.title)}</h4>');
    expect(app).not.toContain('<p>${escapeHtml(item.summary)}</p>');
  });

  test("uses one responsive list, readable type tokens, and no gradients", async () => {
    const css = await siteFile("operator-root.css");

    expect(css).toContain("--text-xs: .75rem");
    expect(css).toContain(".board {");
    expect(css).toContain("grid-template-columns: 1fr;");
    expect(css).toContain(".card-next");
    expect(css).toContain('html[data-app-mode="editing"] .login-card');
    expect(css).toContain("@media (max-width: 820px)");
    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });

  test("moves board updates to one concise live region", async () => {
    const [html, app] = await Promise.all([siteFile("index.html"), siteFile("app.js")]);

    expect(html).toContain('<section class="board" id="board" aria-label="Work grouped by disposition"></section>');
    expect(html).toContain('id="board-announcer" aria-live="polite"');
    expect(app).toContain("if (boardAnnouncer.textContent !== announcement)");
  });

  test("puts the spatial field before the exact manifest", async () => {
    const [html, app, css] = await Promise.all([
      siteFile("index.html"),
      siteFile("app.js"),
      siteFile("airspace-operator.css"),
    ]);

    expect(html.indexOf('class="flight-deck"')).toBeLessThan(html.indexOf('id="board"'));
    expect(html).toContain('id="traffic-layer"');
    expect(html).toContain('id="tower-list"');
    expect(app).toContain("renderAirfield(visible)");
    expect(app).toContain("renderTower(visible)");
    expect(app).toContain("data-flight-item-id");
    expect(css).toContain("--sky-field: #78b978;");
    expect(css).toContain(".flight-marker");
    expect(css).toContain(".runway-active");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
