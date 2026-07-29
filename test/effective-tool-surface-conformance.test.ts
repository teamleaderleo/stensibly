import { describe, expect, test } from "bun:test";
import {
  runEffectiveToolSurfaceConformanceScenario,
  type EffectiveToolSurfaceConformanceScenarioInput,
} from "../src/effective-tool-surface-conformance.ts";
import type {
  EffectiveToolSurfaceSnapshotInput,
  ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";

const requiredSurface = [
  { class: "native_core", id: "shell.exec" },
  { class: "app_connector", id: "github.read" },
  { class: "configured_mcp", id: "stensibly.get_brief" },
  { class: "discovery", id: "tool_search" },
] as const;

const fullClasses = {
  native_core: toolClass(["shell.exec", "python.exec"], "host:native"),
  host_dynamic: toolClass(["web.search"], "host:dynamic"),
  app_connector: toolClass(["github.read"], "connector:github"),
  configured_mcp: toolClass(["stensibly.get_brief"], "mcp:stensibly"),
  discovery: toolClass(["tool_search"], "host:discovery"),
} as const;

describe("effective tool-surface conformance scenarios", () => {
  test("replays core surviving while custom surfaces disappear and recover", () => {
    const report = runEffectiveToolSurfaceConformanceScenario({
      scenarioId: "core_survives_custom_disappears",
      suiteVersion: "tool-surface/1",
      steps: [
        {
          stepId: "fresh",
          snapshot: snapshotInput({
            snapshotId: "surface_fresh",
            transition: "new",
            observedAt: "2026-07-29T15:00:00Z",
          }),
          expect: healthyExpectation(false),
        },
        {
          stepId: "compacted",
          snapshot: snapshotInput({
            snapshotId: "surface_compacted",
            transition: "compact",
            observedAt: "2026-07-29T15:01:00Z",
            classes: {
              ...fullClasses,
              app_connector: catalogueOnly(["github.read"], "connector:github"),
              configured_mcp: catalogueOnly(["stensibly.get_brief"], "mcp:stensibly"),
              discovery: toolClass([], "host:discovery"),
            },
            recoveryActions: ["fork_with_current_tools", "restart"],
          }),
          expect: {
            state: "degraded",
            dispatchDecision: "block_or_reroute",
            surfaceChanged: true,
            missingRequiredCapabilities: [
              { class: "app_connector", id: "github.read" },
              { class: "configured_mcp", id: "stensibly.get_brief" },
              { class: "discovery", id: "tool_search" },
            ],
            catalogueOnlyRequiredCapabilities: [
              { class: "app_connector", id: "github.read" },
              { class: "configured_mcp", id: "stensibly.get_brief" },
            ],
            degradedClasses: ["app_connector", "configured_mcp", "discovery"],
            recommendedRecoveryAction: "fork_with_current_tools",
          },
        },
        {
          stepId: "fresh_surface",
          snapshot: snapshotInput({
            snapshotId: "surface_restarted",
            transition: "restart",
            observedAt: "2026-07-29T15:02:00Z",
            externalSurfaceRef: "chatgpt:thread:544:fresh",
            transport: "https",
          }),
          expect: {
            ...healthyExpectation(true),
            state: "recovered",
          },
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.stateCounts).toEqual({ healthy: 1, changed: 0, degraded: 1, recovered: 1 });
    expect(report.blockedStepCount).toBe(1);
    expect(report.recoveredStepCount).toBe(1);
    expect(report.canonicalRunPreserved).toBe(true);
    expect(report.sideEffectsPerformed).toBe(false);
    expect(report.evidenceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("replays custom surfaces surviving while required native tools disappear", () => {
    const report = runEffectiveToolSurfaceConformanceScenario({
      scenarioId: "custom_survives_core_disappears",
      suiteVersion: "tool-surface/1",
      steps: [
        {
          stepId: "fresh",
          snapshot: snapshotInput({
            snapshotId: "surface_native_fresh",
            observedAt: "2026-07-29T16:00:00Z",
          }),
          expect: healthyExpectation(false),
        },
        {
          stepId: "resumed_without_core",
          snapshot: snapshotInput({
            snapshotId: "surface_native_missing",
            transition: "resume",
            observedAt: "2026-07-29T16:01:00Z",
            classes: {
              ...fullClasses,
              native_core: catalogueOnly(["shell.exec", "python.exec"], "host:native"),
            },
            recoveryActions: ["restart"],
          }),
          expect: {
            state: "degraded",
            dispatchDecision: "block_or_reroute",
            surfaceChanged: true,
            missingRequiredCapabilities: [{ class: "native_core", id: "shell.exec" }],
            catalogueOnlyRequiredCapabilities: [{ class: "native_core", id: "shell.exec" }],
            degradedClasses: ["native_core"],
            recommendedRecoveryAction: "restart",
          },
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.steps[1]).toMatchObject({
      state: "degraded",
      dispatchDecision: "block_or_reroute",
      degradedClasses: ["native_core"],
    });
    expect(report.steps[1]?.missingRequiredCapabilities).not.toContainEqual({
      class: "app_connector",
      id: "github.read",
    });
  });

  test("allows additive tool growth without weakening the required surface", () => {
    const scenario: EffectiveToolSurfaceConformanceScenarioInput = {
      scenarioId: "additive_growth",
      suiteVersion: "tool-surface/1",
      steps: [
        {
          stepId: "before",
          snapshot: snapshotInput({
            snapshotId: "surface_before_addition",
            observedAt: "2026-07-29T17:00:00Z",
          }),
          expect: healthyExpectation(false),
        },
        {
          stepId: "after",
          snapshot: snapshotInput({
            snapshotId: "surface_after_addition",
            transition: "refresh",
            observedAt: "2026-07-29T17:01:00Z",
            classes: {
              ...fullClasses,
              configured_mcp: toolClass(
                ["stensibly.get_brief", "stensibly.get_github_project_context"],
                "mcp:stensibly",
              ),
            },
          }),
          expect: {
            ...healthyExpectation(true),
            state: "changed",
          },
        },
      ],
    };

    const first = runEffectiveToolSurfaceConformanceScenario(scenario);
    const second = runEffectiveToolSurfaceConformanceScenario(scenario);

    expect(first.passed).toBe(true);
    expect(first.steps[1]).toMatchObject({ state: "changed", dispatchDecision: "allow" });
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);
  });

  test("returns bounded mismatch evidence instead of silently accepting a wrong expectation", () => {
    const report = runEffectiveToolSurfaceConformanceScenario({
      scenarioId: "wrong_expectation",
      suiteVersion: "tool-surface/1",
      steps: [
        {
          stepId: "missing_app",
          snapshot: snapshotInput({
            snapshotId: "surface_wrong_expectation",
            observedAt: "2026-07-29T18:00:00Z",
            classes: {
              ...fullClasses,
              app_connector: catalogueOnly(["github.read"], "connector:github"),
            },
            recoveryActions: ["reconnect"],
          }),
          expect: healthyExpectation(false),
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.steps[0]?.mismatches.map((entry) => entry.code)).toEqual([
      "state_mismatch",
      "dispatch_decision_mismatch",
      "missing_required_mismatch",
      "catalogue_only_required_mismatch",
      "degraded_classes_mismatch",
      "recovery_action_mismatch",
    ]);
    expect(report.steps[0]?.mismatches.every((entry) => entry.expected.length < 200)).toBe(true);
  });

  test("rejects canonical run drift, changed requirements, and non-monotonic observations", () => {
    const base = {
      scenarioId: "invalid_lifecycle",
      suiteVersion: "tool-surface/1",
    } as const;

    expect(() => runEffectiveToolSurfaceConformanceScenario({
      ...base,
      steps: [
        step("first", snapshotInput({ snapshotId: "surface_identity_a", observedAt: "2026-07-29T19:00:00Z" })),
        step("second", snapshotInput({
          snapshotId: "surface_identity_b",
          observedAt: "2026-07-29T19:01:00Z",
          runId: "run_other",
        })),
      ],
    })).toThrow("canonical run ID changed");

    expect(() => runEffectiveToolSurfaceConformanceScenario({
      ...base,
      scenarioId: "changed_requirements",
      steps: [
        step("first", snapshotInput({ snapshotId: "surface_requirements_a", observedAt: "2026-07-29T19:10:00Z" })),
        step("second", snapshotInput({
          snapshotId: "surface_requirements_b",
          observedAt: "2026-07-29T19:11:00Z",
          requiredCapabilities: [{ class: "app_connector", id: "github.read" }],
        })),
      ],
    })).toThrow("required-capability set changed");

    expect(() => runEffectiveToolSurfaceConformanceScenario({
      ...base,
      scenarioId: "time_reversal",
      steps: [
        step("first", snapshotInput({ snapshotId: "surface_time_a", observedAt: "2026-07-29T19:20:00Z" })),
        step("second", snapshotInput({ snapshotId: "surface_time_b", observedAt: "2026-07-29T19:19:00Z" })),
      ],
    })).toThrow("strictly increasing timestamp order");
  });
});

function healthyExpectation(surfaceChanged: boolean) {
  return {
    state: "healthy" as const,
    dispatchDecision: "allow" as const,
    surfaceChanged,
    missingRequiredCapabilities: [],
    catalogueOnlyRequiredCapabilities: [],
    degradedClasses: [],
    recommendedRecoveryAction: null,
  };
}

function step(stepId: string, snapshot: EffectiveToolSurfaceSnapshotInput) {
  return { stepId, snapshot, expect: healthyExpectation(true) };
}

function snapshotInput(
  overrides: Partial<EffectiveToolSurfaceSnapshotInput> = {},
): EffectiveToolSurfaceSnapshotInput {
  return {
    snapshotId: overrides.snapshotId ?? "surface_default",
    runnerAdapter: overrides.runnerAdapter ?? "chatgpt",
    runnerVersion: overrides.runnerVersion ?? "2026.07.29",
    clientProduct: overrides.clientProduct ?? "ChatGPT",
    clientBuild: overrides.clientBuild ?? "web-2026.07.29",
    modelProfile: overrides.modelProfile ?? "gpt-5.6-thinking",
    externalSurfaceRef: overrides.externalSurfaceRef ?? "chatgpt:thread:544",
    runId: overrides.runId ?? "run_544",
    runGeneration: overrides.runGeneration ?? 1,
    transport: overrides.transport ?? "websocket",
    transition: overrides.transition ?? "new",
    classes: overrides.classes ?? fullClasses,
    requiredCapabilities: overrides.requiredCapabilities ?? requiredSurface,
    recoveryActions: overrides.recoveryActions ?? [],
    observedAt: overrides.observedAt ?? "2026-07-29T15:00:00Z",
    traceId: overrides.traceId ?? "trace_544",
  };
}

function toolClass(ids: readonly string[], provenance: string): ToolSurfaceClassInput {
  return {
    executable: ids.map((id) => ({ id })),
    provenance: [provenance],
  };
}

function catalogueOnly(ids: readonly string[], provenance: string): ToolSurfaceClassInput {
  return {
    catalogue: ids.map((id) => ({ id })),
    executable: [],
    provenance: [provenance],
  };
}
