import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "maximum-goofy-dashboard");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const css = readFileSync(join(routeRoot, "styles.css"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-maximum-goofy-dashboard.md"), "utf8");
const manifest = readFileSync(join(repositoryRoot, "site", "labs", "manifest.js"), "utf8");
const routeSource = `${html}\n${css}\n${app}`;

const tropeHeadings = [
  "Omnidirectional agent radar",
  "Swarm constellation",
  "Collective thought river",
  "Executive confidence engine",
  "Token astrology",
  "Quantum execution Gantt",
  "Elite agent leaderboard",
  "Multiversal aura matrix",
  "Terminal waterfall",
  "Strategic omen deck",
  "Decision roulette",
  "Ceremonial command deck",
  "Meaninglessness ledger",
];

const defectLabels = [
  "No source",
  "No denominator",
  "No definition",
  "No durable identity",
  "No operator action",
  "Motion without evidence",
  "Fabricated thought stream",
  "Invented completion and ETA",
  "Prestige ranking without task evidence",
  "Heatmap without scale",
  "Volume masquerades as evidence",
  "Buttons imply authority they do not have",
];

describe("Maximum Goofy Dashboard frontend anti-reference", () => {
  test("publishes one hidden independently previewable anti-reference route", () => {
    expect(html).toContain('data-stensibly-lab="anti-reference"');
    expect(html).toContain("Maximum Goofy Dashboard");
    expect(html).toContain("Fictional anti-reference.");
    expect(html).toContain("nothing on this page is live");
    expect(html).toContain('<script src="./app.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="./styles.css">');
    expect(manifest).not.toContain("maximum-goofy-dashboard");
    expect(guide).toContain("outside the Labs manifest");
  });

  test("includes the full maximalist dashboard trope collection", () => {
    for (const heading of tropeHeadings) expect(html).toContain(heading);
    expect(html.match(/data-panel/g)?.length ?? 0).toBeGreaterThanOrEqual(25);
    expect(html.match(/data-truth="fictional"/g)?.length ?? 0).toBeGreaterThanOrEqual(25);
    expect(html).toContain("12 premium indicators · 0 operational definitions");
    expect(html).toContain("Total visibility into absolutely nothing.");
  });

  test("makes every joke self-describing through Roast mode", () => {
    for (const label of defectLabels) expect(html).toContain(label);
    expect(html.match(/class="roast-label"/g)?.length ?? 0).toBeGreaterThanOrEqual(25);
    expect(html).toContain('id="roast-toggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(app).toContain('body.dataset.roast = String(next)');
    expect(app).toContain('roastToggle.setAttribute("aria-pressed", String(next))');
    expect(css).toContain('body[data-roast="true"] .roast-label');
    expect(guide).toContain("exact failure class attached to every panel");
  });

  test("uses deterministic local controls with zero claimed product effect", () => {
    expect(() => new Function(app)).not.toThrow();
    expect(app).toContain("intensityPresets");
    expect(app).toContain('Object.freeze({ level: "5", minds: "144"');
    expect(app).toContain("Only fictional presentation values changed");
    expect(app).toContain("Ceremonial action only; no product effect");
    expect(app).toContain("No product action occurred");
    expect(app).toContain('if (key === "r") roastToggle.click()');
    expect(app).toContain('if (key === "a") amplifyButton.click()');
    expect(app).toContain('if (key === "t") themeButton.click()');
    expect(app).not.toContain("Math.random");
    expect(app).not.toContain("setInterval");
    expect(app).not.toContain("setTimeout");
  });

  test("keeps the spectacle keyboard reachable, readable, and motion-optional", () => {
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('aria-live="polite"');
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("min-height: 2.75rem");
    expect(css).toContain("@media (max-width: 52rem)");
    expect(css).toContain("@media (max-width: 30rem)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important");
    expect(css).toContain("transition: none !important");
    expect(guide).toContain("every animation-dependent joke retains text");
  });

  test("stays fixture-only, flat, and free of external authority", () => {
    expect(routeSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(routeSource).not.toMatch(/https?:\/\//);
    expect(routeSource).not.toMatch(/stn\.tok_/);
    expect(routeSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(routeSource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(css).not.toContain("url(");
    expect(css).not.toContain("@import");
    expect(html).not.toMatch(/<(?:img|iframe)\b/i);
    expect(html).not.toContain('type="module"');
    expect(guide).toContain("zero CSS gradients");
    expect(guide).toContain("no external asset, library, image, iframe, remote font, API call, credential, private record, analytics, tracker, browser storage, product mutation, or durable state");
  });
});
