import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "studio-canvas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const bridge = readFileSync(join(routeRoot, "workspace-bridge.js"), "utf8");

describe("Studio Canvas workspace bridge", () => {
  test("gives the command search an explicit accessible name", () => {
    expect(html).toContain('id="command-input" type="search" aria-label="Search artifacts, inspectors, and layout commands"');
    expect(html.indexOf('<script src="./app.js"></script>')).toBeLessThan(html.indexOf('<script src="./workspace-bridge.js"></script>'));
  });

  test("maintains one roving tab and a labeled tabpanel as selection changes", () => {
    class FakeElement {
      id = "";
      tabIndex = 0;
      dataset: { tab?: string };
      attributes = new Map<string, string>();
      strong: FakeElement | null = null;
      tabButtons: FakeElement[] = [];

      constructor(tab?: string) {
        this.dataset = { tab };
      }

      querySelector(selector: string) {
        return selector === "strong" ? this.strong : null;
      }

      querySelectorAll(selector: string) {
        return selector === 'button[role="tab"]' ? this.tabButtons : [];
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }

      getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
      }

      removeAttribute(name: string) {
        this.attributes.delete(name);
      }

      addEventListener() {}
    }

    const heading = new FakeElement();
    const identity = new FakeElement();
    identity.strong = heading;
    const evidence = new FakeElement("evidence");
    evidence.setAttribute("aria-selected", "true");
    const comments = new FakeElement("comments");
    comments.setAttribute("aria-selected", "false");
    const inspectorTabs = new FakeElement();
    inspectorTabs.tabButtons = [evidence, comments];
    const inspectorContent = new FakeElement();
    const observers: Array<{ callback: () => void; target: FakeElement }> = [];

    class FakeMutationObserver {
      constructor(readonly callback: () => void) {}
      observe(target: FakeElement) {
        observers.push({ callback: this.callback, target });
      }
    }

    runInNewContext(bridge, {
      document: {
        querySelector(selector: string) {
          if (selector === "#canvas-identity") return identity;
          if (selector === "#inspector-tabs") return inspectorTabs;
          if (selector === "#inspector-content") return inspectorContent;
          return null;
        },
        querySelectorAll() {
          return [];
        },
      },
      MutationObserver: FakeMutationObserver,
      Element: FakeElement,
      requestAnimationFrame: () => 0,
      Error,
    });

    expect(heading.id).toBe("canvas-region-title");
    expect(evidence.id).toBe("studio-canvas-tab-evidence");
    expect(comments.id).toBe("studio-canvas-tab-comments");
    expect(evidence.getAttribute("aria-controls")).toBe("inspector-content");
    expect(comments.getAttribute("aria-controls")).toBe("inspector-content");
    expect(evidence.tabIndex).toBe(0);
    expect(comments.tabIndex).toBe(-1);
    expect(inspectorContent.getAttribute("role")).toBe("tabpanel");
    expect(inspectorContent.tabIndex).toBe(0);
    expect(inspectorContent.getAttribute("aria-labelledby")).toBe("studio-canvas-tab-evidence");

    evidence.setAttribute("aria-selected", "false");
    comments.setAttribute("aria-selected", "true");
    observers.find((observer) => observer.target === inspectorTabs)?.callback();

    expect(evidence.tabIndex).toBe(-1);
    expect(comments.tabIndex).toBe(0);
    expect(inspectorContent.getAttribute("aria-labelledby")).toBe("studio-canvas-tab-comments");
  });

  test("moves native tab keys to the replacement tab after the app rerenders", () => {
    class FakeElement {
      id = "";
      tabIndex = 0;
      dataset: { tab?: string };
      attributes = new Map<string, string>();
      strong: FakeElement | null = null;
      tabButtons: FakeElement[] = [];
      listeners = new Map<string, (event: FakeKeyboardEvent) => void>();
      onClick: (() => void) | null = null;
      clicked = 0;
      focused = false;

      constructor(tab?: string) {
        this.dataset = { tab };
      }

      querySelector(selector: string) {
        return selector === "strong" ? this.strong : null;
      }

      querySelectorAll(selector: string) {
        return selector === 'button[role="tab"]' ? this.tabButtons : [];
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }

      getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
      }

      removeAttribute(name: string) {
        this.attributes.delete(name);
      }

      addEventListener(type: string, listener: (event: FakeKeyboardEvent) => void) {
        this.listeners.set(type, listener);
      }

      contains(node: FakeElement) {
        return this.tabButtons.includes(node);
      }

      closest(selector: string) {
        return selector === 'button[role="tab"]' && this.dataset.tab ? this : null;
      }

      click() {
        this.clicked += 1;
        this.onClick?.();
      }

      focus() {
        this.focused = true;
      }
    }

    class FakeKeyboardEvent {
      prevented = false;
      stopped = false;
      constructor(readonly key: string, readonly target: FakeElement) {}
      preventDefault() {
        this.prevented = true;
      }
      stopPropagation() {
        this.stopped = true;
      }
    }

    const identity = new FakeElement();
    identity.strong = new FakeElement();
    const inspectorTabs = new FakeElement();
    const inspectorContent = new FakeElement();
    const observers: Array<{ callback: () => void; target: FakeElement }> = [];
    const animationFrames: Array<() => void> = [];

    class FakeMutationObserver {
      constructor(readonly callback: () => void) {}
      observe(target: FakeElement) {
        observers.push({ callback: this.callback, target });
      }
    }

    const installTabs = (selectedTab: string): FakeElement[] => {
      const buttons = [new FakeElement("evidence"), new FakeElement("comments")];
      for (const button of buttons) {
        button.setAttribute("aria-selected", button.dataset.tab === selectedTab ? "true" : "false");
        button.onClick = () => {
          installTabs(button.dataset.tab!);
          observers.find((observer) => observer.target === inspectorTabs)?.callback();
        };
      }
      inspectorTabs.tabButtons = buttons;
      return buttons;
    };

    installTabs("evidence");
    runInNewContext(bridge, {
      document: {
        querySelector(selector: string) {
          if (selector === "#canvas-identity") return identity;
          if (selector === "#inspector-tabs") return inspectorTabs;
          if (selector === "#inspector-content") return inspectorContent;
          return null;
        },
        querySelectorAll() {
          return [];
        },
      },
      MutationObserver: FakeMutationObserver,
      Element: FakeElement,
      requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
      Error,
    });

    const keydown = inspectorTabs.listeners.get("keydown");
    expect(keydown).toBeDefined();

    for (const [key, sourceTab, expectedTab] of [
      ["ArrowRight", "evidence", "comments"],
      ["ArrowLeft", "evidence", "comments"],
      ["Home", "comments", "evidence"],
      ["End", "evidence", "comments"],
    ] as const) {
      const originalButtons = installTabs(sourceTab);
      const source = originalButtons.find((button) => button.dataset.tab === sourceTab)!;
      const oldTarget = originalButtons.find((button) => button.dataset.tab === expectedTab)!;
      const event = new FakeKeyboardEvent(key, source);

      keydown?.(event);

      expect(event.prevented, key).toBe(true);
      expect(event.stopped, key).toBe(true);
      expect(oldTarget.clicked, key).toBe(1);
      expect(oldTarget.focused, key).toBe(false);
      expect(animationFrames, key).toHaveLength(1);

      animationFrames.shift()?.();
      const replacement = inspectorTabs.tabButtons.find((button) => button.dataset.tab === expectedTab)!;
      expect(replacement, key).not.toBe(oldTarget);
      expect(replacement.focused, key).toBe(true);
    }

    const current = installTabs("evidence")[0]!;
    const ignored = new FakeKeyboardEvent("PageDown", current);
    keydown?.(ignored);
    expect(ignored.prevented).toBe(false);
    expect(ignored.stopped).toBe(false);
    expect(animationFrames).toHaveLength(0);
  });

  test("stays fixture-only and authority-free", () => {
    expect(() => new Function(bridge)).not.toThrow();
    expect(bridge).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(bridge).not.toMatch(/https?:\/\//);
    expect(bridge).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(bridge).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
  });
});
