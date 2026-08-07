import { describe, expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceClass,
  type EffectiveToolSurfaceSnapshotInput,
  type ToolSurfaceCapabilityInput,
} from "../src/effective-tool-surface.ts";
import { buildEffectiveToolSurfaceHostBindingSnapshot } from "../src/effective-tool-surface-host-binding.ts";

const classes = [
  "native_core",
  "host_dynamic",
  "app_connector",
  "configured_mcp",
  "discovery",
] as const satisfies readonly EffectiveToolSurfaceClass[];

function maximumCapabilityList(): ToolSurfaceCapabilityInput[] {
  return Array.from({ length: 1_000 }, (_, index) => ({
    id: `capability.${String(index).padStart(4, "0")}`,
  }));
}

function maximumV1Input(): EffectiveToolSurfaceSnapshotInput {
  const classInputs = Object.fromEntries(
    classes.map((className) => {
      const capabilities = maximumCapabilityList();
      return [className, {
        catalogue: capabilities,
        executable: capabilities,
      }];
    }),
  ) as EffectiveToolSurfaceSnapshotInput["classes"];

  return {
    snapshotId: "host_binding_maximum_v1_surface",
    runnerAdapter: "chatgpt",
    runnerVersion: "2026.08.08",
    clientProduct: "ChatGPT",
    runId: "run_host_binding_budget",
    runGeneration: 1,
    transport: "host-registry",
    transition: "new",
    classes: classInputs,
    observedAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("host-binding wrapper v1 input-budget compatibility", () => {
  test("accepts every class at the inherited 1000 catalogue/executable ceiling", () => {
    const toolSurface = maximumV1Input();

    const base = buildEffectiveToolSurfaceSnapshot(toolSurface);
    expect(base.classes.native_core.catalogueCount).toBe(1_000);
    expect(base.classes.native_core.executableCount).toBe(1_000);
    expect(base.classes.discovery.catalogueCount).toBe(1_000);
    expect(base.classes.discovery.executableCount).toBe(1_000);

    const hostBinding = buildEffectiveToolSurfaceHostBindingSnapshot({ toolSurface });
    for (const className of classes) {
      expect(hostBinding.classObservations[className].observation).toBe("present");
      expect(hostBinding.classObservations[className].catalogueCount).toBe(1_000);
      expect(hostBinding.classObservations[className].executableCount).toBe(1_000);
    }
  });
});
