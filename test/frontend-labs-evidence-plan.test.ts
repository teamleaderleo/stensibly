import { describe, expect, test } from "bun:test";
import {
  createFrontendLabEvidencePlan,
  createFrontendLabEvidencePlanRevision,
  createFrontendLabFixtureRevision,
  frontendLabEvidenceIdentityLimits,
  frontendLabEvidencePlanVersion,
  frontendLabEvidenceProfiles,
  frontendLabEvidenceScenarios,
  validateFrontendLabEvidenceVariant,
} from "../site/labs/evidence.js";
import { frontendLabManifest } from "../site/labs/manifest.js";
import { frontendLabFixture, frontendLabTasks } from "../site/labs/fixtures.js";

describe("frontend labs deterministic evidence plan", () => {
  test("publishes exact wide, medium, narrow, and 200 percent profiles", () => {
    expect(frontendLabEvidenceProfiles).toEqual([
      { id: "wide", width: 1440, height: 900, zoomPercent: 100, requiredSupport: "wide", taskEligible: true },
      { id: "medium", width: 960, height: 900, zoomPercent: 100, requiredSupport: "medium", taskEligible: false },
      { id: "narrow", width: 390, height: 844, zoomPercent: 100, requiredSupport: "narrow", taskEligible: true },
      { id: "zoom-200", width: 1440, height: 900, zoomPercent: 200, requiredSupport: "wide", taskEligible: true },
    ]);
    expect(frontendLabEvidenceScenarios.map((scenario) => scenario.id)).toEqual(["default", "empty", "loading", "degraded", "error"]);
  });

  test("creates one canonical frozen plan independent of requested id order", () => {
    const variantIds = frontendLabManifest.map((variant) => variant.id);
    const taskIds = frontendLabTasks.map((task) => task.id);
    const profileIds = frontendLabEvidenceProfiles.map((profile) => profile.id);
    const forward = createFrontendLabEvidencePlan({ variantIds, taskIds, profileIds });
    const reversed = createFrontendLabEvidencePlan({ variantIds: [...variantIds].reverse(), taskIds: [...taskIds].reverse(), profileIds: [...profileIds].reverse() });
    expect(reversed).toEqual(forward);
    expect(forward.version).toBe(frontendLabEvidencePlanVersion);
    expect(forward.version).toBe(2);
    expect(forward.fixtureId).toBe("paper-lantern");
    expect(forward.fixtureRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(forward.planRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.cases)).toBe(true);
    expect(new Set(forward.cases.map((entry) => entry.id)).size).toBe(forward.cases.length);
    expect(forward.cases.every((entry) => entry.fixtureRevision === forward.fixtureRevision)).toBe(true);
    expect(forward.cases.every((entry) => entry.planRevision === forward.planRevision)).toBe(true);
  });

  test("changes the fixture revision when fixture or task content changes", () => {
    const original = createFrontendLabFixtureRevision(frontendLabFixture, frontendLabTasks);
    const changedFixture = {
      ...frontendLabFixture,
      project: { ...frontendLabFixture.project, summary: `${frontendLabFixture.project.summary} Updated.` },
    };
    expect(createFrontendLabFixtureRevision(changedFixture, frontendLabTasks)).not.toBe(original);

    const changedTasks = frontendLabTasks.map((task, index) => index === 0 ? { ...task, success: "another-decision" } : task);
    expect(createFrontendLabFixtureRevision(frontendLabFixture, changedTasks)).not.toBe(original);
  });

  test("changes the complete plan revision when any evidence definition changes", () => {
    const baseInput = revisionInput();
    const original = createFrontendLabEvidencePlanRevision(baseInput);

    expect(createFrontendLabEvidencePlanRevision({
      ...baseInput,
      version: frontendLabEvidencePlanVersion + 1,
    })).not.toBe(original);
    expect(createFrontendLabEvidencePlanRevision({
      ...baseInput,
      profiles: frontendLabEvidenceProfiles.map((profile) => profile.id === "wide" ? { ...profile, width: profile.width + 1 } : profile),
    })).not.toBe(original);
    expect(createFrontendLabEvidencePlanRevision({
      ...baseInput,
      scenarios: frontendLabEvidenceScenarios.map((scenario) => scenario.id === "empty" ? { ...scenario, requiredSupport: "error" } : scenario),
    })).not.toBe(original);
    expect(createFrontendLabEvidencePlanRevision({
      ...baseInput,
      manifest: frontendLabManifest.map((variant) => variant.id === "quiet-control" ? { ...variant, support: [...variant.support, "loading"] } : variant),
    })).not.toBe(original);
    expect(createFrontendLabEvidencePlanRevision({
      ...baseInput,
      fixtureRevision: "0".repeat(64),
    })).not.toBe(original);
  });

  test("binds every artifact identity to fixture, plan, and rendered variant generations", () => {
    const plan = createFrontendLabEvidencePlan();
    const fixtureIdentity = plan.fixtureRevision.slice(0, 16);
    const planIdentity = plan.planRevision.slice(0, 16);

    for (const variant of frontendLabManifest) {
      const cases = plan.cases.filter((entry) => entry.variantId === variant.id);
      const variantIdentity = variant.status === "prototype"
        ? `prototype-${variant.revision}`
        : "planned-unreviewed";
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.every((entry) => entry.id.includes(`--${variantIdentity}--`))).toBe(true);
      expect(cases.every((entry) => entry.id.includes(`--fixture-${fixtureIdentity}--plan-${planIdentity}`))).toBe(true);
      expect(cases.every((entry) => entry.artifactStem.includes(`--${variantIdentity}--`))).toBe(true);
      expect(cases.every((entry) => entry.artifactStem.endsWith(`--fixture-${fixtureIdentity}--plan-${planIdentity}`))).toBe(true);
    }
  });

  test("covers every registered route and reserves task flows for published prototypes", () => {
    const plan = createFrontendLabEvidencePlan();
    for (const variant of frontendLabManifest) {
      const cases = plan.cases.filter((entry) => entry.variantId === variant.id);
      expect(cases.some((entry) => entry.kind === "route")).toBe(true);
      expect(cases.every((entry) => entry.route === `/labs/${variant.id}/`)).toBe(true);
      expect(cases.every((entry) => entry.variantRevision === variant.revision)).toBe(true);
      const taskCases = cases.filter((entry) => entry.kind === "task");
      if (variant.status === "prototype") {
        expect(new Set(taskCases.map((entry) => entry.taskId))).toEqual(new Set(frontendLabTasks.map((task) => task.id)));
      } else {
        expect(taskCases).toEqual([]);
      }
    }
  });

  test("fails closed when a selected variant cannot emit complete route or task evidence", () => {
    expect(() => createFrontendLabEvidencePlan({
      variantIds: ["soft-companion"],
      profileIds: ["medium"],
    })).toThrow("at least one selected supported evidence profile");

    const prototype = frontendLabManifest.find((variant) => variant.id === "quiet-control")!;
    expect(() => validateFrontendLabEvidenceVariant({
      ...prototype,
      support: ["wide", "keyboard"],
    })).toThrow("at least one supported color scheme");
    expect(() => validateFrontendLabEvidenceVariant({
      ...prototype,
      support: ["wide", "light"],
    })).toThrow("requires keyboard support");

    const medium = frontendLabEvidenceProfiles.find((profile) => profile.id === "medium")!;
    expect(() => validateFrontendLabEvidenceVariant({
      ...prototype,
      support: ["medium", "light", "keyboard"],
    }, [medium])).toThrow("task-eligible evidence profile");
  });

  test("emits only supported presentation axes and state scenarios", () => {
    const plan = createFrontendLabEvidencePlan();
    const fieldCases = plan.cases.filter((entry) => entry.variantId === "field-console");
    expect(fieldCases.every((entry) => entry.colorScheme === "dark")).toBe(true);
    const softCases = plan.cases.filter((entry) => entry.variantId === "soft-companion");
    expect(softCases.some((entry) => entry.profileId === "medium")).toBe(false);

    for (const variant of frontendLabManifest) {
      const cases = plan.cases.filter((entry) => entry.variantId === variant.id);
      expect(cases.some((entry) => entry.motion === "reduce")).toBe(variant.support.includes("reduced-motion"));
      for (const scenario of frontendLabEvidenceScenarios.filter((entry) => entry.requiredSupport !== null)) {
        expect(cases.some((entry) => entry.scenarioId === scenario.id)).toBe(variant.support.includes(scenario.requiredSupport!));
      }
    }
  });

  test("uses bounded deterministic case, artifact, and filename identities", () => {
    const plan = createFrontendLabEvidencePlan({ variantIds: ["quiet-control"], profileIds: ["narrow"], taskIds: ["human-decision"] });
    expect(plan.cases.length).toBeGreaterThan(0);
    for (const entry of plan.cases) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)+$/);
      expect(entry.id.length).toBeLessThanOrEqual(220);
      expect(entry.artifactStem).toBe(`frontend-labs-${entry.id}`);
      expect(entry.artifactStem.length).toBeLessThanOrEqual(240);
      for (const suffix of [".png", ".json", ".zip", "-retry-99.png"]) {
        expect(`${entry.artifactStem}${suffix}`.length).toBeLessThanOrEqual(255);
      }
      expect(entry.viewportWidth).toBe(390);
      expect(entry.viewportHeight).toBe(844);
      expect(entry.zoomPercent).toBe(100);
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  test("reads planner inputs through enumerable data descriptors without invoking getters", () => {
    let planGetterCalls = 0;
    const planInput = {};
    Object.defineProperty(planInput, "variantIds", {
      enumerable: true,
      get() {
        planGetterCalls += 1;
        return ["quiet-control"];
      },
    });
    expect(() => createFrontendLabEvidencePlan(planInput)).toThrow("enumerable data fields only");
    expect(planGetterCalls).toBe(0);

    let revisionGetterCalls = 0;
    const input = revisionInput();
    Object.defineProperty(input, "profiles", {
      enumerable: true,
      configurable: true,
      get() {
        revisionGetterCalls += 1;
        return frontendLabEvidenceProfiles;
      },
    });
    expect(() => createFrontendLabEvidencePlanRevision(input)).toThrow("enumerable data fields only");
    expect(revisionGetterCalls).toBe(0);
  });

  test("serializes fixture identities without invoking nested object or array accessors", () => {
    let objectGetterCalls = 0;
    const fixture = {};
    Object.defineProperty(fixture, "project", {
      enumerable: true,
      get() {
        objectGetterCalls += 1;
        return frontendLabFixture.project;
      },
    });
    expect(() => createFrontendLabFixtureRevision(fixture, [])).toThrow("enumerable data fields only");
    expect(objectGetterCalls).toBe(0);

    let slotGetterCalls = 0;
    const tasks: unknown[] = [];
    Object.defineProperty(tasks, "0", {
      enumerable: true,
      configurable: true,
      get() {
        slotGetterCalls += 1;
        return frontendLabTasks[0];
      },
    });
    Object.defineProperty(tasks, "length", { value: 1, writable: true });
    expect(() => createFrontendLabFixtureRevision({}, tasks)).toThrow("dense enumerable data slots");
    expect(slotGetterCalls).toBe(0);
  });

  test("bounds identity depth, nodes, strings, and canonical UTF-8 bytes", () => {
    const limits = frontendLabEvidenceIdentityLimits;

    expect(createFrontendLabFixtureRevision(nestedObject(limits.maximumDepth - 1), [])).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createFrontendLabFixtureRevision(nestedObject(limits.maximumDepth), [])).toThrow(`maximum depth ${limits.maximumDepth}`);
    expect(() => createFrontendLabFixtureRevision(nestedObject(10_000), [])).toThrow(`maximum depth ${limits.maximumDepth}`);

    expect(createFrontendLabFixtureRevision(Array.from({ length: limits.maximumNodes - 3 }, () => null), [])).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createFrontendLabFixtureRevision(Array.from({ length: limits.maximumNodes - 2 }, () => null), [])).toThrow(`maximum node count ${limits.maximumNodes}`);

    expect(createFrontendLabFixtureRevision("a".repeat(limits.maximumStringBytes), [])).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createFrontendLabFixtureRevision("a".repeat(limits.maximumStringBytes + 1), [])).toThrow(`${limits.maximumStringBytes} UTF-8 bytes`);

    const exactBytes = [
      "a".repeat(4_096),
      "b".repeat(4_096),
      "c".repeat(4_096),
      "d".repeat(4_060),
    ];
    expect(createFrontendLabFixtureRevision(exactBytes, [])).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createFrontendLabFixtureRevision([
      ...exactBytes.slice(0, -1),
      "d".repeat(4_061),
    ], [])).toThrow(`${limits.maximumCanonicalBytes} UTF-8 bytes`);
  });

  test("rejects sparse, decorated, symbolic, cyclic, and non-finite evidence identity data", () => {
    const sparse = new Array(1);
    expect(() => createFrontendLabEvidencePlan({ variantIds: sparse })).toThrow("dense enumerable data slots");

    const decorated = ["quiet-control"];
    Object.defineProperty(decorated, "extra", { enumerable: true, value: "hidden-authority" });
    expect(() => createFrontendLabEvidencePlan({ variantIds: decorated })).toThrow("decorated fields");

    const symbolic = ["quiet-control"];
    Object.defineProperty(symbolic, Symbol("authority"), { enumerable: true, value: "hidden-authority" });
    expect(() => createFrontendLabEvidencePlan({ variantIds: symbolic })).toThrow("symbol fields");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createFrontendLabFixtureRevision(cyclic, [])).toThrow("must not contain cycles");
    expect(() => createFrontendLabFixtureRevision({ value: Number.NaN }, [])).toThrow("must be finite");
    expect(() => createFrontendLabFixtureRevision({ value: -0 }, [])).toThrow("negative zero");
  });

  test("validates the exact evidence revision envelope before hashing", () => {
    const input = revisionInput();
    expect(() => createFrontendLabEvidencePlanRevision({ ...input, version: 0 })).toThrow("positive safe integer");
    expect(() => createFrontendLabEvidencePlanRevision({ ...input, fixtureRevision: "abc" })).toThrow("lowercase SHA-256");
    expect(() => createFrontendLabEvidencePlanRevision({ ...input, extra: true } as never)).toThrow("exact fields");

    const symbolic = revisionInput();
    Object.defineProperty(symbolic, Symbol("authority"), { enumerable: true, value: "hidden-authority" });
    expect(() => createFrontendLabEvidencePlanRevision(symbolic)).toThrow("symbol fields");
  });

  test("rejects unknown fields, duplicates, and unknown catalogue identities", () => {
    expect(() => createFrontendLabEvidencePlan({ variantIds: ["quiet-control", "quiet-control"] })).toThrow("must be unique");
    expect(() => createFrontendLabEvidencePlan({ variantIds: ["missing-variant"] })).toThrow("Unknown evidence variant");
    expect(() => createFrontendLabEvidencePlan({ profileIds: ["tablet"] })).toThrow("Unknown evidence profile");
    expect(() => createFrontendLabEvidencePlan({ taskIds: ["missing-task"] })).toThrow("Unknown evidence task");
    expect(() => createFrontendLabEvidencePlan({ extra: true } as never)).toThrow("unknown field");
  });
});

function revisionInput() {
  return {
    version: frontendLabEvidencePlanVersion,
    profiles: frontendLabEvidenceProfiles,
    scenarios: frontendLabEvidenceScenarios,
    manifest: frontendLabManifest,
    fixtureRevision: createFrontendLabFixtureRevision(frontendLabFixture, frontendLabTasks),
  };
}

function nestedObject(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}
