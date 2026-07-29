import { describe, expect, test } from "bun:test";
import {
  buildEffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceSnapshotInput,
  type ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import {
  EFFECTIVE_TOOL_SURFACE_EVENT_TYPE,
  recordEffectiveToolSurfaceEvent,
} from "../src/effective-tool-surface-events.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { createWorkRun } from "../src/runs.ts";
import { StensiblyStore } from "../src/store.ts";

const runner = { id: "agent:surface", name: "Surface Runner", kind: "agent" as const };
const supervisor = { id: "service:surface", name: "Surface Supervisor", kind: "service" as const };
const required = [
  { class: "native_core", id: "shell.exec" },
  { class: "app_connector", id: "github.read" },
  { class: "configured_mcp", id: "stensibly.get_brief" },
] as const;

const fullClasses = {
  native_core: toolClass(["shell.exec"], "host:native:private-build"),
  host_dynamic: toolClass(["web.search"], "host:dynamic:private-build"),
  app_connector: toolClass(["github.read"], "connector:github:workspace-secret"),
  configured_mcp: toolClass(["stensibly.get_brief"], "mcp:stensibly:private-endpoint"),
  discovery: toolClass(["tool_search"], "host:discovery:private-build"),
} as const;

describe("durable effective tool-surface events", () => {
  test("records one content-minimised event and replays the exact snapshot", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const ledger = new SqliteWorkLedger(store);
      const item = store.createItem({
        project: "orchestration",
        kind: "task",
        title: "Observe the runner surface",
        summary: "Keep tool disappearance evidence after the chat vanishes.",
        nextAction: "Persist one bounded observation.",
        priority: 85,
        actor: supervisor,
      });
      const run = createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "chatgpt",
        runnerProfile: "gpt-5.6-thinking",
        externalRunId: "private-chat-reference",
        leaseSeconds: 300,
      }, new Date("2026-07-29T20:00:00.000Z"));
      const snapshot = buildSnapshot(run.id, run.generation, {
        snapshotId: "surface_durable_1",
        externalSurfaceRef: "chatgpt:private/thread/secret-123",
        traceId: "trace_surface_1",
      });

      const first = await recordEffectiveToolSurfaceEvent({
        ledger,
        run,
        snapshot,
        actor: runner,
      });
      const replay = await recordEffectiveToolSurfaceEvent({
        ledger,
        run,
        snapshot,
        actor: runner,
      });
      const detail = await ledger.getItem(item.id);
      const events = detail.events.filter((event) => event.type === EFFECTIVE_TOOL_SURFACE_EVENT_TYPE);

      expect(replay).toEqual(first);
      expect(events).toHaveLength(1);
      expect(first).toMatchObject({
        itemId: item.id,
        actorId: runner.id,
        type: EFFECTIVE_TOOL_SURFACE_EVENT_TYPE,
      });
      expect(first.payload).toMatchObject({
        version: 1,
        run: {
          id: run.id,
          itemId: item.id,
          generation: run.generation,
          runnerType: "chatgpt",
          runnerProfile: "gpt-5.6-thinking",
        },
        observation: {
          snapshotId: "surface_durable_1",
          transition: "new",
          traceId: "trace_surface_1",
        },
        reconciliation: {
          state: "healthy",
          dispatchDecision: "allow",
          consequentialCallsAllowed: true,
        },
        evidencePolicy: {
          containsCapabilityDisplayNames: false,
          containsRawProvenance: false,
          containsExternalSurfaceReference: false,
          containsSecrets: false,
          requiredCapabilityIdsIncluded: true,
          historicalCallsProveCurrentBinding: false,
        },
      });

      const serialized = JSON.stringify(first.payload);
      expect(serialized).not.toContain("Private display name");
      expect(serialized).not.toContain("workspace-secret");
      expect(serialized).not.toContain("private-endpoint");
      expect(serialized).not.toContain("secret-123");
      expect(serialized).toContain("externalSurfaceRefDigest");
      expect(serialized).toContain("github.read");
    } finally {
      store.close();
    }
  });

  test("persists degradation and recovery without exposing non-required capability IDs", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const ledger = new SqliteWorkLedger(store);
      const item = store.createItem({
        project: "orchestration",
        kind: "task",
        title: "Recover a poisoned tool surface",
        priority: 80,
        actor: supervisor,
      });
      const run = createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "chatgpt",
        runnerProfile: "gpt-5.6-thinking",
        leaseSeconds: 300,
      }, new Date("2026-07-29T21:00:00.000Z"));
      const previous = buildSnapshot(run.id, run.generation, {
        snapshotId: "surface_before_loss",
        observedAt: "2026-07-29T21:00:00.000Z",
        classes: {
          ...fullClasses,
          host_dynamic: toolClass(
            ["web.search", "private.experimental.tool"],
            "host:dynamic:private-build",
          ),
        },
      });
      const degraded = buildSnapshot(run.id, run.generation, {
        snapshotId: "surface_after_loss",
        transition: "compact",
        observedAt: "2026-07-29T21:01:00.000Z",
        classes: {
          ...fullClasses,
          host_dynamic: toolClass([], "host:dynamic:private-build"),
          app_connector: catalogueOnly(["github.read"], "connector:github:workspace-secret"),
        },
        recoveryActions: ["fork_with_current_tools"],
      });

      const event = await recordEffectiveToolSurfaceEvent({
        ledger,
        run,
        snapshot: degraded,
        previousSnapshot: previous,
      });
      const payload = event.payload as {
        reconciliation: Record<string, unknown>;
        requirements: Record<string, unknown>;
      };

      expect(payload.reconciliation).toMatchObject({
        state: "degraded",
        degradedClasses: ["app_connector"],
        dispatchDecision: "block_or_reroute",
        consequentialCallsAllowed: false,
        recommendedRecoveryAction: "fork_with_current_tools",
      });
      expect(payload.requirements).toMatchObject({
        missing: [{ class: "app_connector", id: "github.read" }],
        catalogueOnly: [{ class: "app_connector", id: "github.read" }],
      });
      expect(JSON.stringify(event.payload)).not.toContain("private.experimental.tool");
      expect(JSON.stringify(payload.reconciliation)).toContain("missingSincePrevious");
    } finally {
      store.close();
    }
  });

  test("rejects snapshots that are not bound to the durable run", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const ledger = new SqliteWorkLedger(store);
      const item = store.createItem({
        project: "orchestration",
        kind: "task",
        title: "Reject detached evidence",
        priority: 70,
        actor: supervisor,
      });
      const run = createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "chatgpt",
        runnerProfile: "gpt-5.6-thinking",
        leaseSeconds: 300,
      }, new Date("2026-07-29T22:00:00.000Z"));

      await expect(recordEffectiveToolSurfaceEvent({
        ledger,
        run,
        snapshot: buildSnapshot("run_other", run.generation),
      })).rejects.toThrow("run ID does not match");
      await expect(recordEffectiveToolSurfaceEvent({
        ledger,
        run,
        snapshot: buildSnapshot(run.id, run.generation + 1),
      })).rejects.toThrow("generation does not match");
      await expect(recordEffectiveToolSurfaceEvent({
        ledger,
        run,
        snapshot: buildEffectiveToolSurfaceSnapshot({
          ...snapshotInput(run.id, run.generation),
          runnerAdapter: "other-runner",
        }),
      })).rejects.toThrow("adapter does not match");
    } finally {
      store.close();
    }
  });
});

function buildSnapshot(
  runId: string,
  runGeneration: number,
  overrides: Partial<EffectiveToolSurfaceSnapshotInput> = {},
) {
  return buildEffectiveToolSurfaceSnapshot({
    ...snapshotInput(runId, runGeneration),
    ...overrides,
  });
}

function snapshotInput(
  runId: string,
  runGeneration: number,
): EffectiveToolSurfaceSnapshotInput {
  return {
    snapshotId: "surface_default",
    runnerAdapter: "chatgpt",
    runnerVersion: "2026.07.29",
    clientProduct: "ChatGPT",
    clientBuild: "web-2026.07.29",
    modelProfile: "gpt-5.6-thinking",
    externalSurfaceRef: "chatgpt:thread:544",
    runId,
    runGeneration,
    transport: "websocket",
    transition: "new",
    classes: fullClasses,
    requiredCapabilities: required,
    recoveryActions: [],
    observedAt: "2026-07-29T20:00:00.000Z",
    traceId: "trace_default",
  };
}

function toolClass(ids: readonly string[], provenance: string): ToolSurfaceClassInput {
  return {
    catalogue: ids.map((id) => ({ id, name: "Private display name" })),
    executable: ids.map((id) => ({ id, name: "Private display name" })),
    provenance: [provenance],
  };
}

function catalogueOnly(ids: readonly string[], provenance: string): ToolSurfaceClassInput {
  return {
    catalogue: ids.map((id) => ({ id, name: "Private display name" })),
    executable: [],
    provenance: [provenance],
  };
}
