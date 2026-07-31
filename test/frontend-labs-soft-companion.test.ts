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

describe("Soft Companion frontend lab", () => {
  test("publishes an exact shared-fixture prototype identity", () => {
    expect(variant).toMatchObject({
      owner: "Cinder",
      status: "prototype",
      revision: "3b4fc7d2e2748d7b027089e0a656fe532f860b17",
      issue: 608,
      path: "./soft-companion/",
    });
    expect(variant?.support).toEqual(["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion", "loading", "empty", "degraded", "error"]);
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

  test("keeps ambiguity literal and primary controls honest", () => {
    expect(app).toContain('disposition: operation.state === "ambiguous" ? "Reconcile before retry"');
    expect(app).toContain('row.semanticState === "ambiguous"');
    expect(app).toContain("No retry was performed");
    expect(app).toContain('text("strong", row.semanticState === "ambiguous" ? "Safe next action"');
    expect(compat).toContain("projectConnections");
    expect(compat).toContain("syncConnections");
    expect(compat).toContain("syncPrimaryAction");
    expect(compat).toContain('detailContent.querySelector(".next-note")');
    expect(compat).toContain("No product action was performed");
    expect(compat).toContain("event.stopImmediatePropagation()");
    expect(compat).not.toContain('querySelectorAll(".detail-block")');
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

    let buttons: FakeElement[] = [];
    let clickListener: ((event: { detail: number; target: FakeElement }) => void) | null = null;
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

    runInNewContext(compat, {
      History: FakeHistory,
      DOMException: FakeDomException,
      Element: FakeElement,
      Reflect,
      document: { querySelector: (selector: string) => selector === "#mode-list" ? modeList : null },
      requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
      Error,
      TypeError,
    });

    const history = new FakeHistory() as { replaceState: (kind: string) => unknown };
    expect(() => history.replaceState("security")).not.toThrow();
    expect(() => history.replaceState("unexpected")).toThrow("unexpected history failure");
    expect(listenerOptions).toEqual({ capture: true });
    const registeredClickListener = clickListener as ((event: { detail: number; target: FakeElement }) => void) | null;
    if (!registeredClickListener) throw new Error("Soft Companion compatibility listener was not registered");

    const oldButton = new FakeElement("workers");
    buttons = [oldButton];
    registeredClickListener({ detail: 0, target: oldButton });
    expect(animationFrames).toHaveLength(1);

    const replacementButton = new FakeElement("workers");
    buttons = [replacementButton];
    animationFrames.shift()?.();
    expect(replacementButton.focused).toBe(true);

    replacementButton.focused = false;
    registeredClickListener({ detail: 1, target: replacementButton });
    expect(animationFrames).toHaveLength(0);
    expect(replacementButton.focused).toBe(false);
  });

  test("projects one degraded connection truth and separates operational actions from acknowledgements", () => {
    const serious = executePolicy("serious");
    expect(serious.shelf.children[0]?.textContent).toBe("GitHub · degraded");
    expect(serious.shelf.children[0]?.dataset.state).toBe("degraded");
    expect(serious.shelf.children[0]?.title).toContain("review threads delayed");
    expect(serious.shelf.getAttribute("aria-label")).toContain("GitHub · degraded");
    expect(serious.connectionRows[0]?.children[1]?.textContent).toBe("degraded");
    expect(serious.connectionRows[0]?.children[2]?.textContent).toContain("review threads delayed");
    expect(serious.connectionRows[1]?.children[1]?.textContent).toBe(frontendLabFixture.connections[1]?.state);

    const seriousEvent = new FakeEvent();
    serious.primary.clickListener?.(seriousEvent);
    expect(seriousEvent.prevented).toBe(true);
    expect(seriousEvent.stopped).toBe(true);
    expect(serious.primary.textContent).toBe("Review wording");
    expect(serious.announcer.textContent).toContain("Fixture-only preview: Review wording");
    expect(serious.announcer.textContent).toContain("No product action was performed");

    const ordinary = executePolicy("healthy");
    expect(ordinary.primary.textContent).toBe("Acknowledge in preview");
    const ordinaryEvent = new FakeEvent();
    ordinary.primary.clickListener?.(ordinaryEvent);
    expect(ordinaryEvent.prevented).toBe(false);
    expect(ordinaryEvent.stopped).toBe(false);

    ordinary.primary.textContent = "Undo preview acknowledgement";
    (ordinary.observerCallback as (() => void) | null)?.();
    expect(ordinary.primary.textContent).toBe("Undo preview acknowledgement");
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

class PolicyElement {
  children: PolicyElement[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  title = "";
  disabled = false;
  attributes = new Map<string, string>();
  closestResult: PolicyElement | null = null;
  headingResult: PolicyElement[] = [];
  rowResult: PolicyElement[] = [];
  stateResult: PolicyElement | null = null;
  strongResult: PolicyElement | null = null;
  nextNoteResult: PolicyElement | null = null;
  clickListener: ((event: FakeEvent) => void) | null = null;

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector: string) {
    if (selector === ".state-label[data-tone]") return this.stateResult;
    if (selector === "strong") return this.strongResult;
    if (selector === ".next-note") return this.nextNoteResult;
    return null;
  }
  querySelectorAll(selector: string) {
    if (selector === "h3") return this.headingResult;
    if (selector === "li") return this.rowResult;
    if (selector === "button[data-mode]") return [];
    return [];
  }
  closest(selector: string) {
    if (selector === "section") return this.closestResult;
    if (selector === "button[data-mode]") return null;
    return null;
  }
  contains() {
    return false;
  }
  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    if (type === "click") this.clickListener = listener;
  }
}

class PolicyButton extends PolicyElement {}

class FakeEvent {
  prevented = false;
  stopped = false;
  detail = 1;
  target = new PolicyElement();
  preventDefault() {
    this.prevented = true;
  }
  stopImmediatePropagation() {
    this.stopped = true;
  }
}

function executePolicy(tone: "serious" | "healthy") {
  class FakeDomException extends Error {
    name: string;
    constructor(message: string, name: string) {
      super(message);
      this.name = name;
    }
  }
  class FakeHistory {}
  Object.defineProperty(FakeHistory.prototype, "replaceState", {
    value() {},
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const body = new PolicyElement();
  body.dataset.scenario = "degraded";
  const modeList = new PolicyElement();
  const shelf = new PolicyElement();
  shelf.children = frontendLabFixture.connections.map(() => new PolicyElement());

  const connectionRows = frontendLabFixture.connections.map((connection) => {
    const row = new PolicyElement();
    const label = new PolicyElement();
    label.textContent = connection.label ?? "";
    const value = new PolicyElement();
    value.textContent = connection.state ?? "";
    const detail = new PolicyElement();
    detail.textContent = connection.detail ?? "";
    row.children = [label, value, detail];
    return row;
  });
  const section = new PolicyElement();
  section.rowResult = connectionRows;
  const connectionHeading = new PolicyElement();
  connectionHeading.textContent = "Connection health";
  connectionHeading.closestResult = section;
  const nextHeading = new PolicyElement();
  nextHeading.textContent = tone === "serious" ? "Next action" : "Next action";
  const nextNote = new PolicyElement();
  nextNote.strongResult = nextHeading;
  nextNote.textContent = "Next action Read the exact fixture next action.";
  const detailContent = new PolicyElement();
  detailContent.headingResult = [connectionHeading];
  detailContent.nextNoteResult = nextNote;

  const state = new PolicyElement();
  state.dataset.tone = tone;
  const detailHeading = new PolicyElement();
  detailHeading.stateResult = state;
  const primary = new PolicyButton();
  primary.textContent = tone === "serious" ? "Review wording" : "Open activity";
  const announcer = new PolicyElement();

  let observerCallback: (() => void) | null = null;
  class FakeMutationObserver {
    constructor(callback: () => void) {
      observerCallback = callback;
    }
    observe() {}
  }

  runInNewContext(compat, {
    StensiblyFrontendLabFixtures: { frontendLabFixture },
    History: FakeHistory,
    DOMException: FakeDomException,
    Element: PolicyElement,
    Reflect,
    document: {
      body,
      querySelector(selector: string) {
        if (selector === "#mode-list") return modeList;
        if (selector === "#connection-shelf") return shelf;
        if (selector === "#detail-content") return detailContent;
        if (selector === "#detail-heading") return detailHeading;
        if (selector === "#primary-action") return primary;
        if (selector === "#announcer") return announcer;
        return null;
      },
    },
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(callback: () => void) {
      callback();
      return 1;
    },
    Object,
    Error,
    TypeError,
  });

  return { shelf, connectionRows, primary, announcer, observerCallback };
}
