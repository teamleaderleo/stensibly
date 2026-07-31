import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture, frontendLabTasks } from "../site/labs/fixtures.js";
import { frontendLabManifest } from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "field-console");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const css = readFileSync(join(routeRoot, "styles.css"), "utf8");
const compat = readFileSync(join(routeRoot, "compat.js"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-field-console.md"), "utf8");
const routeSource = `${html}\n${css}\n${compat}\n${app}`;
const sourceWithoutSvgNamespace = routeSource.replaceAll("http://www.w3.org/2000/svg", "");
const fixtureText = JSON.stringify(frontendLabFixture);

describe("Field Console frontend lab", () => {
  test("publishes one shared-fixture prototype route", () => {
    const manifestEntry = frontendLabManifest.find((entry) => entry.id === "field-console");
    expect(manifestEntry).toMatchObject({
      owner: "Cinder",
      status: "prototype",
      revision: "a665bfd8b449940423838e31622d5c19e8603c7d",
      issue: 610,
      path: "./field-console/",
    });
    expect(manifestEntry?.support).toEqual([
      "wide", "medium", "narrow", "dark", "keyboard", "reduced-motion", "empty", "degraded", "error",
    ]);
    expect(frontendLabManifest.slice(0, 3).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "quiet-control", status: "prototype" },
      { id: "soft-companion", status: "prototype" },
      { id: "field-console", status: "prototype" },
    ]);
    expect(html).toContain('data-stensibly-lab="prototype"');
    expect(html.indexOf('<script src="../fixtures.classic.js"></script>')).toBeLessThan(html.indexOf('<script src="./compat.js"></script>'));
    expect(html.indexOf('<script src="./compat.js"></script>')).toBeLessThan(html.indexOf('<script src="./app.js"></script>'));
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain("../planned.js");
    expect(html).not.toContain("../planned.css");
  });

  test("consumes every shared task and identity instead of duplicating fixture records", () => {
    expect(app).toContain("globalThis.StensiblyFrontendLabFixtures");
    expect(app).toContain("frontendLabFixture: fixture");
    expect(app).toContain("frontendLabTasks: tasks");
    expect(app).toContain("...fixture.workers.map");
    expect(app).toContain("...fixture.readyWork.map");
    expect(app).toContain("...fixture.operations.map");
    expect(app).toContain("...fixture.connections.map");
    expect(app).toContain('task.success.split(",")');
    expect(app).not.toContain("const records = Object.freeze([");
    expect(frontendLabTasks).toHaveLength(5);
    for (const task of frontendLabTasks) {
      expect(app).toContain("taskIdsByRecord");
      for (const identity of task.success.split(",")) expect(fixtureText).toContain(identity);
    }
    expect(guide).toContain("merged classic shared-fixture bridge");
  });

  test("uses one projected record truth across every readable surface", () => {
    expect(app).toContain("const projected = projectedRecords()");
    for (const call of [
      "renderHealth(projected)",
      "renderTopology(visible, projected)",
      "renderRelationships(projected)",
      "renderTimeline(projected)",
      "renderDetail(projected)",
    ]) expect(app).toContain(call);
    expect(app).toContain("const entry = selectedId ? byId(selectedId, projected) : null");
    expect(app).toContain("byId(link.from, projected)");
    expect(app).toContain("byId(event.recordId, projected)");
    expect(app).toContain("projected.filter((candidate) => candidate.kind === \"connection\")");
    expect(app).toContain("Fictional degraded preview: review-thread evidence is delayed by 18 minutes");
    expect(app).not.toMatch(/byId\(selectedId\)(?!,)/);
    expect(guide).toContain("one scenario projection");
  });

  test("keeps action labels, authority, persistence, and ambiguity truthful", () => {
    for (const label of [
      "Read decision guidance",
      "Read activity guidance",
      "Read recovery guidance",
      "Read recommendation",
      "Read: Reconcile before retry",
      "Read evidence guidance",
      "Read recovery receipt",
      "Read connection guidance",
    ]) expect(app).toContain(label);
    expect(app).toContain("Fixture-only guidance:");
    expect(app).toContain("No product action was performed");
    expect(app).toContain("Safe recovery guidance:");
    expect(app).toContain("No retry was performed");
    expect(app).toContain('["Authority", "Fixture guidance only"]');
    expect(app).toContain('["Persistence", "Page instance only; nothing saved"]');
    expect(html).toContain("Guidance has no product authority, nothing is saved");
    expect(guide).toContain("performs no product action");
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
    const listener = clickListener as ((event: { target: FakeElement }) => void) | null;
    if (!listener) throw new Error("Field Console timeline listener was not registered");

    const oldItem = new FakeElement("item", "deploy-amber");
    const oldButton = new FakeElement("button", undefined, oldItem);
    oldItem.child = oldButton;
    items = [oldItem];
    listener({ target: oldButton });
    expect(animationFrames).toHaveLength(1);

    const replacementItem = new FakeElement("item", "deploy-amber");
    const replacementButton = new FakeElement("button", undefined, replacementItem);
    replacementItem.child = replacementButton;
    items = [replacementItem];
    animationFrames.shift()?.();
    expect(replacementButton.focused).toBe(true);
  });

  test("supports keyboard regions, density, scenarios, narrow recovery, and reduced motion", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Escape"]) expect(app).toContain(`"${key}"`);
    expect(app).toContain('event.key === "/"');
    expect(app).toContain('event.key.toLowerCase() === "d"');
    expect(app).toContain('/^[1-4]$/.test(event.key)');
    expect(app).toContain("focusRegion(Number(event.key))");
    expect(app).toContain('density === "comfortable" ? "compact" : "comfortable"');
    expect(app).toContain('["default", "empty", "degraded", "error"]');
    expect(app).toContain("Restore default fixture");
    expect(app).toContain('document.body.dataset.mobileDetail = "false"');
    expect(css).toContain('@media (max-width: 48rem)');
    expect(css).toContain('body[data-mobile-detail="true"] .alerts');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('button:focus-visible');
    expect(css).toContain('body[data-density="compact"]');
  });

  test("stays fictional, flat, and free of external authority", () => {
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(compat)).not.toThrow();
    expect(routeSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(sourceWithoutSvgNamespace).not.toMatch(/https?:\/\//);
    expect(routeSource).not.toMatch(/stn\.tok_/);
    expect(routeSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(routeSource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(css).not.toContain("url(");
    expect(css).not.toContain("@import");
    expect(html).not.toMatch(/<(?:img|iframe)\b/i);
    expect(guide).toContain("No production dashboard, authentication, API, deployment, or durable state recovery");
  });
});
