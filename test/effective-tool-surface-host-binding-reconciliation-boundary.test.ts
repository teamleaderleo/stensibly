import { describe, expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
  reconcileEffectiveToolSurfaceHostBinding,
} from "../src/effective-tool-surface-host-binding.ts";

const input = {
  toolSurface: {
    snapshotId: "host_reconciliation_boundary",
    runnerAdapter: "adapter",
    runnerVersion: "1",
    clientProduct: "chatgpt",
    runId: "run_boundary",
    runGeneration: 1,
    transport: "mcp",
    transition: "new" as const,
    classes: {
      native_core: { executable: [] },
    },
    observedAt: "2026-08-07T18:00:00.000Z",
  },
};

const fixedInspectionError =
  "Effective tool-surface host-binding reconciliation input inspection failed";

describe("effective tool-surface host-binding reconciliation boundary", () => {
  test("does not execute caller get or ownKeys while admitting a wrapped snapshot", () => {
    const snapshot = buildEffectiveToolSurfaceHostBindingSnapshot(input);
    const baseline = reconcileEffectiveToolSurfaceHostBinding(snapshot);
    let getCalls = 0;
    let ownKeysCalls = 0;
    const wrapped = new Proxy(snapshot, {
      get() {
        getCalls += 1;
        throw new Error("reconciliation get trap must not execute");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("reconciliation ownKeys trap must not execute");
      },
    });

    let result: unknown;
    let caught: unknown;
    try {
      result = reconcileEffectiveToolSurfaceHostBinding(wrapped);
    } catch (error) {
      caught = error;
    }

    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(fixedInspectionError);
    } else {
      expect(result).toEqual(baseline);
    }
  });

  test("normalizes revoked reconciliation snapshots to a fixed inspection error", () => {
    const snapshot = buildEffectiveToolSurfaceHostBindingSnapshot(input);
    const { proxy, revoke } = Proxy.revocable(snapshot, {});
    revoke();

    expect(() => reconcileEffectiveToolSurfaceHostBinding(proxy))
      .toThrow(fixedInspectionError);
  });
});
