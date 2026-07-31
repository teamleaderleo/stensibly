import { describe, expect, test } from "bun:test";
import {
  FRONTEND_LABS_ENTRY,
  installFrontendLabsEntry,
} from "../site/frontend-labs-entry.js";

class FakeElement {
  id = "";
  className = "";
  href = "";
  textContent = "";
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  insertedPosition: string | null = null;
  insertedElement: FakeElement | null = null;

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  insertAdjacentElement(position: string, element: FakeElement) {
    this.insertedPosition = position;
    this.insertedElement = element;
    return element;
  }
}

class FakeDocument {
  readonly topbar = new FakeElement();
  readonly sourceLink = new FakeElement();
  readonly created: FakeElement[] = [];
  sourceAvailable = true;

  querySelector(selector: string) {
    if (selector === ".topbar") return this.topbar;
    if (selector === ".topbar > .github") {
      return this.sourceAvailable ? this.sourceLink : null;
    }
    return null;
  }

  getElementById(id: string) {
    return this.created.find((element) => element.id === id) ?? null;
  }

  createElement() {
    const element = new FakeElement();
    this.created.push(element);
    return element;
  }
}

describe("production frontend Labs entry", () => {
  test("adds one compact same-origin link before source navigation", () => {
    const documentRef = new FakeDocument();
    const installed = installFrontendLabsEntry(documentRef as unknown as Document);

    expect(installed).toBe(true);
    expect(documentRef.sourceLink.insertedPosition).toBe("beforebegin");
    const link = documentRef.sourceLink.insertedElement;
    expect(link?.id).toBe("frontend-labs-entry");
    expect(link?.className).toBe("github frontend-labs-link");
    expect(link?.href).toBe("/labs/");
    expect(link?.textContent).toBe("interface previews");
    expect(link?.attributes.get("aria-label")).toContain("fixture-backed");
    expect(documentRef.topbar.children).toHaveLength(0);
  });

  test("is idempotent, immutable, and needs no runtime stylesheet", () => {
    const documentRef = new FakeDocument();
    expect(installFrontendLabsEntry(documentRef as unknown as Document)).toBe(true);
    expect(installFrontendLabsEntry(documentRef as unknown as Document)).toBe(false);
    expect(FRONTEND_LABS_ENTRY.href).toBe("/labs/");
    expect(Object.isFrozen(FRONTEND_LABS_ENTRY)).toBe(true);
    expect(JSON.stringify(FRONTEND_LABS_ENTRY)).not.toContain("stylesheet");
  });

  test("falls back to the topbar and fails closed without it", () => {
    const documentRef = new FakeDocument();
    documentRef.sourceAvailable = false;
    expect(installFrontendLabsEntry(documentRef as unknown as Document)).toBe(true);
    expect(documentRef.topbar.children[0]?.href).toBe("/labs/");

    const missingTopbar = new FakeDocument();
    missingTopbar.querySelector = () => null;
    expect(installFrontendLabsEntry(missingTopbar as unknown as Document)).toBe(false);
  });

  test("rejects a missing browser document", () => {
    expect(() => installFrontendLabsEntry(null as unknown as Document))
      .toThrow("A browser document is required");
  });
});
