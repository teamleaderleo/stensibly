import { expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceSnapshotInput,
} from "../src/effective-tool-surface.ts";
import { buildEffectiveToolSurfaceHostBindingSnapshot } from "../src/effective-tool-surface-host-binding.ts";

const toolSurface: EffectiveToolSurfaceSnapshotInput = {
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
  transition: "new",
  classes: {
    app_connector: { executable: [] },
  },
  requiredCapabilities: [],
  recoveryActions: ["reconnect"],
  observedAt: "2026-08-08T00:00:00Z",
  traceId: "trace_1195_surface_identity",
};

test("keeps nested v1 canonical while host binding owns effective surface identity", () => {
  const canonicalCapabilitySurface = buildEffectiveToolSurfaceSnapshot(toolSurface);
  const present = buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface,
    classObservations: { app_connector: "present" },
  });
  const absent = buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface,
    classObservations: { app_connector: "absent" },
  });

  expect(present.toolSurface).toEqual(canonicalCapabilitySurface);
  expect(absent.toolSurface).toEqual(canonicalCapabilitySurface);
  expect(present.hostBindingFingerprint).not.toBe(absent.hostBindingFingerprint);
  expect(present.snapshotFingerprint).not.toBe(absent.snapshotFingerprint);

  const presentWithEffectiveSurface = present as typeof present & {
    surfaceFingerprint: string;
  };
  const absentWithEffectiveSurface = absent as typeof absent & {
    surfaceFingerprint: string;
  };

  expect(presentWithEffectiveSurface.surfaceFingerprint)
    .toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(absentWithEffectiveSurface.surfaceFingerprint)
    .toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(presentWithEffectiveSurface.surfaceFingerprint)
    .not.toBe(absentWithEffectiveSurface.surfaceFingerprint);
});
