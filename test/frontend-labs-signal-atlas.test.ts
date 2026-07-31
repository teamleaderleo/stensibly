import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabManifest } from "../site/labs/manifest.js";

const root = join(import.meta.dir, "..");
const route = join(root, "site", "labs", "signal-atlas");
const html = readFileSync(join(route, "index.html"), "utf8");
const css = readFileSync(join(route, "styles.css"), "utf8");
const policy = readFileSync(join(route, "fixture-policy.js"), "utf8");
const app = readFileSync(join(route, "app.js"), "utf8");
const mapFocus = readFileSync(join(route, "map-focus.js"), "utf8");
const guide = readFileSync(join(root, "docs", "frontend-signal-atlas.md"), "utf8");
const source = `${html}\n${css}\n${policy}\n${app}\n${mapFocus}`;
const sourceWithoutSvgNamespace = source.replaceAll("http://www.w3.org/2000/svg", "");

describe("Signal Atlas frontend lab", () => {
  test("publishes the direct shared-fixture narrative route", () => {
    expect(frontendLabManifest.find((entry) => entry.id === "signal-atlas")).toEqual({
      id: "signal-atlas",
      title: "Signal Atlas",
      thesis: "An editorial map and timeline treatment for explaining incidents, dependencies, and evidence as a guided narrative.",
      owner: "Cinder",
      status: "prototype",
      revision: "2e10f2fc9ba04f532d794d0b5ea76168a6b43ae1",
      issue: 611,
      path: "./signal-atlas/",
      support: ["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion"],
    });
    const fixtureIndex = html.indexOf('<script src="../fixtures.classic.js"></script>');
    const modalIndex = html.indexOf('<script src="./ledger-modal.js"></script>');
    const policyIndex = html.indexOf('<script src="./fixture-policy.js"></script>');
    const appIndex = html.indexOf('<script src="./app.js"></script>');
    const focusIndex = html.indexOf('<script src="./map-focus.js"></script>');
    expect(fixtureIndex).toBeLessThan(modalIndex);
    expect(modalIndex).toBeLessThan(policyIndex);
    expect(policyIndex).toBeLessThan(appIndex);
    expect(appIndex).toBeLessThan(focusIndex);
    expect(html).not.toContain("fixture-bridge.js");
    expect(app).toContain("globalThis.StensiblySignalAtlasPolicy");
    expect(app).toContain("const records = policy.projectRecords(baseRecords)");
    expect(app).not.toContain("const records = Object.freeze([");
  });

  test("keeps every shared target and task in five direct chapters", () => {
    for (const target of ["approve-release-note", "moss", "ember", "repair-focus-order", "deploy-amber", "github", "api", "mcp"]) {
      expect(app).toContain(`"${target}"`);
    }
    for (const task of ["human-decision", "worker-health", "recommended-work", "safe-reconciliation", "connection-health"]) {
      expect(app).toContain(`"${task}"`);
    }
    for (const chapter of ["decision", "workers", "recommendation", "ambiguity", "connections"]) {
      expect(app).toContain(`id: "${chapter}"`);
    }
    expect(app).toContain("A timeout is not permission to retry");
    expect(app).toContain("GitHub is healthy, the API is reconnecting, and MCP is offline");
  });

  test("uses one projected truth for landscape, evidence, providers, and ledger", () => {
    expect(app).toContain("mapNodes.replaceChildren(...records.map");
    expect(app).toContain('const providers = ["github", "api", "mcp"].map(byId)');
    expect(app).toContain('providers.map((entry) => [entry.title, stateLabels[entry.state]])');
    expect(app).toContain("Paper Lantern shared fictional fixture");
    expect(app).toContain("const recordEntry = byId(entry.recordId)");
    expect(app).not.toContain('["GitHub", "healthy"]');
    expect(app).not.toContain("renderSharedSignalAtlasMap");
    expect(app).not.toContain("byId = function");
    expect(guide).toContain("before the first render");
    expect(guide).toContain("There is no post-render monkey patch or second initialization render");
  });

  test("validates complete ledger destinations and preserves safe ambiguity language", () => {
    for (const mapping of [
      'ember: "workers"',
      '"archive-coral": "ambiguity"',
      '"deploy-amber": "ambiguity"',
      'moss: "workers"',
      'api: "connections"',
      '"approve-release-note": "decision"',
    ]) expect(app).toContain(mapping);
    expect(app).toContain("Signal Atlas ledger destinations must cover every event exactly");
    expect(app).toContain("must contain ledger record");
    expect(app).toContain("const chapterId = ledgerChapter(entry.recordId)");
    expect(guide).toContain("The ambiguous operation never exposes a retry action");
    expect(guide).toContain("reconcile-before-retry behavior");
  });

  test("provides static, native, and reduced-motion parity", () => {
    expect(html).toContain("Complete static explanation");
    expect(html).toContain('id="show-ledger"');
    expect(html).toContain('id="ledger-list"');
    expect(app).toContain("renderStaticStory()");
    expect(app).toContain("renderLedger()");
    for (const key of ["ArrowRight", "ArrowLeft", "Escape"]) expect(app).toContain(`"${key}"`);
    expect(app).toContain('/^[1-5]$/.test(keyboardEvent.key)');
    expect(app).toContain('keyboardEvent.key.toLowerCase() === "l"');
    expect(app).toContain('behavior: reducedMotion ? "auto" : "smooth"');
    expect(source).not.toMatch(/addEventListener\(["'](?:wheel|scroll)["']/);
    expect(source).not.toMatch(/scroll-snap|setInterval|autoplay/i);
    expect(guide).toContain("There is no wheel interception, scroll snapping, forced autoplay, timed chapter advance, or locked progression");
  });

  test("restores focus to the visible replacement landscape node", () => {
    class FakeElement {
      dataset: { recordId?: string };
      hidden: boolean;
      focused = false;
      closestResult: FakeElement | null;
      constructor(recordId?: string, hidden = false, closestResult?: FakeElement | null) {
        this.dataset = { recordId };
        this.hidden = hidden;
        this.closestResult = closestResult === undefined ? this : closestResult;
      }
      closest(selector: string) { return selector === "button[data-record-id]" ? this.closestResult : null; }
      focus() { this.focused = true; }
    }
    let nodes: FakeElement[] = [];
    let clickListener: ((event: { target: FakeElement }) => void) | null = null;
    const frames: Array<() => void> = [];
    const mapNodes = {
      addEventListener(type: string, listener: typeof clickListener) { if (type === "click") clickListener = listener; },
      contains(node: FakeElement) { return nodes.includes(node); },
      querySelectorAll(selector: string) { return selector === "button[data-record-id]" ? nodes : []; },
    };
    runInNewContext(mapFocus, {
      document: { querySelector: (selector: string) => selector === "#map-nodes" ? mapNodes : null },
      Element: FakeElement,
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      Error,
    });
    const registered = clickListener as ((event: { target: FakeElement }) => void) | null;
    if (!registered) throw new Error("Signal Atlas map listener was not registered");
    const oldNode = new FakeElement("deploy-amber");
    nodes = [oldNode];
    registered({ target: oldNode });
    const hidden = new FakeElement("deploy-amber", true);
    const replacement = new FakeElement("deploy-amber");
    nodes = [hidden, replacement];
    frames.shift()?.();
    expect(hidden.focused).toBe(false);
    expect(replacement.focused).toBe(true);
  });

  test("uses abstract fiction and stays local, flat, and authority-free", () => {
    expect(html).toContain("Abstract fictional work landscape");
    expect(guide).toContain("has no relevant real-world coordinates");
    expect(guide).toContain("No real data layer is used");
    expect(() => new Function(policy)).not.toThrow();
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(mapFocus)).not.toThrow();
    expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(sourceWithoutSvgNamespace).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(source).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(source).not.toMatch(/stn\.tok_/);
    expect(html).not.toMatch(/<(?:img|iframe)\b/i);
    expect(css).not.toContain("@import");
    expect(css).not.toContain("url(");
    expect(guide).toContain("No production dashboard, authentication, API, persistence, deployment, or durable state is involved");
  });
});
