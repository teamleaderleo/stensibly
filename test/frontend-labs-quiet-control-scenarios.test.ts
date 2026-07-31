import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabManifest } from "../site/labs/manifest.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "quiet-control");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const scenarioSource = readFileSync(join(routeRoot, "scenario.js"), "utf8");

describe("Quiet Control deterministic scenarios", () => {
  test("publishes exact empty and degraded route support", () => {
    const variant = frontendLabManifest.find((entry) => entry.id === "quiet-control");
    expect(variant).toMatchObject({
      status: "prototype",
      revision: "9349f135134177904a2efb50f187cf6237f7d6ba",
    });
    expect(variant?.support).toContain("empty");
    expect(variant?.support).toContain("degraded");
    expect(html.indexOf('./app.js')).toBeLessThan(html.indexOf('./nav-focus.js'));
    expect(html.indexOf('./nav-focus.js')).toBeLessThan(html.indexOf('./scenario.js'));
  });

  test("drives empty and degraded scenarios through existing recoverable controls", () => {
    const empty = executeScenario("?scenario=empty");
    expect(empty.body.dataset.scenario).toBe("empty");
    expect(empty.animationFrames).toHaveLength(1);
    empty.animationFrames.shift()?.();
    expect(empty.unhealthyFilter.clicked).toBe(1);
    expect(empty.recoverView.clicked).toBe(0);
    expect(empty.degradedRecord.clicked).toBe(0);

    const degraded = executeScenario("?scenario=degraded");
    expect(degraded.body.dataset.scenario).toBe("degraded");
    expect(degraded.animationFrames).toHaveLength(1);
    degraded.animationFrames.shift()?.();
    expect(degraded.recoverView.clicked).toBe(1);
    expect(degraded.animationFrames).toHaveLength(1);
    degraded.animationFrames.shift()?.();
    expect(degraded.degradedRecord.clicked).toBe(1);
  });

  test("fails closed to default for absent or unknown scenario identities", () => {
    for (const search of ["", "?scenario=unknown", "?scenario=error"]) {
      const result = executeScenario(search);
      expect(result.body.dataset.scenario).toBe("default");
      expect(result.animationFrames).toEqual([]);
      expect(result.unhealthyFilter.clicked).toBe(0);
      expect(result.recoverView.clicked).toBe(0);
      expect(result.degradedRecord.clicked).toBe(0);
    }
  });

  test("stays local, authority-free, and no-gradient", () => {
    expect(() => new Function(scenarioSource)).not.toThrow();
    expect(scenarioSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(scenarioSource).not.toMatch(/https?:\/\//);
    expect(scenarioSource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(scenarioSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(scenarioSource).not.toMatch(/\b(?:approve|retry|publish|deploy|save)\s*\(/i);
  });
});

function executeScenario(search: string) {
  class FakeButton {
    clicked = 0;
    click() {
      this.clicked += 1;
    }
  }

  const body = { dataset: {} as Record<string, string> };
  const unhealthyFilter = new FakeButton();
  const recoverView = new FakeButton();
  const degradedRecord = new FakeButton();
  const animationFrames: Array<() => void> = [];

  runInNewContext(scenarioSource, {
    document: {
      body,
      querySelector(selector: string) {
        if (selector === 'button[data-filter="unhealthy"]') return unhealthyFilter;
        if (selector === 'button[data-view="recover"]') return recoverView;
        if (selector === '[data-record-id="sync-violet"]') return degradedRecord;
        return null;
      },
    },
    location: { search },
    requestAnimationFrame(callback: () => void) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    HTMLButtonElement: FakeButton,
    URLSearchParams,
    Set,
    Error,
  });

  return { body, unhealthyFilter, recoverView, degradedRecord, animationFrames };
}
