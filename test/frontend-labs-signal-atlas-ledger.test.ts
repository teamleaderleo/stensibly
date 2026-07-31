import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabManifest } from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "signal-atlas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const ledgerModal = readFileSync(join(routeRoot, "ledger-modal.js"), "utf8");

describe("Signal Atlas ledger modal boundary", () => {
  test("loads before app and binds the manifest to the contained implementation", () => {
    const variant = frontendLabManifest.find((entry) => entry.id === "signal-atlas");
    expect(variant?.revision).toBe("2e10f2fc9ba04f532d794d0b5ea76168a6b43ae1");
    expect(html.indexOf('<script src="./ledger-modal.js"></script>')).toBeGreaterThan(0);
    expect(html.indexOf('<script src="./ledger-modal.js"></script>')).toBeLessThan(html.indexOf('<script src="./app.js"></script>'));
    expect(ledgerModal).toContain('ledger.setAttribute("role", "dialog")');
    expect(ledgerModal).toContain('ledger.setAttribute("aria-modal", "true")');
    expect(ledgerModal).toContain("isUsefulReturnTarget");
  });

  test("contains the background and restores a useful visible focus target", () => {
    const hiddenValues = new WeakMap<object, boolean>();
    const queued: Array<() => void> = [];
    let activeElement: FakeHTMLElement;

    class FakeHTMLElement {
      inert = false;
      isConnected = true;
      attributes = new Map<string, string>();
      descendants = new Set<FakeHTMLElement>();
      focused = false;
      tagName: string;
      tabIndex: number;

      constructor(tagName = "DIV", tabIndex = -1) {
        this.tagName = tagName;
        this.tabIndex = tabIndex;
        activeElement ??= this;
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }

      hasAttribute(name: string) {
        return this.attributes.has(name);
      }

      contains(value: FakeHTMLElement) {
        return this.descendants.has(value);
      }

      focus() {
        this.focused = true;
        activeElement = this;
      }
    }

    Object.defineProperty(FakeHTMLElement.prototype, "hidden", {
      configurable: true,
      enumerable: true,
      get() {
        return hiddenValues.get(this) ?? false;
      },
      set(value: boolean) {
        hiddenValues.set(this, Boolean(value));
      },
    });

    const body = new FakeHTMLElement("BODY", -1);
    const ledger = new FakeHTMLElement("SECTION", -1) as FakeHTMLElement & { hidden: boolean };
    const masthead = new FakeHTMLElement("HEADER", -1);
    const atlas = new FakeHTMLElement("MAIN", -1);
    const showLedger = new FakeHTMLElement("BUTTON", 0);
    const closeLedger = new FakeHTMLElement("BUTTON", 0);
    const chapterButton = new FakeHTMLElement("BUTTON", 0);
    const evidence = new FakeHTMLElement("DIV", 0);
    ledger.descendants.add(closeLedger);
    ledger.hidden = true;
    activeElement = body;

    const document = {
      body,
      get activeElement() {
        return activeElement;
      },
      querySelector(selector: string) {
        if (selector === "#ledger") return ledger;
        if (selector === ".masthead") return masthead;
        if (selector === ".atlas") return atlas;
        if (selector === "#show-ledger") return showLedger;
        return null;
      },
    };

    runInNewContext(ledgerModal, {
      HTMLElement: FakeHTMLElement,
      Reflect,
      document,
      queueMicrotask: (callback: () => void) => queued.push(callback),
      Error,
      Boolean,
      Object,
    });

    expect(ledger.attributes.get("role")).toBe("dialog");
    expect(ledger.attributes.get("aria-modal")).toBe("true");
    expect(queued).toHaveLength(0);

    activeElement = body;
    ledger.hidden = false;
    expect(masthead.inert).toBe(true);
    expect(atlas.inert).toBe(true);
    closeLedger.focus();
    ledger.hidden = true;
    body.focus();
    queued.shift()?.();
    expect(activeElement).toBe(showLedger);

    activeElement = chapterButton;
    ledger.hidden = false;
    closeLedger.focus();
    ledger.hidden = true;
    queued.shift()?.();
    expect(activeElement).toBe(chapterButton);

    activeElement = showLedger;
    ledger.hidden = false;
    closeLedger.focus();
    ledger.hidden = true;
    evidence.focus();
    queued.shift()?.();
    expect(activeElement).toBe(evidence);
    expect(masthead.inert).toBe(false);
    expect(atlas.inert).toBe(false);
  });

  test("stays local, flat, and free of authority-bearing effects", () => {
    expect(() => new Function(ledgerModal)).not.toThrow();
    expect(ledgerModal).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(ledgerModal).not.toMatch(/https?:\/\//);
    expect(ledgerModal).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(ledgerModal).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
  });
});
