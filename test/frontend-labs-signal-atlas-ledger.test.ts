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
    expect(variant?.revision).toBe("a4296f97402c76b02ed797177efc398814244e76");
    expect(html.indexOf('<script src="./ledger-modal.js"></script>')).toBeGreaterThan(0);
    expect(html.indexOf('<script src="./ledger-modal.js"></script>')).toBeLessThan(html.indexOf('<script src="./app.js"></script>'));
    expect(ledgerModal).toContain('ledger.setAttribute("role", "dialog")');
    expect(ledgerModal).toContain('ledger.setAttribute("aria-modal", "true")');
  });

  test("makes the background inert synchronously and releases it before return focus", () => {
    const hiddenValues = new WeakMap<object, boolean>();

    class FakeHTMLElement {
      inert = false;
      attributes = new Map<string, string>();

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
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

    const ledger = new FakeHTMLElement() as FakeHTMLElement & { hidden: boolean };
    const masthead = new FakeHTMLElement();
    const atlas = new FakeHTMLElement();
    ledger.hidden = true;

    runInNewContext(ledgerModal, {
      HTMLElement: FakeHTMLElement,
      Reflect,
      document: {
        querySelector(selector: string) {
          if (selector === "#ledger") return ledger;
          if (selector === ".masthead") return masthead;
          if (selector === ".atlas") return atlas;
          return null;
        },
      },
      Error,
      Boolean,
      Object,
    });

    expect(ledger.attributes.get("role")).toBe("dialog");
    expect(ledger.attributes.get("aria-modal")).toBe("true");
    expect(ledger.hidden).toBe(true);
    expect(masthead.inert).toBe(false);
    expect(atlas.inert).toBe(false);

    ledger.hidden = false;
    expect(ledger.hidden).toBe(false);
    expect(masthead.inert).toBe(true);
    expect(atlas.inert).toBe(true);

    ledger.hidden = true;
    expect(ledger.hidden).toBe(true);
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
