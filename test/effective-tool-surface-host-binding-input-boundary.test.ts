import { describe, expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
} from "../src/effective-tool-surface-host-binding.ts";
import type { EffectiveToolSurfaceSnapshotInput } from "../src/effective-tool-surface.ts";

const toolSurface: EffectiveToolSurfaceSnapshotInput = {
  snapshotId: "host_binding_input_control",
  runnerAdapter: "chatgpt",
  runnerVersion: "2026.08.08",
  clientProduct: "ChatGPT",
  clientBuild: "web-2026.08.08",
  modelProfile: "gpt-5.6-sol",
  externalSurfaceRef: "chatgpt:thread:1195",
  runId: "run_1195_input_control",
  runGeneration: 1,
  transport: "host-registry",
  transition: "new",
  classes: {
    native_core: {
      executable: [{ id: "shell.exec" }],
      provenance: ["host:native"],
    },
    app_connector: {
      executable: [],
      provenance: ["host:namespace-present-empty"],
    },
  },
  requiredCapabilities: [{ class: "app_connector", id: "stensibly.get_brief" }],
  recoveryActions: ["refresh_catalogue", "reconnect", "restart"],
  observedAt: "2026-08-08T00:00:00Z",
  traceId: "trace_1195_input_control",
};

describe("effective tool-surface host-binding caller boundary", () => {
  test("uses captured top-level data descriptors instead of caller get traps", () => {
    const input = {
      toolSurface,
      classObservations: { app_connector: "absent" as const },
    };
    let getCalls = 0;
    let ownKeysCalls = 0;
    const hostile = new Proxy(input, {
      get() {
        getCalls += 1;
        throw new Error("caller get must remain unreachable");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must remain unreachable");
      },
    });

    const snapshot = buildEffectiveToolSurfaceHostBindingSnapshot(hostile);
    expect(snapshot.classObservations.app_connector.observation).toBe("absent");
    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  test("rejects a top-level accessor without invoking it", () => {
    let getterCalls = 0;
    const input = {
      classObservations: { app_connector: "absent" as const },
    } as Record<string, unknown>;
    Object.defineProperty(input, "toolSurface", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return toolSurface;
      },
    });

    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(
      input as unknown as Parameters<typeof buildEffectiveToolSurfaceHostBindingSnapshot>[0],
    )).toThrow("Effective tool-surface host-binding input fields must be enumerable data properties");
    expect(getterCalls).toBe(0);
  });

  test("normalizes revoked input and class-observation proxies", () => {
    const revokedInput = Proxy.revocable({ toolSurface }, {});
    revokedInput.revoke();
    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(
      revokedInput.proxy as Parameters<typeof buildEffectiveToolSurfaceHostBindingSnapshot>[0],
    )).toThrow("Effective tool-surface host-binding input could not be inspected");

    const revokedObservations = Proxy.revocable({ app_connector: "absent" as const }, {});
    revokedObservations.revoke();
    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot({
      toolSurface,
      classObservations: revokedObservations.proxy,
    })).toThrow("Tool-class observations could not be inspected");
  });
});
