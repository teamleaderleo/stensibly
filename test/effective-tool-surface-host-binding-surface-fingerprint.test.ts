import { expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
} from "../src/effective-tool-surface-host-binding.ts";

const sharedToolSurface = {
  snapshotId: "host_binding_surface_identity",
  runnerAdapter: "chatgpt",
  runnerVersion: "2026.08.08",
  clientProduct: "ChatGPT",
  clientBuild: "web-2026.08.08",
  modelProfile: "gpt-5.6-sol",
  externalSurfaceRef: "chatgpt:thread:1195",
  runId: "run_1195_surface_identity",
  runGeneration: 1,
  transport: "host-registry",
  transition: "new" as const,
  classes: {
    app_connector: {
      executable: [],
      provenance: ["host:binding-evidence"],
    },
  },
  requiredCapabilities: [
    { class: "app_connector" as const, id: "stensibly.get_brief" },
  ],
  recoveryActions: ["refresh_catalogue", "reconnect"],
  observedAt: "2026-08-08T00:00:00Z",
  traceId: "trace_1195_surface_identity",
};

test("host binding state participates in effective surface fingerprints", () => {
  const present = buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface: sharedToolSurface,
    classObservations: { app_connector: "present" },
  });
  const absent = buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface: sharedToolSurface,
    classObservations: { app_connector: "absent" },
  });

  expect(present.toolSurface.classes.app_connector.catalogueCount).toBe(0);
  expect(absent.toolSurface.classes.app_connector.catalogueCount).toBe(0);
  expect(present.toolSurface.classes.app_connector.executableCount).toBe(0);
  expect(absent.toolSurface.classes.app_connector.executableCount).toBe(0);
  expect(present.classObservations.app_connector.provenance)
    .toEqual(absent.classObservations.app_connector.provenance);
  expect(present.toolSurface.surfaceFingerprint)
    .not.toBe(absent.toolSurface.surfaceFingerprint);
  expect(present.toolSurface.snapshotFingerprint)
    .not.toBe(absent.toolSurface.snapshotFingerprint);
  expect(present.snapshotFingerprint).not.toBe(absent.snapshotFingerprint);
});
