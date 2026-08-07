import { describe, expect, test } from "bun:test";
import type {
  EffectiveToolSurfaceSnapshotInput,
  ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
  type EffectiveToolSurfaceHostBindingSnapshotInput,
} from "../src/effective-tool-surface-host-binding.ts";

function toolClass(ids: readonly string[]): ToolSurfaceClassInput {
  return {
    executable: ids.map((id) => ({ id })),
    provenance: ["host:test"],
  };
}

function input(): EffectiveToolSurfaceHostBindingSnapshotInput {
  return {
    toolSurface: {
      snapshotId: "host_binding_boundary",
      runnerAdapter: "chatgpt",
      runnerVersion: "2026.08.08",
      clientProduct: "ChatGPT",
      clientBuild: "web-2026.08.08",
      modelProfile: "gpt-5.6-sol",
      externalSurfaceRef: "chatgpt:thread:1195",
      runId: "run_1195_boundary",
      runGeneration: 1,
      transport: "host-registry",
      transition: "new",
      classes: {
        native_core: toolClass(["shell.exec"]),
        app_connector: { executable: [] },
      },
      requiredCapabilities: [
        { class: "app_connector", id: "stensibly.get_brief" },
      ],
      recoveryActions: ["refresh_catalogue", "reconnect"],
      observedAt: "2026-08-08T00:00:00Z",
      traceId: "trace_1195_boundary",
    },
    classObservations: {
      app_connector: "present",
    },
  };
}

describe("effective tool-surface host-binding caller admission", () => {
  test("does not invoke caller get or ownKeys traps", () => {
    let getCalls = 0;
    let ownKeysCalls = 0;
    const base = input();
    const toolSurface = new Proxy(base.toolSurface, {
      get() {
        getCalls += 1;
        throw new Error("caller get must not run");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must not run");
      },
    });
    const hostile = new Proxy({ ...base, toolSurface }, {
      get() {
        getCalls += 1;
        throw new Error("caller get must not run");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must not run");
      },
    });

    const result = buildEffectiveToolSurfaceHostBindingSnapshot(hostile);
    expect(result.toolSurface.snapshotId).toBe("host_binding_boundary");
    expect(result.classObservations.app_connector.observation).toBe("present");
    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  test("normalizes revoked top-level, tool-surface, class, and capability inputs", () => {
    const top = Proxy.revocable(input(), {});
    top.revoke();
    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(
      top.proxy as EffectiveToolSurfaceHostBindingSnapshotInput,
    )).toThrow("Effective tool-surface host-binding input inspection failed");

    const withToolSurface = input();
    const toolSurface = Proxy.revocable(withToolSurface.toolSurface, {});
    toolSurface.revoke();
    Object.defineProperty(withToolSurface, "toolSurface", {
      value: toolSurface.proxy,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(withToolSurface))
      .toThrow("Effective tool-surface host-binding input inspection failed");

    const withClass = input();
    const classTarget = (withClass.toolSurface.classes as Record<string, unknown>)
      .native_core as object;
    const classValue = Proxy.revocable(classTarget, {});
    classValue.revoke();
    (withClass.toolSurface.classes as Record<string, unknown>).native_core = classValue.proxy;
    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(withClass))
      .toThrow("Effective tool-surface host-binding input inspection failed");

    const withCapability = input();
    const native = (withCapability.toolSurface.classes as Record<string, ToolSurfaceClassInput>)
      .native_core!;
    const capability = Proxy.revocable(native.executable[0]!, {});
    capability.revoke();
    (native as { executable: unknown[] }).executable = [capability.proxy];
    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(withCapability))
      .toThrow("Effective tool-surface host-binding input inspection failed");
  });

  test("rejects accessor-bearing nested fields without invoking getters", () => {
    let getterCalls = 0;
    const value = input();
    const native = (value.toolSurface.classes as Record<string, ToolSurfaceClassInput>)
      .native_core! as Record<string, unknown>;
    Object.defineProperty(native, "executable", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [{ id: "shell.exec" }];
      },
    });

    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(value))
      .toThrow("Effective tool-surface host-binding input inspection failed");
    expect(getterCalls).toBe(0);
  });

  test("checks capability array length before entry inspection", () => {
    let ownKeysCalls = 0;
    const value = input();
    const oversized = new Array(1001).fill({ id: "shell.exec" });
    const proxied = new Proxy(oversized, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("oversized ownKeys must not run");
      },
    });
    const native = (value.toolSurface.classes as Record<string, ToolSurfaceClassInput>)
      .native_core!;
    (native as { executable: unknown[] }).executable = proxied;

    expect(() => buildEffectiveToolSurfaceHostBindingSnapshot(value))
      .toThrow("Effective tool-surface host-binding input inspection exceeded its limit");
    expect(ownKeysCalls).toBe(0);
  });

  test("discards caller decorations without changing class-presence compatibility", () => {
    const value = input();
    Object.defineProperty(value.toolSurface.classes, "decoration", {
      value: "ignored",
      enumerable: true,
      configurable: true,
    });
    const native = (value.toolSurface.classes as Record<string, ToolSurfaceClassInput>)
      .native_core! as Record<string, unknown>;
    native.decoration = "ignored";

    const result = buildEffectiveToolSurfaceHostBindingSnapshot(value);
    expect(result.classObservations.native_core.observation).toBe("present");
    expect(result.classObservations.configured_mcp.observation).toBe("unobserved");
  });

  test("only the public host-binding module imports the private base", async () => {
    const allowed = new Set(["src/effective-tool-surface-host-binding.ts"]);
    const sourceFiles = Array.from(
      new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
    );
    for (const path of sourceFiles) {
      const source = await Bun.file(path).text();
      if (source.includes("effective-tool-surface-host-binding-base.js")) {
        expect(allowed.has(path), path).toBe(true);
      }
    }
  });
});
