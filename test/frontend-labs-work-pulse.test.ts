import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  frontendLabManifest,
  frontendLabVariantById,
} from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "work-pulse");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const css = readFileSync(join(routeRoot, "styles.css"), "utf8");

describe("Work Pulse frontend lab", () => {
  test("registers one exact fixture-only operator route", () => {
    const variant = frontendLabVariantById(frontendLabManifest, "work-pulse");

    expect(variant).toEqual({
      id: "work-pulse",
      title: "Work Pulse",
      thesis: "A text-first evidence pulse for active responsibility, stale authority, ambiguous effects, and human attention.",
      owner: "Plover",
      status: "prototype",
      revision: "4ce8fa8e3b83ff32d312135cc730d05dde830c07",
      issue: 699,
      path: "./work-pulse/",
      support: [
        "wide",
        "medium",
        "narrow",
        "light",
        "dark",
        "keyboard",
        "reduced-motion",
        "empty",
        "degraded",
        "error",
      ],
    });
  });

  test("loads the immutable shared fixture before the local renderer", () => {
    const fixtureIndex = html.indexOf('../fixtures.classic.js');
    const appIndex = html.indexOf('./app.js');

    expect(fixtureIndex).toBeGreaterThan(0);
    expect(appIndex).toBeGreaterThan(fixtureIndex);
    expect(html).toContain('<body data-stensibly-lab="prototype" data-scenario="default">');
    expect(html).toContain('href="#attention"');
    expect(html).toContain('data-scenario-link="default"');
    expect(html).toContain('data-scenario-link="degraded"');
    expect(html).toContain('data-scenario-link="empty"');
    expect(html).toContain("No network calls, mutations, analytics, simulated progress, or private data.");
  });

  test("renders literal responsibility, attention, evidence, and recovery concepts", () => {
    expect(app).toContain('Object.getOwnPropertyDescriptor(globalThis, globalName)');
    expect(app).toContain('"Waiting and recoverable"');
    expect(app).toContain('"Moving now"');
    expect(app).toContain('"External effects"');
    expect(app).toContain('"Evidence rail"');
    expect(app).toContain('"Connection health"');
    expect(app).toContain('"Review lease and reassign safely"');
    expect(app).toContain('"Ambiguous outcomes reconcile before retry; recovery never erases history."');
    expect(app).toContain('value === "empty" || value === "degraded"');
    expect(app).toContain('document.body.setAttribute("data-scenario", normalized)');
  });

  test("contains no live transport, fake progress, or unsafe HTML sink", () => {
    expect(app).not.toMatch(/\bfetch\s*\(/u);
    expect(app).not.toContain("WebSocket");
    expect(app).not.toContain("EventSource");
    expect(app).not.toContain("setInterval");
    expect(app).not.toContain("Math.random");
    expect(app).not.toContain("innerHTML");
    expect(`${html}\n${app}`.toLowerCase()).not.toContain("percent complete");
    expect(`${html}\n${app}`.toLowerCase()).not.toContain("estimated time");
    expect(`${html}\n${app}`.toLowerCase()).not.toContain("chain of thought");
  });

  test("keeps the visual contract responsive, accessible, and motion-independent", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("@media (max-width: 48rem)");
    expect(css).not.toMatch(/gradient/iu);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
  });
});
