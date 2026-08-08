import { expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
  reconcileEffectiveToolSurfaceHostBinding,
} from "../src/effective-tool-surface-host-binding.ts";

function snapshot(provenance: string) {
  return buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface: {
      snapshotId: "host_binding_provenance",
      runnerAdapter: "chatgpt",
      runnerVersion: "2026.08.08",
      clientProduct: "ChatGPT",
      clientBuild: "web-2026.08.08",
      modelProfile: "gpt-5.6-sol",
      externalSurfaceRef: "chatgpt:thread:1195",
      runId: "run_1195_provenance",
      runGeneration: 1,
      transport: "host-registry",
      transition: "refresh",
      classes: {
        app_connector: {
          executable: [],
          provenance: [provenance],
        },
      },
      requiredCapabilities: [],
      recoveryActions: ["refresh_catalogue", "reconnect"],
      observedAt: "2026-08-08T00:00:00Z",
      traceId: "trace_1195_provenance",
    },
    classObservations: {
      app_connector: "present",
    },
  });
}

test("binds provenance-only host evidence into identity and reconciliation", () => {
  const previous = snapshot("host:namespace-present-empty:v1");
  const current = snapshot("host:namespace-present-empty:v2");

  expect(previous.toolSurface.surfaceFingerprint)
    .toBe(current.toolSurface.surfaceFingerprint);
  expect(previous.toolSurface.snapshotFingerprint)
    .toBe(current.toolSurface.snapshotFingerprint);
  expect(previous.classObservations.app_connector.observation)
    .toBe(current.classObservations.app_connector.observation);
  expect(previous.classObservations.app_connector.catalogueDigest)
    .toBe(current.classObservations.app_connector.catalogueDigest);
  expect(previous.classObservations.app_connector.executableDigest)
    .toBe(current.classObservations.app_connector.executableDigest);

  expect(previous.hostBindingFingerprint)
    .not.toBe(current.hostBindingFingerprint);
  expect(previous.snapshotFingerprint)
    .not.toBe(current.snapshotFingerprint);

  const result = reconcileEffectiveToolSurfaceHostBinding(current, previous);
  expect(result.state).toBe("changed");
  expect(result.hostBindingChanged).toBe(true);
  expect(result.classObservationChanges).toEqual([]);
  expect(result.dispatchDecision).toBe("allow");
  expect(result.consequentialCallsAllowed).toBe(true);
  expect(result.recommendedRecoveryAction).toBeNull();
  expect(result.serverContractHealthInferred).toBe(false);
  expect(result.historicalCallsProveCurrentBinding).toBe(false);
});
