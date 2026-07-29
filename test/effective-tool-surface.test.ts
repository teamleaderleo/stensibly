import { describe, expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceSnapshot,
  reconcileEffectiveToolSurface,
  type EffectiveToolSurfaceSnapshotInput,
  type ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";

const fullClasses = {
  native_core: toolClass(["shell.exec", "python.exec"], "host:native"),
  host_dynamic: toolClass(["web.search"], "host:dynamic"),
  app_connector: toolClass(["github.read"], "connector:github"),
  configured_mcp: toolClass(["stensibly.get_brief"], "mcp:stensibly"),
  discovery: toolClass(["tool_search"], "host:discovery"),
} as const;

const requiredCustom = [
  { class: "app_connector", id: "github.read" },
  { class: "configured_mcp", id: "stensibly.get_brief" },
  { class: "discovery", id: "tool_search" },
] as const;

describe("effective tool-surface snapshots", () => {
  test("canonicalizes class observations and computes stable surface digests", () => {
    const first = snapshot({
      snapshotId: "surface_order_a",
      classes: {
        ...fullClasses,
        native_core: {
          executable: [{ id: "python.exec" }, { id: "shell.exec", name: "Shell" }],
          provenance: ["host:planner", "host:native"],
        },
      },
    });
    const second = snapshot({
      snapshotId: "surface_order_b",
      observedAt: "2026-07-29T15:01:00Z",
      classes: {
        ...fullClasses,
        native_core: {
          executable: [{ id: "shell.exec", name: "Renamed display only" }, { id: "python.exec" }],
          provenance: ["host:native", "host:planner"],
        },
      },
    });

    expect(first.classes.native_core.executableCapabilities.map((entry) => entry.id)).toEqual([
      "python.exec",
      "shell.exec",
    ]);
    expect(first.classes.native_core.provenance).toEqual(["host:native", "host:planner"]);
    expect(first.surfaceFingerprint).toBe(second.surfaceFingerprint);
    expect(first.snapshotFingerprint).not.toBe(second.snapshotFingerprint);
  });

  test("distinguishes catalogue discovery from a current executable binding", () => {
    const current = snapshot({
      snapshotId: "surface_catalogue_only",
      classes: {
        ...fullClasses,
        app_connector: {
          catalogue: [{ id: "github.read", name: "GitHub read" }],
          executable: [],
          provenance: ["connector-snapshot:github"],
        },
      },
      requiredCapabilities: [{ class: "app_connector", id: "github.read" }],
      recoveryActions: ["refresh_catalogue", "restart"],
    });
    const result = reconcileEffectiveToolSurface(current);

    expect(current.classes.app_connector).toMatchObject({
      catalogueCount: 1,
      executableCount: 0,
      catalogueOnlyCapabilityIds: ["github.read"],
    });
    expect(current.catalogueOnlyRequiredCapabilities).toEqual([
      { class: "app_connector", id: "github.read" },
    ]);
    expect(result).toMatchObject({
      state: "degraded",
      dispatchDecision: "block_or_reroute",
      consequentialCallsAllowed: false,
      recommendedRecoveryAction: "refresh_catalogue",
      historicalCallsProveCurrentBinding: false,
    });
  });

  test("detects core surviving while custom and discovery classes disappear", () => {
    const previous = snapshot({ snapshotId: "surface_before_compact", requiredCapabilities: requiredCustom });
    const current = snapshot({
      snapshotId: "surface_after_compact",
      transition: "compact",
      classes: {
        native_core: fullClasses.native_core,
        host_dynamic: fullClasses.host_dynamic,
        app_connector: { executable: [], provenance: ["connector-snapshot:empty"] },
        configured_mcp: { executable: [], provenance: ["mcp-runtime:empty"] },
        discovery: { executable: [], provenance: ["host:discovery-absent"] },
      },
      requiredCapabilities: requiredCustom,
      recoveryActions: ["fork_with_current_tools", "restart"],
    });
    const result = reconcileEffectiveToolSurface(current, previous);

    expect(result.state).toBe("degraded");
    expect(result.degradedClasses).toEqual([
      "app_connector",
      "configured_mcp",
      "discovery",
    ]);
    expect(result.missingSincePrevious).toEqual([
      { class: "app_connector", id: "github.read" },
      { class: "configured_mcp", id: "stensibly.get_brief" },
      { class: "discovery", id: "tool_search" },
    ]);
    expect(result.missingSincePrevious).not.toContainEqual({
      class: "native_core",
      id: "shell.exec",
    });
    expect(result.recommendedRecoveryAction).toBe("fork_with_current_tools");
  });

  test("detects custom tools surviving while a required core binding disappears", () => {
    const requiredCore = [{ class: "native_core", id: "shell.exec" }] as const;
    const previous = snapshot({ snapshotId: "surface_before_resume", requiredCapabilities: requiredCore });
    const current = snapshot({
      snapshotId: "surface_after_resume",
      transition: "resume",
      classes: {
        ...fullClasses,
        native_core: {
          catalogue: [{ id: "shell.exec" }, { id: "python.exec" }],
          executable: [],
          provenance: ["host:native-catalogue"],
        },
      },
      requiredCapabilities: requiredCore,
      recoveryActions: ["restart", "move_continuation_to_fresh_surface"],
    });
    const result = reconcileEffectiveToolSurface(current, previous);

    expect(result.degradedClasses).toEqual(["native_core"]);
    expect(result.catalogueOnlyRequiredCapabilities).toEqual([
      { class: "native_core", id: "shell.exec" },
    ]);
    expect(result.missingSincePrevious).toContainEqual({
      class: "native_core",
      id: "shell.exec",
    });
    expect(result.missingSincePrevious).not.toContainEqual({
      class: "app_connector",
      id: "github.read",
    });
    expect(result.recommendedRecoveryAction).toBe("restart");
  });

  test("marks a fresh surface as recovered without rewriting canonical run identity", () => {
    const required = [{ class: "configured_mcp", id: "stensibly.get_brief" }] as const;
    const degraded = snapshot({
      snapshotId: "surface_poisoned_thread",
      runId: "run_shared_544",
      classes: {
        ...fullClasses,
        configured_mcp: { executable: [], provenance: ["mcp-runtime:missing"] },
      },
      requiredCapabilities: required,
      recoveryActions: ["move_continuation_to_fresh_surface"],
    });
    const recovered = snapshot({
      snapshotId: "surface_fresh_thread",
      runId: "run_shared_544",
      transition: "fork",
      requiredCapabilities: required,
    });
    const result = reconcileEffectiveToolSurface(recovered, degraded);

    expect(result).toMatchObject({
      state: "recovered",
      consequentialCallsAllowed: true,
      dispatchDecision: "allow",
      recommendedRecoveryAction: null,
    });
    expect(recovered.runId).toBe(degraded.runId);
  });

  test("allows additive capability changes when required bindings remain executable", () => {
    const previous = snapshot({ snapshotId: "surface_before_addition" });
    const current = snapshot({
      snapshotId: "surface_after_addition",
      transition: "refresh",
      classes: {
        ...fullClasses,
        configured_mcp: toolClass(
          ["stensibly.get_brief", "stensibly.get_github_project_context"],
          "mcp:stensibly",
        ),
      },
      requiredCapabilities: [{ class: "configured_mcp", id: "stensibly.get_brief" }],
    });
    const result = reconcileEffectiveToolSurface(current, previous);

    expect(result.state).toBe("changed");
    expect(result.addedSincePrevious).toEqual([
      { class: "configured_mcp", id: "stensibly.get_github_project_context" },
    ]);
    expect(result.consequentialCallsAllowed).toBe(true);
  });

  test("rejects duplicate IDs and executable capabilities absent from the catalogue", () => {
    expect(() => snapshot({
      snapshotId: "surface_duplicate",
      classes: {
        ...fullClasses,
        native_core: { executable: [{ id: "shell.exec" }, { id: "shell.exec" }] },
      },
    })).toThrow("duplicated");

    expect(() => snapshot({
      snapshotId: "surface_not_catalogued",
      classes: {
        ...fullClasses,
        app_connector: {
          catalogue: [{ id: "github.read" }],
          executable: [{ id: "gmail.read" }],
        },
      },
    })).toThrow("absent from its catalogue");
  });
});

function toolClass(ids: readonly string[], provenance: string): ToolSurfaceClassInput {
  return {
    executable: ids.map((id) => ({ id })),
    provenance: [provenance],
  };
}

function snapshot(
  overrides: Partial<EffectiveToolSurfaceSnapshotInput> = {},
) {
  return buildEffectiveToolSurfaceSnapshot({
    snapshotId: overrides.snapshotId ?? "surface_default",
    runnerAdapter: overrides.runnerAdapter ?? "chatgpt",
    runnerVersion: overrides.runnerVersion ?? "2026.07.29",
    clientProduct: overrides.clientProduct ?? "ChatGPT",
    clientBuild: overrides.clientBuild ?? "web-2026.07.29",
    modelProfile: overrides.modelProfile ?? "gpt-5.6-thinking",
    externalSurfaceRef: overrides.externalSurfaceRef ?? "chatgpt:thread:544",
    runId: overrides.runId ?? "run_544",
    runGeneration: overrides.runGeneration ?? 1,
    transport: overrides.transport ?? "https",
    transition: overrides.transition ?? "new",
    classes: overrides.classes ?? fullClasses,
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    recoveryActions: overrides.recoveryActions ?? [],
    observedAt: overrides.observedAt ?? "2026-07-29T15:00:00Z",
    traceId: overrides.traceId ?? "trace_544",
  });
}
