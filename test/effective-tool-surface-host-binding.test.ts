import { describe, expect, test } from "bun:test";
import type {
  EffectiveToolSurfaceSnapshotInput,
  ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
  reconcileEffectiveToolSurfaceHostBinding,
} from "../src/effective-tool-surface-host-binding.ts";

const nativeCore = toolClass(["shell.exec"], "host:native");
const appExecutable = toolClass(["stensibly.get_brief"], "host:stensibly");
const requiredApp = [
  { class: "app_connector", id: "stensibly.get_brief" },
] as const;

describe("effective tool-surface host binding", () => {
  test("preserves the live present-empty to absent transition", () => {
    const previous = hostSnapshot({
      snapshotId: "host_present_empty",
      classes: {
        native_core: nativeCore,
        app_connector: {
          executable: [],
          provenance: ["host:namespace-present-empty"],
        },
      },
      requiredCapabilities: requiredApp,
      recoveryActions: ["refresh_catalogue", "reconnect", "restart"],
    });
    const current = hostSnapshot({
      snapshotId: "host_namespace_absent",
      transition: "reconnect",
      classes: {
        native_core: nativeCore,
        app_connector: {
          executable: [],
          provenance: ["host:namespace-absent"],
        },
      },
      classObservations: { app_connector: "absent" },
      requiredCapabilities: requiredApp,
      recoveryActions: ["refresh_catalogue", "reconnect", "restart"],
    });

    expect(previous.classObservations.app_connector.observation).toBe("present");
    expect(previous.classObservations.app_connector.catalogueCount).toBe(0);
    expect(current.classObservations.app_connector.observation).toBe("absent");
    expect(current.classObservations.app_connector.catalogueCount).toBe(0);
    expect(previous.toolSurface.surfaceFingerprint).toBe(current.toolSurface.surfaceFingerprint);
    expect(previous.hostBindingFingerprint).not.toBe(current.hostBindingFingerprint);
    expect(previous.snapshotFingerprint).not.toBe(current.snapshotFingerprint);

    const previousState = reconcileEffectiveToolSurfaceHostBinding(previous);
    const result = reconcileEffectiveToolSurfaceHostBinding(current, previous);
    expect(previousState).toMatchObject({
      state: "degraded",
      recommendedRecoveryAction: "refresh_catalogue",
      recommendedRecoveryReason: "catalogue_present_empty",
    });
    expect(result).toMatchObject({
      state: "degraded",
      hostBindingChanged: true,
      classObservationChanges: [{
        class: "app_connector",
        previous: "present",
        current: "absent",
      }],
      absentClasses: ["app_connector"],
      dispatchDecision: "block_or_reroute",
      consequentialCallsAllowed: false,
      recommendedRecoveryAction: "reconnect",
      recommendedRecoveryReason: "host_binding_absent",
      serverContractHealthInferred: false,
      historicalCallsProveCurrentBinding: false,
    });
    expect(result.base.missingSincePrevious).toEqual([]);
  });

  test("treats omitted evidence as unobserved and supplied legacy classes as present", () => {
    const snapshot = hostSnapshot({
      snapshotId: "host_partial_observation",
      classes: {
        native_core: nativeCore,
        app_connector: { executable: [] },
      },
    });

    expect(snapshot.classObservations.native_core.observation).toBe("present");
    expect(snapshot.classObservations.app_connector.observation).toBe("present");
    expect(snapshot.classObservations.configured_mcp.observation).toBe("unobserved");
    expect(snapshot.classObservations.discovery.observation).toBe("unobserved");
    expect(snapshot.serverContractHealthInferred).toBe(false);
  });

  test("rejects absent or unobserved classes carrying capability evidence", () => {
    for (const observation of ["absent", "unobserved"] as const) {
      expect(() => hostSnapshot({
        snapshotId: `host_contradictory_${observation}`,
        classes: {
          app_connector: appExecutable,
        },
        classObservations: { app_connector: observation },
      })).toThrow(`${observation} observation cannot retain capability evidence`);
    }
  });

  test("recovers from absent binding to present executable namespace", () => {
    const absent = hostSnapshot({
      snapshotId: "host_absent_before_recovery",
      classes: {
        native_core: nativeCore,
        app_connector: { executable: [] },
      },
      classObservations: { app_connector: "absent" },
      requiredCapabilities: requiredApp,
      recoveryActions: ["reconnect", "restart"],
    });
    const recovered = hostSnapshot({
      snapshotId: "host_present_after_recovery",
      transition: "reconnect",
      classes: {
        native_core: nativeCore,
        app_connector: appExecutable,
      },
      requiredCapabilities: requiredApp,
      recoveryActions: ["reconnect", "restart"],
    });

    const result = reconcileEffectiveToolSurfaceHostBinding(recovered, absent);
    expect(result).toMatchObject({
      state: "recovered",
      hostBindingChanged: true,
      classObservationChanges: [{
        class: "app_connector",
        previous: "absent",
        current: "present",
      }],
      dispatchDecision: "allow",
      consequentialCallsAllowed: true,
      recommendedRecoveryAction: null,
      recommendedRecoveryReason: null,
    });
    expect(result.base.addedSincePrevious).toEqual([
      { class: "app_connector", id: "stensibly.get_brief" },
    ]);
  });

  test("keeps unrelated native capability evidence independently usable", () => {
    const previous = hostSnapshot({
      snapshotId: "host_native_before",
      classes: {
        native_core: nativeCore,
        app_connector: { executable: [] },
      },
    });
    const current = hostSnapshot({
      snapshotId: "host_native_after",
      classes: {
        native_core: nativeCore,
        app_connector: { executable: [] },
      },
      classObservations: { app_connector: "absent" },
    });
    const result = reconcileEffectiveToolSurfaceHostBinding(current, previous);

    expect(current.toolSurface.classes.native_core.executableCapabilities)
      .toEqual([{ id: "shell.exec", name: null }]);
    expect(result.base.missingSincePrevious).toEqual([]);
    expect(result.state).toBe("changed");
    expect(result.hostBindingChanged).toBe(true);
    expect(result.consequentialCallsAllowed).toBe(true);
  });

  test("freezes host-binding snapshots and reconciliation outputs", () => {
    const previous = hostSnapshot({
      snapshotId: "host_freeze_before",
      classes: { app_connector: { executable: [] } },
    });
    const current = hostSnapshot({
      snapshotId: "host_freeze_after",
      classes: { app_connector: { executable: [] } },
      classObservations: { app_connector: "absent" },
    });
    const result = reconcileEffectiveToolSurfaceHostBinding(current, previous);

    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.classObservations)).toBe(true);
    expect(Object.isFrozen(current.classObservations.app_connector)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.classObservationChanges)).toBe(true);
  });
});

function toolClass(ids: readonly string[], provenance: string): ToolSurfaceClassInput {
  return {
    executable: ids.map((id) => ({ id })),
    provenance: [provenance],
  };
}

function hostSnapshot(
  overrides: Partial<EffectiveToolSurfaceSnapshotInput> & {
    classObservations?: Parameters<
      typeof buildEffectiveToolSurfaceHostBindingSnapshot
    >[0]["classObservations"];
  } = {},
) {
  const {
    classObservations,
    ...toolSurfaceOverrides
  } = overrides;
  return buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface: {
      snapshotId: toolSurfaceOverrides.snapshotId ?? "host_binding_default",
      runnerAdapter: toolSurfaceOverrides.runnerAdapter ?? "chatgpt",
      runnerVersion: toolSurfaceOverrides.runnerVersion ?? "2026.08.08",
      clientProduct: toolSurfaceOverrides.clientProduct ?? "ChatGPT",
      clientBuild: toolSurfaceOverrides.clientBuild ?? "web-2026.08.08",
      modelProfile: toolSurfaceOverrides.modelProfile ?? "gpt-5.6-sol",
      externalSurfaceRef: toolSurfaceOverrides.externalSurfaceRef ?? "chatgpt:thread:1195",
      runId: toolSurfaceOverrides.runId ?? "run_1195",
      runGeneration: toolSurfaceOverrides.runGeneration ?? 1,
      transport: toolSurfaceOverrides.transport ?? "host-registry",
      transition: toolSurfaceOverrides.transition ?? "new",
      classes: toolSurfaceOverrides.classes ?? {},
      requiredCapabilities: toolSurfaceOverrides.requiredCapabilities ?? [],
      recoveryActions: toolSurfaceOverrides.recoveryActions ?? [],
      observedAt: toolSurfaceOverrides.observedAt ?? "2026-08-08T00:00:00Z",
      traceId: toolSurfaceOverrides.traceId ?? "trace_1195",
    },
    classObservations,
  });
}
