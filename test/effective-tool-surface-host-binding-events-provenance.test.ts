import { describe, expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
} from "../src/effective-tool-surface-host-binding.ts";
import {
  recordEffectiveToolSurfaceHostBindingEvent,
} from "../src/effective-tool-surface-host-binding-events.ts";

describe("durable host-binding snapshot provenance", () => {
  test("rejects a wrapped snapshot before caller traps or ledger publication", async () => {
    const actor = {
      id: "agent:provenance-control",
      name: "Provenance Control",
      kind: "agent" as const,
    };
    const run = {
      id: "run_host_binding_provenance",
      itemId: "item_host_binding_provenance",
      actorId: actor.id,
      generation: 1,
      runnerType: "chatgpt",
      runnerProfile: "gpt-5.6-sol",
    };
    const snapshot = buildEffectiveToolSurfaceHostBindingSnapshot({
      toolSurface: {
        snapshotId: "host_binding_provenance",
        runnerAdapter: "chatgpt",
        runnerVersion: "2026.08.08",
        clientProduct: "ChatGPT",
        clientBuild: "web-2026.08.08",
        modelProfile: "gpt-5.6-sol",
        runId: run.id,
        runGeneration: run.generation,
        transport: "host-registry",
        transition: "new",
        classes: {
          app_connector: { executable: [] },
        },
        requiredCapabilities: [{
          class: "app_connector",
          id: "stensibly.get_brief",
        }],
        recoveryActions: ["refresh_catalogue", "reconnect"],
        observedAt: "2026-08-08T00:00:00Z",
      },
      classObservations: { app_connector: "present" },
    });

    let getCalls = 0;
    let ownKeysCalls = 0;
    let recordEventCalls = 0;
    const wrapped = new Proxy(snapshot, {
      get() {
        getCalls += 1;
        throw new Error("snapshot wrapper get must remain unreachable");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("snapshot wrapper ownKeys must remain unreachable");
      },
    });
    const ledger = {
      async recordEvent() {
        recordEventCalls += 1;
        throw new Error("ledger publication must remain unreachable");
      },
    };

    await expect(recordEffectiveToolSurfaceHostBindingEvent({
      ledger: ledger as Parameters<typeof recordEffectiveToolSurfaceHostBindingEvent>[0]["ledger"],
      run: run as Parameters<typeof recordEffectiveToolSurfaceHostBindingEvent>[0]["run"],
      snapshot: wrapped,
      actor,
    })).rejects.toThrow(
      "Effective tool-surface host-binding snapshot inspection failed",
    );

    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
    expect(recordEventCalls).toBe(0);
  });
});
