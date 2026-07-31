import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabManifest } from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "field-console");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const css = readFileSync(join(routeRoot, "styles.css"), "utf8");
const compat = readFileSync(join(routeRoot, "compat.js"), "utf8");
const policy = readFileSync(join(routeRoot, "fixture-policy.js"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-field-console.md"), "utf8");
const routeSource = `${html}\n${css}\n${compat}\n${policy}\n${app}`;
const sourceWithoutSvgNamespace = routeSource.replaceAll("http://www.w3.org/2000/svg", "");

describe("Field Console frontend lab", () => {
  test("publishes one direct shared-fixture prototype route", () => {
    expect(frontendLabManifest.find((entry) => entry.id === "field-console")).toEqual({
      id: "field-console",
      title: "Field Console",
      thesis: "A dense operational view pairing exact object state, alert triage, topology, timeline, and detail.",
      owner: "Cinder",
      status: "prototype",
      revision: "b00657024e00545ed88603fe1e33ce603c83e17a",
      issue: 610,
      path: "./field-console/",
      support: ["wide", "medium", "narrow", "dark", "keyboard", "reduced-motion", "empty", "degraded", "error"],
    });

    const fixtureIndex = html.indexOf('<script src="../fixtures.classic.js"></script>');
    const compatIndex = html.indexOf('<script src="./compat.js"></script>');
    const policyIndex = html.indexOf('<script src="./fixture-policy.js"></script>');
    const appIndex = html.indexOf('<script src="./app.js"></script>');
    expect(fixtureIndex).toBeGreaterThan(-1);
    expect(fixtureIndex).toBeLessThan(compatIndex);
    expect(compatIndex).toBeLessThan(policyIndex);
    expect(policyIndex).toBeLessThan(appIndex);
    expect(html).not.toContain("fixture-bridge.js");
    expect(html).toContain('data-stensibly-lab="prototype"');
    expect(html).not.toContain("../planned.js");
    expect(html).not.toContain("../planned.css");
  });

  test("renders every readable surface from one validated projection", () => {
    for (const id of ["object-list", "topology", "topology-links", "relationship-summary", "timeline-list", "detail-body", "connection-health"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(app).toContain("globalThis.StensiblyFieldConsolePolicy");
    expect(app).toContain("const baseRecords = Object.freeze");
    expect(app).toContain("return policy.projectRecords(baseRecords, scenario)");
    expect(app).toContain("renderHealth(projection)");
    expect(app).toContain("renderTopology(visible, projection)");
    expect(app).toContain("renderRelationships(projection)");
    expect(app).toContain("renderTimeline(projection)");
    expect(app).toContain("renderDetail(projection)");
    expect(app).toContain('container.setAttribute("aria-label", `Connection health:');
    expect(app).not.toContain("const records = Object.freeze([");
    expect(app).not.toContain("scenarioRecords = function");
    expect(policy).toContain("must match the shared fixture identities");
    expect(policy).toContain("must keep its shared fixture kind");
    expect(policy).toContain("Review-thread evidence is delayed by 18 minutes");
  });

  test("keeps actions truthful and ambiguity fail-closed", () => {
    for (const stale of ["Review decision", "Start recovery", "Open recommendation", "View evidence", "Open activity"]) {
      expect(app).not.toContain(`actionLabel: "${stale}"`);
    }
    expect(policy).toContain('state === "ambiguous" ? "Read safe next action" : "Read next action"');
    expect(app).toContain('entry.state === "ambiguous" ? "No retry performed. Safe next action" : "Preview only. Next action"');
    expect(app).toContain("No product action was performed");
    expect(guide).toContain("read-only guidance");
    expect(guide).toContain("never retries, approves, recovers, publishes, or mutates");
  });

  test("keeps scenario URLs and timeline focus recoverable inside opaque sandbox frames", () => {
    class FakeDomException extends Error {
      name: string;
      constructor(message: string, name: string) {
        super(message);
        this.name = name;
      }
    }
    class FakeHistory {}
    Object.defineProperty(FakeHistory.prototype, "replaceState", {
      value(kind: string) {
        if (kind === "security") throw new FakeDomException("opaque origin", "SecurityError");
        throw new TypeError("unexpected history failure");
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });

    class FakeElement {
      dataset: { recordId?: string };
      kind: "button" | "item";
      parent: FakeElement | null;
      child: FakeElement | null = null;
      focused = false;
      constructor(kind: "button" | "item", recordId?: string, parent: FakeElement | null = null) {
        this.kind = kind;
        this.dataset = { recordId };
        this.parent = parent;
      }
      closest(selector: string) {
        if (selector === "li[data-record-id] button") return this.kind === "button" ? this : null;
        if (selector === "li[data-record-id]") return this.kind === "item" ? this : this.parent;
        return null;
      }
      querySelector(selector: string) {
        return selector === "button" ? this.child : null;
      }
      focus() {
        this.focused = true;
      }
    }

    let items: FakeElement[] = [];
    let clickListener: ((event: { target: FakeElement }) => void) | null = null;
    let listenerOptions: { capture?: boolean } | undefined;
    const animationFrames: Array<() => void> = [];
    const timeline = {
      addEventListener(type: string, listener: typeof clickListener, options: { capture?: boolean }) {
        if (type === "click") {
          clickListener = listener;
          listenerOptions = options;
        }
      },
      contains(node: FakeElement) {
        return items.some((item) => item.child === node);
      },
      querySelectorAll(selector: string) {
        return selector === "li[data-record-id]" ? items : [];
      },
    };

    runInNewContext(compat, {
      History: FakeHistory,
      DOMException: FakeDomException,
      Element: FakeElement,
      Reflect,
      document: { querySelector: (selector: string) => selector === "#timeline-list" ? timeline : null },
      requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
      Error,
      TypeError,
    });

    const history = new FakeHistory() as { replaceState: (kind: string) => unknown };
    expect(() => history.replaceState("security")).not.toThrow();
    expect(() => history.replaceState("unexpected")).toThrow("unexpected history failure");
    expect(listenerOptions).toEqual({ capture: true });
    const registered = clickListener as ((event: { target: FakeElement }) => void) | null;
    if (!registered) throw new Error("Field Console timeline listener was not registered");

    const oldItem = new FakeElement("item", "deploy-amber");
    const oldButton = new FakeElement("button", undefined, oldItem);
    oldItem.child = oldButton;
    items = [oldItem];
    registered({ target: oldButton });
    expect(animationFrames).toHaveLength(1);

    const replacementItem = new FakeElement("item", "deploy-amber");
    const replacementButton = new FakeElement("button", undefined, replacementItem);
    replacementItem.child = replacementButton;
    items = [replacementItem];
    animationFrames.shift()?.();
    expect(replacementButton.focused).toBe(true);
  });

  test("supports keyboard regions, density, scenarios, and narrow recovery", () => {
    for (const literal of [
      'event.key === "/"',
      '"ArrowDown"',
      '"ArrowUp"',
      '"Escape"',
      'event.key.toLowerCase() === "d"',
      '/^[1-4]$/.test(event.key)',
      'density === "comfortable" ? "compact" : "comfortable"',
      '["default", "empty", "degraded", "error"]',
      "Restore default fixture",
      'document.body.dataset.mobileDetail = "false"',
    ]) expect(app).toContain(literal);
    expect(css).toContain("@media (max-width: 48rem)");
    expect(css).toContain('body[data-mobile-detail="true"] .alerts');
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("button:focus-visible");
    expect(css).toContain('body[data-density="compact"]');
  });

  test("uses literal non-color state meaning and stays authority-free", () => {
    for (const label of ["human decision", "lease unhealthy", "ambiguous settlement", "degraded", "reconnecting", "offline", "recovered"]) {
      expect(app).toContain(label);
    }
    expect(css).toContain('content: "◆"');
    expect(css).toContain('content: "×"');
    expect(css).toContain('content: "▲"');
    expect(css).toContain('content: "✓"');
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(policy)).not.toThrow();
    expect(() => new Function(compat)).not.toThrow();
    expect(routeSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(sourceWithoutSvgNamespace).not.toMatch(/https?:\/\//);
    expect(routeSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(routeSource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(routeSource).not.toMatch(/stn\.tok_/);
    expect(html).not.toMatch(/<(?:img|iframe)\b/i);
    expect(css).not.toContain("@import");
    expect(css).not.toContain("url(");
    expect(guide).toContain("not a geographic map");
    expect(guide).toContain("State is never color-only");
    expect(guide).toContain("No production dashboard, authentication, API, deployment, or durable state");
  });
});
