import { describe, expect, test } from "bun:test";
import {
  FRONTEND_LABS_ENTRY,
  installFrontendLabsEntry,
} from "../site/frontend-labs-entry.js";

class FakeElement {
  id = "";
  className = "";
  rel = "";
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
  readonly head = new FakeElement();
  readonly shell = new FakeElement();
  readonly topbar = new FakeElement();
  readonly created: FakeElement[] = [];

  querySelector(selector: string) {
    if (selector === ".shell") return this.shell;
    if (selector === ".topbar") return this.topbar;
    return null;
  }

  getElementById(id: string) {
    return [...this.created, ...this.head.children].find((element) => element.id === id) ?? null;
  }

  createElement() {
    const element = new FakeElement();
    this.created.push(element);
    return element;
  }
}

function descendants(element: FakeElement): FakeElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("production frontend Labs entry", () => {
  test("publishes one honest same-origin entry after the root topbar", () => {
    const documentRef = new FakeDocument();
    const installed = installFrontendLabsEntry(documentRef as unknown as Document);

    expect(installed).toBe(true);
    expect(documentRef.topbar.insertedPosition).toBe("afterend");
    const section = documentRef.topbar.insertedElement;
    expect(section?.id).toBe("frontend-labs-entry");
    expect(section?.className).toBe("frontend-labs-entry");
    expect(section?.attributes.get("aria-labelledby")).toBe("frontend-labs-entry-title");

    const stylesheet = documentRef.head.children[0];
    expect(stylesheet?.id).toBe("frontend-labs-entry-styles");
    expect(stylesheet?.rel).toBe("stylesheet");
    expect(stylesheet?.href).toBe("/frontend-labs-entry.css");

    if (!section) throw new Error("The frontend Labs entry was not inserted.");
    const nodes = descendants(section);
    const action = nodes.find((node) => node.className === "frontend-labs-entry-action");
    const description = nodes.find((node) => node.id === "frontend-labs-entry-description");
    expect(action?.href).toBe("/labs/");
    expect(action?.textContent).toBe("Open interface previews");
    expect(action?.attributes.get("aria-describedby")).toBe("frontend-labs-entry-description");
    expect(description?.textContent).toContain("fixture-backed");
    expect(description?.textContent).toContain("fictional data");
    expect(description?.textContent).toContain("do not replace this authenticated dashboard yet");
  });

  test("is idempotent and keeps its public contract immutable", () => {
    const documentRef = new FakeDocument();
    expect(installFrontendLabsEntry(documentRef as unknown as Document)).toBe(true);
    expect(installFrontendLabsEntry(documentRef as unknown as Document)).toBe(false);
    expect(FRONTEND_LABS_ENTRY.href).toBe("/labs/");
    expect(Object.isFrozen(FRONTEND_LABS_ENTRY)).toBe(true);
  });

  test("fails closed without a browser document and stays absent without the root shell", () => {
    expect(() => installFrontendLabsEntry(null as unknown as Document))
      .toThrow("A browser document is required");

    const documentRef = new FakeDocument();
    documentRef.querySelector = () => null;
    expect(installFrontendLabsEntry(documentRef as unknown as Document)).toBe(false);
    expect(documentRef.head.children).toHaveLength(0);
  });
});
