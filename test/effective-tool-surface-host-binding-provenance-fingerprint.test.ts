import { expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
} from "../src/effective-tool-surface-host-binding.ts";

function snapshot(provenance: string) {
  return buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface: {
      snapshotId: "host_binding_provenance_identity",
      runnerAdapter: "chatgpt",
      runnerVersion: "2026.08.08",
      clientProduct: "ChatGPT",
      clientBuild: "web-2026.08.08",
      modelProfile: "gpt-5.6-sol",
      externalSurfaceRef: "chatgpt:thread:1195",
      runId: "run_1195_provenance",
      runGeneration: 1,
      transport: "host-registry",
      transition: "new",
      classes: {
        native_core: {
          executable: [{ id: "shell.exec" }],
          provenance: [provenance],
        },
      },
      requiredCapabilities: [],
      recoveryActions: [],
      observedAt: "2026-08-08T00:00:00Z",
      traceId: "trace_1195_provenance",
    },
  });
}

test("binds published class provenance into host-binding snapshot identity", () => {
  const first = snapshot("host:surface-a");
  const second = snapshot("host:surface-b");

  expect(first.classObservations.native_core.provenance)
    .toEqual(["host:surface-a"]);
  expect(second.classObservations.native_core.provenance)
    .toEqual(["host:surface-b"]);

  // The legacy v1 capability fingerprint intentionally excludes provenance.
  expect(first.toolSurface.surfaceFingerprint)
    .toBe(second.toolSurface.surfaceFingerprint);

  // The host-binding layer publishes provenance, so its own identity must bind it.
  expect(first.hostBindingFingerprint)
    .not.toBe(second.hostBindingFingerprint);
  expect(first.snapshotFingerprint)
    .not.toBe(second.snapshotFingerprint);
});
