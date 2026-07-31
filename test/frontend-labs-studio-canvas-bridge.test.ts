import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture } from "../site/labs/fixtures.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "studio-canvas");
const policySource = readFileSync(join(routeRoot, "fixture-policy.js"), "utf8");
const bridge = readFileSync(join(routeRoot, "workspace-bridge.js"), "utf8");

type Version = { id: string; state: string; label: string; content: string };
type BaseArtifact = {
  id: string;
  kind: string;
  state: string;
  title: string;
  summary: string;
  source: string;
  revision: string;
  freshness: string;
  authority: string;
  persistence: string;
  owner: string;
  nextAction: string;
  sections: string[][];
  evidence: string[];
  comments: string[];
  versions: Version[];
  activity: string[];
};

type StudioPolicy = {
  projectArtifacts(base: readonly BaseArtifact[]): readonly BaseArtifact[];
  commandKinds(narrow: boolean, hasComparison: boolean): readonly string[];
  localActionCopy(entry: BaseArtifact, action: string): string;
  usefulReturnTarget(value: unknown, body: unknown, dialog: { contains(value: unknown): boolean }): boolean;
};

describe("Studio Canvas fixture and command policy", () => {
  test("projects one frozen shared-artifact set before rendering", () => {
    const policy = executePolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    const projected = policy.projectArtifacts(baseArtifacts());
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected).toHaveLength(5);

    expect(projected[0]).toMatchObject({
      id: "approve-release-note",
      title: frontendLabFixture.decision.title,
      summary: frontendLabFixture.decision.detail,
      source: "Shared decision approve-release-note",
    });
    expect(projected[0]?.evidence).toContain("approve-release-note");
    expect(projected[1]?.summary).toContain(frontendLabFixture.workers[0]?.label);
    expect(projected[1]?.summary).toContain(frontendLabFixture.workers[1]?.detail);
    expect(projected[1]?.evidence).toEqual(["moss", "ember"]);
    expect(projected[2]).toMatchObject({ id: "repair-focus-order", summary: frontendLabFixture.readyWork[0]?.reason });
    expect(projected[3]).toMatchObject({
      id: "deploy-amber",
      title: frontendLabFixture.operations[0]?.title,
      summary: frontendLabFixture.operations[0]?.detail,
      nextAction: frontendLabFixture.operations[0]?.action,
    });
    expect(projected[4]?.summary).toContain("GitHub healthy");
    expect(projected[4]?.summary).toContain("API reconnecting");
    expect(projected[4]?.summary).toContain("MCP offline");
  });

  test("rejects incomplete, duplicate, reordered, decorated, and accessor-bearing inputs", () => {
    const policy = executePolicy();
    const complete = baseArtifacts();
    expect(() => policy.projectArtifacts(complete.slice(1))).toThrow("must match the exact shared task order");
    expect(() => policy.projectArtifacts([...complete, complete[0]!])).toThrow("must be unique");
    expect(() => policy.projectArtifacts([complete[1]!, complete[0]!, ...complete.slice(2)]))
      .toThrow("must match the exact shared task order");
    expect(() => policy.projectArtifacts(complete.map((entry, index) => index === 0 ? { ...entry, surprise: true } : entry) as BaseArtifact[]))
      .toThrow("must use exact fields");

    const symbolic = { ...complete[0]!, [Symbol("hidden")]: true };
    expect(() => policy.projectArtifacts([symbolic, ...complete.slice(1)] as BaseArtifact[]))
      .toThrow("without symbol fields");

    let getterCalls = 0;
    const accessor = { ...complete[0]! } as BaseArtifact;
    Object.defineProperty(accessor, "id", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "approve-release-note";
      },
    });
    expect(() => policy.projectArtifacts([accessor, ...complete.slice(1)]))
      .toThrow("field id must be an enumerable data property");
    expect(getterCalls).toBe(0);

    const sectionAccessor = baseArtifacts();
    let sectionGetterCalls = 0;
    Object.defineProperty(sectionAccessor[0]!.sections[0]!, "1", {
      enumerable: true,
      configurable: true,
      get() {
        sectionGetterCalls += 1;
        return "first";
      },
    });
    expect(() => policy.projectArtifacts(sectionAccessor)).toThrow("must be a dense data array");
    expect(sectionGetterCalls).toBe(0);

    let inheritedArtifactGetterCalls = 0;
    const artifactPrototype = {};
    Object.defineProperty(artifactPrototype, "inherited", {
      get() {
        inheritedArtifactGetterCalls += 1;
        return "hidden";
      },
    });
    const customArtifact = Object.assign(
      Object.create(artifactPrototype),
      complete[0]!,
    ) as BaseArtifact;
    expect(() => policy.projectArtifacts([customArtifact, ...complete.slice(1)]))
      .toThrow("must use a plain or null prototype");
    expect(inheritedArtifactGetterCalls).toBe(0);

    let inheritedVersionGetterCalls = 0;
    const versionPrototype = {};
    Object.defineProperty(versionPrototype, "inherited", {
      get() {
        inheritedVersionGetterCalls += 1;
        return "hidden";
      },
    });
    const customVersion = Object.assign(Object.create(versionPrototype), {
      id: "r1",
      state: "local",
      label: "Earlier",
      content: "Earlier content",
    }) as Version;
    const versionArtifacts = baseArtifacts();
    versionArtifacts[0]!.versions = [customVersion];
    expect(() => policy.projectArtifacts(versionArtifacts))
      .toThrow("must use a plain or null prototype");
    expect(inheritedVersionGetterCalls).toBe(0);

    const nullPrototypeArtifact = Object.assign(
      Object.create(null),
      complete[0]!,
    ) as BaseArtifact;
    expect(policy.projectArtifacts([nullPrototypeArtifact, ...complete.slice(1)]))
      .toHaveLength(5);
  });

  test("does not execute caller-controlled array methods", () => {
    const policy = executePolicy();
    const complete = baseArtifacts();
    let methodCalls = 0;
    Object.defineProperty(complete, "map", {
      enumerable: true,
      configurable: true,
      value() {
        methodCalls += 1;
        throw new Error("caller map executed");
      },
    });
    expect(() => policy.projectArtifacts(complete)).toThrow("contains an unsupported field");
    expect(methodCalls).toBe(0);

    const decorated = baseArtifacts();
    Object.defineProperty(decorated[0]!.evidence, "extra", { enumerable: true, value: "hidden" });
    expect(() => policy.projectArtifacts(decorated)).toThrow("contains an unsupported field");
  });

  test("exposes only truthful commands for layout and revision availability", () => {
    const policy = executePolicy();
    expect(policy.commandKinds(true, false)).toEqual(["artifact", "inspector"]);
    expect(policy.commandKinds(true, true)).toEqual(["artifact", "inspector", "compare"]);
    expect(policy.commandKinds(false, false)).toEqual([
      "artifact",
      "inspector",
      "collapse-work",
      "collapse-inspector",
    ]);
    expect(policy.commandKinds(false, true)).toEqual([
      "artifact",
      "inspector",
      "compare",
      "collapse-work",
      "collapse-inspector",
    ]);
    expect(() => policy.commandKinds("narrow" as unknown as boolean, true)).toThrow("requires boolean layout and comparison state");
  });

  test("keeps visible local explanations and useful return-target admission literal", () => {
    const policy = executePolicy();
    const entry = policy.projectArtifacts(baseArtifacts())[3]!;
    expect(policy.localActionCopy(entry, "source")).toContain("Fictional local fixture only");
    expect(policy.localActionCopy(entry, "next")).toContain(fixtureText(frontendLabFixture.operations[0]?.action));
    expect(policy.localActionCopy(entry, "next")).toContain("No save, approval, submission, or write occurred");

    const body = fakeTarget("BODY", -1);
    const dialogChild = fakeTarget("BUTTON", 0);
    const dialog = { contains: (value: unknown) => value === dialogChild };
    expect(policy.usefulReturnTarget(body, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget(dialogChild, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget({ ...fakeTarget("BUTTON", 0), isConnected: false }, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget({ ...fakeTarget("BUTTON", 0), hasAttribute: () => true }, body, dialog)).toBe(false);
    expect(policy.usefulReturnTarget(fakeTarget("BUTTON", 0), body, dialog)).toBe(true);
    expect(policy.usefulReturnTarget(fakeTarget("DIV", 0), body, dialog)).toBe(true);
    expect(policy.usefulReturnTarget(fakeTarget("DIV", -1), body, dialog)).toBe(false);
  });

  test("keeps the workspace bridge semantics-only and authority-free", () => {
    expect(bridge).toContain('heading.id = "canvas-region-title"');
    expect(bridge).toContain('button.id = `studio-canvas-tab-${tab}`');
    expect(bridge).toContain('button.setAttribute("aria-controls", "inspector-content")');
    expect(bridge).toContain('inspectorContentNode.setAttribute("role", "tabpanel")');
    expect(bridge).toContain('if (event.key === "ArrowRight")');
    expect(bridge).toContain('if (event.key === "ArrowLeft")');
    expect(bridge).toContain('if (event.key === "Home")');
    expect(bridge).toContain('if (event.key === "End")');
    expect(bridge).toContain("inspectorButtons().find((button) => button.dataset.tab === nextTab)?.focus()");
    expect(bridge).not.toContain("selectedArtifact = function");
    expect(bridge).not.toContain("renderCommands = function");
    expect(bridge).not.toContain("StensiblyFrontendLabFixtures");
    for (const source of [policySource, bridge]) {
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
    Reflect,
    Error,
    TypeError,
  };
  runInNewContext(policySource, context);
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
    kind: "fixture artifact",
    state: "local",
    title: `Local ${id}`,
    summary: "stale local summary",
    source: "stale local source",
    revision: "local-r1",
    freshness: "observed locally",
    authority: "none",
    persistence: "not saved",
    owner: "fixture owner",
    nextAction: "local next action",
    sections: [["One", "first"], ["Two", "second"], ["Three", "third"]],
    evidence: ["local-evidence"],
    comments: [],
    versions: [],
    activity: [],
  };
}

function fixtureText(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("Expected shared fixture text");
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
