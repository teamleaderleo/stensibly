import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture } from "../site/labs/fixtures.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "soft-companion");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const bridge = readFileSync(join(routeRoot, "interaction-bridge.js"), "utf8");

describe("Soft Companion interaction bridge", () => {
  test("loads after the app and keeps one degraded connection truth", () => {
    expect(html.indexOf('./app.js')).toBeLessThan(html.indexOf('./interaction-bridge.js'));
    const harness = executeBridge("serious");

    expect(harness.shelf.children[0]?.textContent).toBe("GitHub · degraded");
    expect(harness.shelf.children[0]?.dataset.state).toBe("degraded");
    expect(harness.shelf.children[0]?.title).toContain("review threads delayed");
    expect(harness.shelf.getAttribute("aria-label")).toContain("GitHub · degraded");
    expect(harness.connectionRows[0]?.children[1]?.textContent).toBe("degraded");
    expect(harness.connectionRows[0]?.children[2]?.textContent).toContain("review threads delayed");
    expect(harness.connectionRows[1]?.children[1]?.textContent).toBe(frontendLabFixture.connections[1]?.state);
  });

  test("keeps operational controls fixture-only and labels acknowledgements explicitly", () => {
    const serious = executeBridge("serious");
    const seriousEvent = new FakeEvent();
    serious.primary.clickListener?.(seriousEvent);
    expect(seriousEvent.prevented).toBe(true);
    expect(seriousEvent.stopped).toBe(true);
    expect(serious.primary.textContent).toBe("Review wording");
    expect(serious.announcer.textContent).toBe("Review wording: fixture-only preview. No product action occurred.");

    const ordinary = executeBridge("healthy");
    expect(ordinary.primary.textContent).toBe("Acknowledge in preview");
    const ordinaryEvent = new FakeEvent();
    ordinary.primary.clickListener?.(ordinaryEvent);
    expect(ordinaryEvent.prevented).toBe(false);
    expect(ordinaryEvent.stopped).toBe(false);

    ordinary.primary.textContent = "Undo preview acknowledgement";
    ordinary.observerCallback?.();
    expect(ordinary.primary.textContent).toBe("Undo preview acknowledgement");
  });

  test("stays fixture-only, local, and no-gradient", () => {
    expect(() => new Function(bridge)).not.toThrow();
    expect(bridge).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(bridge).not.toMatch(/https?:\/\//);
    expect(bridge).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(bridge).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
  });
});

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  title = "";
  disabled = false;
  attributes = new Map<string, string>();
  closestResult: FakeElement | null = null;
  headingResult: FakeElement[] = [];
  rowResult: FakeElement[] = [];
  stateResult: FakeElement | null = null;
  clickListener: ((event: FakeEvent) => void) | null = null;

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector: string) {
    if (selector === ".state-label[data-tone]") return this.stateResult;
    return null;
  }
  querySelectorAll(selector: string) {
    if (selector === "h3") return this.headingResult;
    if (selector === "li") return this.rowResult;
    return [];
  }
  closest(selector: string) {
    return selector === "section" ? this.closestResult : null;
  }
  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    if (type === "click") this.clickListener = listener;
  }
}

class FakeButton extends FakeElement {}

class FakeEvent {
  prevented = false;
  stopped = false;
  preventDefault() {
    this.prevented = true;
  }
  stopImmediatePropagation() {
    this.stopped = true;
  }
}

function executeBridge(tone: "serious" | "healthy") {
  const body = new FakeElement();
  body.dataset.scenario = "degraded";
  const shelf = new FakeElement();
  shelf.children = frontendLabFixture.connections.map(() => new FakeElement());

  const connectionRows = frontendLabFixture.connections.map((connection) => {
    const row = new FakeElement();
    const label = new FakeElement();
    label.textContent = connection.label;
    const value = new FakeElement();
    value.textContent = connection.state;
    const detail = new FakeElement();
    detail.textContent = connection.detail;
    row.children = [label, value, detail];
    return row;
  });
  const connectionSection = new FakeElement();
  connectionSection.rowResult = connectionRows;
  const connectionHeading = new FakeElement();
  connectionHeading.textContent = "Connection health";
  connectionHeading.closestResult = connectionSection;
  const detailContent = new FakeElement();
  detailContent.headingResult = [connectionHeading];

  const state = new FakeElement();
  state.dataset.tone = tone;
  const detailHeading = new FakeElement();
  detailHeading.stateResult = state;
  const primary = new FakeButton();
  primary.textContent = tone === "serious" ? "Review wording" : "Open activity";
  const announcer = new FakeElement();

  let observerCallback: (() => void) | null = null;
  class FakeMutationObserver {
    constructor(callback: () => void) {
      observerCallback = callback;
    }
    observe() {}
  }

  runInNewContext(bridge, {
    globalThis: {
      StensiblyFrontendLabFixtures: { frontendLabFixture },
    },
    document: {
      body,
      querySelector(selector: string) {
        if (selector === "#connection-shelf") return shelf;
        if (selector === "#detail-content") return detailContent;
        if (selector === "#detail-heading") return detailHeading;
        if (selector === "#primary-action") return primary;
        if (selector === "#announcer") return announcer;
        return null;
      },
    },
    MutationObserver: FakeMutationObserver,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButton,
    requestAnimationFrame(callback: () => void) {
      callback();
      return 1;
    },
    Object,
    Error,
  });

  return { shelf, connectionRows, primary, announcer, observerCallback };
}
