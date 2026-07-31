import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture, frontendLabTasks } from "../site/labs/fixtures.js";
import { frontendLabManifest } from "../site/labs/manifest.js";

const root = join(import.meta.dir, "..", "site", "labs", "soft-companion");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "styles.css"), "utf8");
const compat = readFileSync(join(root, "compat.js"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const rationale = readFileSync(join(import.meta.dir, "..", "docs", "frontend-soft-companion.md"), "utf8");
const variant = frontendLabManifest.find((entry) => entry.id === "soft-companion");

type ConnectionRecord = {
  id: string;
  label: string;
  state: string;
  detail: string;
};

type SoftCompanionPolicy = {
  projectConnections(connections: readonly ConnectionRecord[], scenario: string): readonly ConnectionRecord[];
  operationalAnnouncement(label: string, nextAction: string, safeRecovery?: boolean): string;
};

describe("Soft Companion frontend lab", () => {
  test("publishes an exact shared-fixture prototype identity", () => {
    expect(variant).toMatchObject({
      owner: "Cinder",
      status: "prototype",
      revision: "8dc94e166f4711fff2edcf91c6d8ba299417f785",
      issue: 608,
      path: "./soft-companion/",
    });
    expect(variant?.support).toEqual(["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion", "loading", "empty", "degraded", "error"]);
    expect(frontendLabManifest.slice(0, 2).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "quiet-control", status: "prototype" },
      { id: "soft-companion", status: "prototype" },
    ]);
    expect(html).toContain('data-stensibly-lab="prototype"');
    expect(html).toContain("shared fictional fixtures");
    expect(html.indexOf('../fixtures.classic.js')).toBeLessThan(html.indexOf('./compat.js'));
    expect(html.indexOf('./compat.js')).toBeLessThan(html.indexOf('./app.js'));
    expect(html).not.toContain('type="module"');
    expect(html).toContain('aria-label="Selected work detail"');
    expect(html).toContain('id="scenario-select" aria-labelledby="scenario-title"');
    expect(html).toContain('aria-label="Search drawers and shared tasks"');
  });

  test("maps every shared task to exact fixture identities and visible destinations", () => {
    const expectedTargets = new Map<string, string>([
      ["human-decision", String(frontendLabFixture.decision.id)],
      ["worker-health", "ember"],
      ["recommended-work", String(frontendLabFixture.readyWork[0]!.id)],
      ["safe-reconciliation", String(frontendLabFixture.operations[0]!.id)],
    ]);
    expect(frontendLabTasks).toHaveLength(5);
    expect(app).toContain("...tasks.map");
    for (const task of frontendLabTasks) {
      for (const identity of task.success.split(",")) expect(JSON.stringify(frontendLabFixture)).toContain(identity);
      if (expectedTargets.has(task.id)) expect(app).toContain(`identity: "${expectedTargets.get(task.id)}"`);
    }
    expect(app).toContain("focusConnections(task.prompt)");
    expect(html).toContain('id="connection-shelf" tabindex="-1"');
  });

  test("keeps ambiguity literal and primary controls honest synchronously", () => {
    expect(app).toContain('disposition: operation.state === "ambiguous" ? "Reconcile before retry"');
    expect(app).toContain('row.semanticState === "ambiguous"');
    expect(app).toContain("No retry was performed");
    expect(app).toContain('text("strong", row.semanticState === "ambiguous" ? "Safe next action"');
    expect(app).toContain("const policy = globalThis.StensiblySoftCompanionPolicy");
    expect(app).toContain("function projectedConnections()");
    expect(app).toContain("for (const connection of projectedConnections())");
    expect(app).toContain('const operational = row.tone === "serious" || row.tone === "warning"');
    expect(app).toContain('"Acknowledge in preview"');
    expect(app).toContain("policy.operationalAnnouncement(row.action, row.next)");
    expect(compat).toContain("projectConnections");
    expect(compat).toContain("operationalAnnouncement");
    expect(compat).toContain("No product action was performed");
    expect(compat).not.toContain("MutationObserver");
    expect(compat).not.toContain("primaryAction");
  });

  test("provides deterministic local empty, loading, degraded, and error states", () => {
    for (const scenario of ["default", "empty", "loading", "degraded", "error"]) {
      expect(html).toContain(`<option value="${scenario}">`);
      expect(app).toContain(`"${scenario}"`);
    }
    expect(app).toContain('new URLSearchParams(location.search).get("scenario")');
    expect(app).toContain("history.replaceState");
    expect(app).toContain("This deterministic preview performs no network request.");
    expect(app).toContain("Retry local preview");
    expect(css).toContain('body[data-scenario="degraded"]');
  });

  test("keeps URL updates and drawer focus recoverable inside opaque sandbox frames", () => {
    const runtime = loadCompatibility();
    expect(() => runtime.history.replaceState("security")).not.toThrow();
    expect(() => runtime.history.replaceState("unexpected")).toThrow("unexpected history failure");
    expect(runtime.listenerOptions).toEqual({ capture: true });

    const oldButton = runtime.createElement("workers");
    runtime.setButtons([oldButton]);
    runtime.click({ detail: 0, target: oldButton });
    expect(runtime.animationFrames).toHaveLength(1);

    const replacementButton = runtime.createElement("workers");
    runtime.setButtons([replacementButton]);
    runtime.animationFrames.shift()?.();
    expect(replacementButton.focused).toBe(true);

    replacementButton.focused = false;
    runtime.click({ detail: 1, target: replacementButton });
    expect(runtime.animationFrames).toHaveLength(0);
    expect(replacementButton.focused).toBe(false);
  });

  test("projects one connection truth and separates operational actions from acknowledgements", () => {
    const { policy } = loadCompatibility();
    const fixtureConnections = frontendLabFixture.connections as readonly ConnectionRecord[];
    const degraded = policy.projectConnections(fixtureConnections, "degraded");
    expect(degraded[0]).toMatchObject({
      id: "github",
      state: "degraded",
      detail: "Fictional degraded preview: issue reads current, review threads delayed.",
    });
    expect(degraded[1]).toEqual(fixtureConnections[1]);
    expect(policy.projectConnections(fixtureConnections, "default")).toEqual(fixtureConnections);
    expect(policy.operationalAnnouncement("Review wording", "Read the exact fixture next action.")).toBe(
      "Fixture-only preview: Review wording. Read the exact fixture next action. No product action was performed.",
    );
    expect(policy.operationalAnnouncement("Reconcile", "Inspect settlement first.", true)).toBe(
      "Safe recovery preview: Reconcile. Inspect settlement first. No product action was performed.",
    );
  });

  test("preserves keyboard, focus, narrow-screen, evening, and reduced-motion behavior", () => {
    expect(app).toContain("if (commandDialog.open)");
    expect(app).toContain("dialogReturnFocus");
    expect(app).toContain('event.key === "ArrowDown"');
    expect(app).toContain('event.key === "ArrowUp"');
    expect(app).toContain('event.key === "Home"');
    expect(app).toContain('event.key === "End"');
    expect(app).toContain("event.stopPropagation()");
    expect(app).toContain('setAttribute("aria-current"');
    expect(compat).toContain('event.detail !== 0');
    expect(compat).toContain('requestAnimationFrame');
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (max-width: 780px)");
    expect(css).toContain("@media (max-width: 500px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important");
  });

  test("uses original local CSS artwork and obeys privacy and no-gradient boundaries", () => {
    expect(html).toContain("Mallow · original paper-moth companion");
    expect(rationale).toContain("drawn entirely with repository-authored HTML and CSS primitives");
    expect(rationale).toContain("No third-party artwork");
    for (const source of [html, css, compat, app]) {
      expect(source).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
      expect(source).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|sendBeacon\s*\(/);
      expect(source).not.toMatch(/stn\.tok_/i);
      expect(source).not.toMatch(/https?:\/\//i);
    }
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(css).not.toContain("url(");
  });
});

function loadCompatibility() {
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
    dataset: { mode?: string };
    focused = false;
    closestResult: FakeElement | null;
    constructor(mode?: string, closestResult?: FakeElement | null) {
      this.dataset = { mode };
      this.closestResult = closestResult === undefined ? this : closestResult;
    }
    closest(selector: string) {
      return selector === "button[data-mode]" ? this.closestResult : null;
    }
    focus() {
      this.focused = true;
    }
  }

  type ClickEvent = { detail: number; target: FakeElement };
  let buttons: FakeElement[] = [];
  let clickListener: ((event: ClickEvent) => void) | null = null;
  let listenerOptions: { capture?: boolean } | undefined;
  const animationFrames: Array<() => void> = [];
  const modeList = {
    addEventListener(type: string, listener: typeof clickListener, options: { capture?: boolean }) {
      if (type === "click") {
        clickListener = listener;
        listenerOptions = options;
      }
    },
    contains(node: FakeElement) {
      return buttons.includes(node);
    },
    querySelectorAll(selector: string) {
      return selector === "button[data-mode]" ? buttons : [];
    },
  };

  const context: Record<string, unknown> = {
    History: FakeHistory,
    DOMException: FakeDomException,
    Element: FakeElement,
    Reflect,
    document: { querySelector: (selector: string) => selector === "#mode-list" ? modeList : null },
    requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
    Object,
    Error,
    TypeError,
  };
  runInNewContext(compat, context);
  const policy = context.StensiblySoftCompanionPolicy as SoftCompanionPolicy | undefined;
  if (!policy) throw new Error("Soft Companion policy was not installed");

  return {
    policy,
    history: new FakeHistory() as { replaceState(kind: string): unknown },
    animationFrames,
    get listenerOptions() {
      return listenerOptions;
    },
    createElement(mode?: string, closestResult?: FakeElement | null) {
      return new FakeElement(mode, closestResult);
    },
    setButtons(nextButtons: FakeElement[]) {
      buttons = nextButtons;
    },
    click(event: ClickEvent) {
      const listener = clickListener as ((event: ClickEvent) => void) | null;
      if (!listener) throw new Error("Soft Companion compatibility listener was not registered");
      listener(event);
    },
  };
}
