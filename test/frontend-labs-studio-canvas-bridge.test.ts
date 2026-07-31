import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture } from "../site/labs/fixtures.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "studio-canvas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const runtimeBoundary = readFileSync(join(routeRoot, "runtime-boundary.js"), "utf8");
const bridge = readFileSync(join(routeRoot, "workspace-bridge.js"), "utf8");

type BaseArtifact = {
  id: string;
  title: string;
  summary: string;
  source: string;
  revision: string;
  nextAction: string;
  sections: string[][];
  evidence: string[];
  comments: string[];
  versions: unknown[];
  activity: string[];
};

type StudioPolicy = {
  projectArtifacts(base: BaseArtifact[], fixture: typeof frontendLabFixture): readonly BaseArtifact[];
  commandKinds(narrow: boolean): readonly string[];
  localActionCopy(entry: BaseArtifact, action: string): string;
  usefulReturnTarget(value: unknown, body: unknown, dialog: { contains(value: unknown): boolean }): boolean;
};

describe("Studio Canvas workspace bridge", () => {
  test("loads the shared fixture and explicit app boundary before the bridge", () => {
    const fixturesPosition = html.indexOf('../fixtures.classic.js');
    const appPosition = html.indexOf('./app.js');
    const boundaryPosition = html.indexOf('./runtime-boundary.js');
    const bridgePosition = html.indexOf('./workspace-bridge.js');
    expect(fixturesPosition).toBeGreaterThan(-1);
    expect(fixturesPosition).toBeLessThan(appPosition);
    expect(appPosition).toBeLessThan(boundaryPosition);
    expect(boundaryPosition).toBeLessThan(bridgePosition);
    expect(html).toContain('id="local-action-result" role="status" tabindex="-1" hidden');

    const required = () => "required node";
    const context: Record<string, unknown> & { requiredNode?: typeof required } = { required, Object, Error };
    runInNewContext(runtimeBoundary, context);
    expect(context.requiredNode).toBe(required);
    expect(Object.getOwnPropertyDescriptor(context, "requiredNode")).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false,
    });
  });

  test("projects exact shared task truth into five frozen artifacts", () => {
    const policy = executePolicy();
    const projected = policy.projectArtifacts(baseArtifacts(), frontendLabFixture);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected).toHaveLength(5);

    expect(projected[0]).toMatchObject({
      id: "approve-release-note",
      title: frontendLabFixture.decision.title,
      summary: frontendLabFixture.decision.detail,
      source: "Shared decision approve-release-note",
    });
    expect(projected[0]?.evidence).toContain("approve-release-note");

    expect(projected[1]?.summary).toContain(requiredText(frontendLabFixture.workers[0]?.label, "Moss label"));
    expect(projected[1]?.summary).toContain(requiredText(frontendLabFixture.workers[1]?.detail, "Ember detail"));
    expect(projected[1]?.evidence).toEqual(["moss", "ember"]);

    expect(projected[2]).toMatchObject({
      id: "repair-focus-order",
      summary: requiredText(frontendLabFixture.readyWork[0]?.reason, "ready-work reason"),
    });

    const operationAction = requiredText(frontendLabFixture.operations[0]?.action, "deploy-amber action");
    expect(projected[3]).toMatchObject({
      id: "deploy-amber",
      title: requiredText(frontendLabFixture.operations[0]?.title, "deploy-amber title"),
      summary: requiredText(frontendLabFixture.operations[0]?.detail, "deploy-amber detail"),
      nextAction: operationAction,
    });

    expect(projected[4]?.summary).toContain("GitHub healthy");
    expect(projected[4]?.summary).toContain("API reconnecting");
    expect(projected[4]?.summary).toContain("MCP offline");
  });

  test("rejects malformed artifact identity metadata", () => {
    const policy = executePolicy();
    const complete = baseArtifacts();
    expect(() => policy.projectArtifacts(complete.slice(1), frontendLabFixture))
      .toThrow("must match the exact shared task order");
    expect(() => policy.projectArtifacts([...complete, complete[0]!], frontendLabFixture))
      .toThrow("must be unique");
    expect(() => policy.projectArtifacts([complete[1]!, complete[0]!, ...complete.slice(2)], frontendLabFixture))
      .toThrow("must match the exact shared task order");
  });

  test("keeps local explanations visible and action effects literal", () => {
    const policy = executePolicy();
    const entry = policy.projectArtifacts(baseArtifacts(), frontendLabFixture)[3]!;
    expect(policy.localActionCopy(entry, "source")).toContain("Source summary:");
    expect(policy.localActionCopy(entry, "source")).toContain("Fictional local fixture only");
    expect(policy.localActionCopy(entry, "next")).toContain(entry.nextAction);
    expect(policy.localActionCopy(entry, "next")).toContain("No save, approval, submission, or write occurred");
    expect(bridge).toContain("localResult.hidden = false");
    expect(bridge).toContain("localResult.focus({ preventScroll: true })");
    expect(bridge).toContain("hideLocalResult()");
  });

  test("admits the narrow and command-focus contracts", () => {
    const policy = executePolicy();
    expect(policy.commandKinds(true)).toEqual(["artifact", "inspector", "compare"]);
    expect(policy.commandKinds(false)).toEqual([
      "artifact",
      "inspector",
      "compare",
      "collapse-work",
      "collapse-inspector",
    ]);

    const body = fakeTarget("BODY", -1);
    const dialogChild = fakeTarget("BUTTON", 0);
    const dialog = { contains: (value: unknown) => value === dialogChild };
    expect(policy.usefulReturnTarget(body, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget(dialogChild, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget({ ...fakeTarget("BUTTON", 0), isConnected: false }, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget({ ...fakeTarget("BUTTON", 0), hasAttribute: () => true }, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget(fakeTarget("BUTTON", 0), body, dialog)).toBe(true);
    expect(policy.usefulReturnTarget(fakeTarget("DIV", -1), body, dialog)).toBe(false);

    expect(bridge).toContain('matchMedia("(max-width: 48rem)")');
    expect(bridge).toContain('body.dataset.workCollapsed = "false"');
    expect(bridge).toContain('body.dataset.inspectorCollapsed = "false"');
    expect(bridge).toContain("commandReturnFocus = isUsefulReturnTarget(document.activeElement)");
    expect(bridge).toContain("commandReturnFocus = null");
    expect(bridge).toContain("run: () => selectArtifact(index, true)");
    expect(bridge).toContain("run: () => selectTab(index, true)");
  });

  test("retains heading, tab, replacement-focus, and local-only boundaries", () => {
    expect(bridge).toContain('heading.id = "canvas-region-title"');
    expect(bridge).toContain('button.id = `studio-canvas-tab-${tab}`');
    expect(bridge).toContain('inspectorContentNode.setAttribute("role", "tabpanel")');
    expect(bridge).toContain('if (event.key === "ArrowRight")');
    expect(bridge).toContain('if (event.key === "ArrowLeft")');
    expect(bridge).toContain('if (event.key === "Home")');
    expect(bridge).toContain('if (event.key === "End")');
    expect(bridge).toContain("inspectorButtons().find((button) => button.dataset.tab === nextTab)?.focus()");

    for (const source of [runtimeBoundary, bridge]) {
      expect(() => new Function(source)).not.toThrow();
      expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
      expect(source).not.toMatch(/https?:\/\//);
      expect(source).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
      expect(source).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    }
  });
});

function executePolicy(): StudioPolicy {
  const context: Record<string, unknown> & { StensiblyStudioCanvasPolicy?: StudioPolicy } = {
    StensiblyFrontendLabFixtures: { frontendLabFixture },
    Object,
    Array,
    Set,
    Map,
    Number,
    Error,
    TypeError,
  };
  runInNewContext(bridge, context);
  if (!context.StensiblyStudioCanvasPolicy) throw new Error("Studio Canvas policy was not published");
  return context.StensiblyStudioCanvasPolicy;
}

function baseArtifacts(): BaseArtifact[] {
  return [
    base("approve-release-note"),
    base("worker-health"),
    base("repair-focus-order"),
    base("deploy-amber"),
    base("connection-health"),
  ];
}

function base(id: string): BaseArtifact {
  return {
    id,
    title: `Local ${id}`,
    summary: "stale local summary",
    source: "stale local source",
    revision: "local-r1",
    nextAction: "local next action",
    sections: [["One", "first"], ["Two", "second"], ["Three", "third"]],
    evidence: ["local-evidence"],
    comments: [],
    versions: [],
    activity: [],
  };
}

function requiredText(value: string | number | undefined, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing fixture text for ${label}`);
  return value;
}

function fakeTarget(tagName: string, tabIndex: number) {
  return {
    tagName,
    tabIndex,
    isConnected: true,
    hidden: false,
    inert: false,
    hasAttribute: () => false,
  };
}
