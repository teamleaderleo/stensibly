import { describe, expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
  reconcileEffectiveToolSurfaceHostBinding,
  type EffectiveToolSurfaceHostBindingSnapshot,
  type EffectiveToolSurfaceHostBindingSnapshotInput,
} from "../src/effective-tool-surface-host-binding.ts";

function input(snapshotId: string): EffectiveToolSurfaceHostBindingSnapshotInput {
  return {
    toolSurface: {
      snapshotId,
      runnerAdapter: "chatgpt",
      runnerVersion: "2026.08.08",
      clientProduct: "ChatGPT",
      clientBuild: "web-2026.08.08",
      modelProfile: "gpt-5.6-sol",
      externalSurfaceRef: "chatgpt:thread:1195",
      runId: `run_${snapshotId}`,
      runGeneration: 1,
      transport: "host-registry",
      transition: "resume",
      classes: {
        native_core: {
          executable: [{ id: "shell.exec" }],
          provenance: ["host:test"],
        },
      },
      requiredCapabilities: [
        { class: "native_core", id: "shell.exec" },
      ],
      recoveryActions: ["resume_with_current_tools", "reconnect"],
      observedAt: "2026-08-08T00:00:00Z",
      traceId: `trace_${snapshotId}`,
    },
    classObservations: {
      native_core: "present",
    },
  };
}

function fixedInspectionMessage(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Effective tool-surface host-binding snapshot inspection failed",
  );
}

describe("effective tool-surface host-binding reconciliation boundary", () => {
  test("reconciles genuine compiler-produced snapshots", () => {
    const previous = buildEffectiveToolSurfaceHostBindingSnapshot(input("previous"));
    const current = buildEffectiveToolSurfaceHostBindingSnapshot(input("current"));

    const result = reconcileEffectiveToolSurfaceHostBinding(current, previous);
    expect(result.dispatchDecision).toBe("allow");
    expect(result.serverContractHealthInferred).toBe(false);
    expect(result.historicalCallsProveCurrentBinding).toBe(false);
  });

  test("does not execute wrapper get or ownKeys traps during reconciliation", () => {
    const previous = buildEffectiveToolSurfaceHostBindingSnapshot(input("previous"));
    const current = buildEffectiveToolSurfaceHostBindingSnapshot(input("current"));
    let getCalls = 0;
    let ownKeysCalls = 0;
    const wrapped = new Proxy(current, {
      get() {
        getCalls += 1;
        throw new Error("snapshot get must remain unreachable");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("snapshot ownKeys must remain unreachable");
      },
    });

    let caught: unknown;
    try {
      reconcileEffectiveToolSurfaceHostBinding(
        wrapped as EffectiveToolSurfaceHostBindingSnapshot,
        previous,
      );
    } catch (error) {
      caught = error;
    }

    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
    if (caught !== undefined) fixedInspectionMessage(caught);
  });

  test("normalizes a revoked snapshot before private reconciliation", () => {
    const previous = buildEffectiveToolSurfaceHostBindingSnapshot(input("previous"));
    const current = buildEffectiveToolSurfaceHostBindingSnapshot(input("current"));
    const revoked = Proxy.revocable(current, {});
    revoked.revoke();

    let caught: unknown;
    try {
      reconcileEffectiveToolSurfaceHostBinding(
        revoked.proxy as EffectiveToolSurfaceHostBindingSnapshot,
        previous,
      );
    } catch (error) {
      caught = error;
    }

    fixedInspectionMessage(caught);
  });
});
