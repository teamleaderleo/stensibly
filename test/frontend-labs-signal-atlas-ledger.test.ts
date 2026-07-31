import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture } from "../site/labs/fixtures.js";
import { frontendLabManifest } from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "signal-atlas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const ledgerModal = readFileSync(join(routeRoot, "ledger-modal.js"), "utf8");

type ProjectedRecord = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  state: string;
  nextAction: string;
};

type SignalAtlasPolicy = {
  projectRecords(fixture: unknown, metadata: readonly Record<string, unknown>[]): readonly ProjectedRecord[];
  chapterIndex(chapters: readonly { id: string; active: readonly string[] }[], chapterId: string, recordId: string): number;
  returnFocusTarget(candidate: FakeHTMLElement, fallback: FakeHTMLElement, ledger: FakeHTMLElement, body: FakeHTMLElement): FakeHTMLElement;
};

describe("Signal Atlas ledger and fixture policy", () => {
  test("loads shared fixtures and policy before app while preserving the reviewed manifest revision", () => {
    const variant = frontendLabManifest.find((entry) => entry.id === "signal-atlas");
    expect(variant?.revision).toBe("a4296f97402c76b02ed797177efc398814244e76");
    const fixtureIndex = html.indexOf('<script src="../fixtures.classic.js"></script>');
    const policyIndex = html.indexOf('<script src="./ledger-modal.js"></script>');
    const appIndex = html.indexOf('<script src="./app.js"></script>');
    expect(fixtureIndex).toBeGreaterThan(0);
    expect(fixtureIndex).toBeLessThan(policyIndex);
    expect(policyIndex).toBeLessThan(appIndex);
    expect(ledgerModal).toContain('ledger.setAttribute("role", "dialog")');
    expect(ledgerModal).toContain('ledger.setAttribute("aria-modal", "true")');
  });

  test("projects exact shared identities, state, presentation text, and operation actions", () => {
    const { policy } = executePolicy();
    const records = policy.projectRecords(frontendLabFixture, [
      metadata(frontendLabFixture.decision.id, "decision"),
      metadata(frontendLabFixture.workers[1]!.id, "worker"),
      metadata(frontendLabFixture.operations[0]!.id, "operation"),
      metadata(frontendLabFixture.connections[1]!.id, "connection"),
    ]);

    expect(records.find((entry) => entry.id === frontendLabFixture.decision.id)).toMatchObject({
      kind: "decision",
      state: "attention",
      title: frontendLabFixture.decision.title,
      summary: frontendLabFixture.decision.detail,
    });
    expect(records.find((entry) => entry.id === frontendLabFixture.workers[1]!.id)).toMatchObject({
      state: frontendLabFixture.workers[1]!.state,
      title: frontendLabFixture.workers[1]!.label,
      summary: frontendLabFixture.workers[1]!.detail,
    });
    expect(records.find((entry) => entry.id === frontendLabFixture.operations[0]!.id)?.nextAction)
      .toBe(frontendLabFixture.operations[0]!.action);
    expect(records.find((entry) => entry.id === frontendLabFixture.connections[1]!.id)).toMatchObject({
      state: frontendLabFixture.connections[1]!.state,
      title: frontendLabFixture.connections[1]!.label,
      summary: frontendLabFixture.connections[1]!.detail,
    });

    expect(() => policy.projectRecords(frontendLabFixture, [
      metadata(frontendLabFixture.decision.id, "worker"),
    ])).toThrow("must match a shared fixture identity and kind");
    expect(() => policy.projectRecords(frontendLabFixture, [
      metadata(frontendLabFixture.decision.id, "decision"),
      metadata(frontendLabFixture.decision.id, "decision"),
    ])).toThrow("must be unique");
  });

  test("uses explicit validated chapter destinations for ambiguous operation and provider events", () => {
    const { policy } = executePolicy();
    const chapters = [
      { id: "decision", active: ["approve-release-note", "deploy-amber"] },
      { id: "ambiguity", active: ["deploy-amber", "api"] },
      { id: "connections", active: ["github", "api", "mcp", "deploy-amber"] },
    ];
    expect(policy.chapterIndex(chapters, "ambiguity", "deploy-amber")).toBe(1);
    expect(policy.chapterIndex(chapters, "connections", "api")).toBe(2);
    expect(() => policy.chapterIndex(chapters, "decision", "api")).toThrow("is invalid");
    expect(() => policy.chapterIndex(chapters, "missing", "api")).toThrow("is invalid");
  });

  test("admits only a connected focusable return target outside the ledger", () => {
    const { policy, ledger, body } = executePolicy();
    const fallback = new FakeHTMLElement({ focusable: true });
    const usefulButton = new FakeHTMLElement({ focusable: true });
    const disconnected = new FakeHTMLElement({ focusable: true, isConnected: false });
    const insideLedger = new FakeHTMLElement({ focusable: true, insideLedger: true });
    const plainElement = new FakeHTMLElement({ focusable: false });

    expect(policy.returnFocusTarget(body, fallback, ledger, body)).toBe(fallback);
    expect(policy.returnFocusTarget(disconnected, fallback, ledger, body)).toBe(fallback);
    expect(policy.returnFocusTarget(insideLedger, fallback, ledger, body)).toBe(fallback);
    expect(policy.returnFocusTarget(plainElement, fallback, ledger, body)).toBe(fallback);
    expect(policy.returnFocusTarget(usefulButton, fallback, ledger, body)).toBe(usefulButton);
  });

  test("makes the background inert synchronously and releases it before return focus", () => {
    const { ledger, masthead, atlas } = executePolicy();
    expect(ledger.attributes.get("role")).toBe("dialog");
    expect(ledger.attributes.get("aria-modal")).toBe("true");
    expect(ledger.hidden).toBe(true);
    expect(masthead.inert).toBe(false);
    expect(atlas.inert).toBe(false);

    ledger.hidden = false;
    expect(masthead.inert).toBe(true);
    expect(atlas.inert).toBe(true);

    ledger.hidden = true;
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

const hiddenValues = new WeakMap<object, boolean>();

class FakeHTMLElement {
  declare hidden: boolean;
  inert = false;
  isConnected: boolean;
  focused = false;
  focusable: boolean;
  insideLedger: boolean;
  attributes = new Map<string, string>();

  constructor(options: { focusable?: boolean; isConnected?: boolean; insideLedger?: boolean } = {}) {
    this.focusable = options.focusable ?? false;
    this.isConnected = options.isConnected ?? true;
    this.insideLedger = options.insideLedger ?? false;
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  contains(candidate: FakeHTMLElement) { return candidate.insideLedger; }
  matches() { return this.focusable; }
  focus() { this.focused = true; }
}

Object.defineProperty(FakeHTMLElement.prototype, "hidden", {
  configurable: true,
  enumerable: true,
  get() { return hiddenValues.get(this) ?? false; },
  set(value: boolean) { hiddenValues.set(this, Boolean(value)); },
});

function executePolicy() {
  const ledger = new FakeHTMLElement();
  const masthead = new FakeHTMLElement();
  const atlas = new FakeHTMLElement();
  const body = new FakeHTMLElement();
  ledger.hidden = true;
  const runtime: Record<string, unknown> & { StensiblySignalAtlasPolicy?: SignalAtlasPolicy } = {
    HTMLElement: FakeHTMLElement,
    Reflect,
    document: {
      body,
      querySelector(selector: string) {
        if (selector === "#ledger") return ledger;
        if (selector === ".masthead") return masthead;
        if (selector === ".atlas") return atlas;
        return null;
      },
    },
    Error,
    TypeError,
    Boolean,
    Object,
    Array,
    Map,
    Set,
  };
  runInNewContext(ledgerModal, runtime);
  const policy = runtime.StensiblySignalAtlasPolicy;
  if (!policy) throw new Error("Signal Atlas policy was not published");
  return { policy, ledger, masthead, atlas, body };
}

function metadata(id: string, kind: string) {
  return { id, kind, owner: "fixture", time: "now", evidence: "fake", nextAction: "Read next action", position: [1, 2] };
}
