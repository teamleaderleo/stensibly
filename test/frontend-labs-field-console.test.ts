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
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-field-console.md"), "utf8");
const routeSource = `${html}\n${css}\n${compat}\n${app}`;
const sourceWithoutSvgNamespace = routeSource.replaceAll("http://www.w3.org/2000/svg", "");

const sharedTargets = [
  "approve-release-note",
  "moss",
  "ember",
  "repair-focus-order",
  "deploy-amber",
  "github",
  "api",
  "mcp",
];

const sharedTasks = [
  "human-decision",
  "worker-health",
  "recommended-work",
  "safe-reconciliation",
  "connection-health",
];

describe("Field Console frontend lab", () => {
  test("publishes one independently previewable prototype route", () => {
    const manifestEntry = frontendLabManifest.find((entry) => entry.id === "field-console");
    expect(manifestEntry).toMatchObject({
      owner: "Cinder",
      status: "prototype",
      revision: "8f9e13f7da46f3951284f2d920fdc99855259661",
      issue: 610,
      path: "./field-console/",
    });
    expect(manifestEntry?.support).toEqual([
      "wide",
      "medium",
      "narrow",
      "dark",
      "keyboard",
      "reduced-motion",
      "empty",
      "degraded",
      "error",
    ]);
    expect(html).toContain('data-stensibly-lab="prototype"');
    expect(html.indexOf('<script src="./compat.js"></script>')).toBeLessThan(html.indexOf('<script src="./app.js"></script>'));
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain("../planned.js");
    expect(html).not.toContain("../planned.css");
  });

  test("keeps every shared task and target available in the local object model", () => {
    for (const target of sharedTargets) expect(app).toContain(`id: "${target}"`);
    for (const task of sharedTasks) expect(app).toContain(`task: "${task}"`);
    expect(app).toContain('actionLabel: "Reconcile before retry"');
    expect(app).toContain("No retry performed. Safe next action");
    expect(app).toContain("remote settlement is unknown");
    expect(app).toContain("Top recommendation because it unblocks keyboard evidence across every variant");
  });

  test("synchronizes topology, text relationships, list, detail, connections, and timeline", () => {
    expect(html).toContain('id="object-list"');
    expect(html).toContain('id="topology"');
    expect(html).toContain('id="topology-links"');
    expect(html).toContain('id="relationship-summary"');
    expect(html).toContain('id="timeline-list"');
    expect(html).toContain('id="detail-body"');
    expect(html).toContain('id="connection-health"');
    expect(html).toContain("Selected relationships in text");
    expect(app).toContain("renderList(visible)");
    expect(app).toContain("renderTopology(visible)");
    expect(app).toContain("renderRelationships()");
    expect(app).toContain("renderTimeline()");
    expect(app).toContain("renderDetail()");
    expect(guide).toContain("dependency topology");
    expect(guide).toContain("not a geographic map");
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
    expect(clickListener).not.toBeNull();

    const oldItem = new FakeElement("item", "deploy-amber");
    const oldButton = new FakeElement("button", undefined, oldItem);
    oldItem.child = oldButton;
    items = [oldItem];
    clickListener?.({ target: oldButton });
    expect(animationFrames).toHaveLength(1);

    const replacementItem = new FakeElement("item", "deploy-amber");
    const replacementButton = new FakeElement("button", undefined, replacementItem);
    replacementItem.child = replacementButton;
    items = [replacementItem];
    animationFrames.shift()?.();
    expect(replacementButton.focused).toBe(true);
  });

  test("supports keyboard regions, density, scenarios, and narrow recovery", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Escape"]) expect(app).toContain(`"${key}"`);
    expect(app).toContain('event.key === "/"');
    expect(app).toContain('event.key.toLowerCase() === "d"');
    expect(app).toContain('/^[1-4]$/.test(event.key)');
    expect(app).toContain("focusRegion(Number(event.key))");
    expect(app).toContain('density === "comfortable" ? "compact" : "comfortable"');
    expect(app).toContain('["default", "empty", "degraded", "error"]');
    expect(app).toContain("Restore default fixture");
    expect(app).toContain('document.body.dataset.mobileDetail = "false"');
    expect(compat).toContain("SecurityError");
    expect(compat).toContain("requestAnimationFrame");
    expect(css).toContain('@media (max-width: 48rem)');
    expect(css).toContain('body[data-mobile-detail="true"] .alerts');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('button:focus-visible');
    expect(css).toContain('body[data-density="compact"]');
  });

  test("uses literal non-color state meaning and preserves readable targets", () => {
    for (const label of [
      "human decision",
      "lease unhealthy",
      "ambiguous settlement",
      "degraded",
      "reconnecting",
      "offline",
      "recovered",
    ]) expect(app).toContain(label);
    expect(css).toContain('content: "◆"');
    expect(css).toContain('content: "×"');
    expect(css).toContain('content: "▲"');
    expect(css).toContain('content: "✓"');
    expect(css).toContain("min-height: 2.5rem");
    expect(css).toContain("transform: translate(-50%, -50%)");
    expect(guide).toContain("State is never color-only");
  });

  test("stays fixture-only, flat, and free of external authority", () => {
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
    expect(guide).toContain("No production dashboard, authentication, API, deployment, or durable state");
  });
});
