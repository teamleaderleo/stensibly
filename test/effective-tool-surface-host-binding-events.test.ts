import { describe, expect, test } from "bun:test";
import type {
  EffectiveToolSurfaceSnapshotInput,
  ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot,
  type EffectiveToolSurfaceHostBindingSnapshot,
} from "../src/effective-tool-surface-host-binding.ts";
import {
  EFFECTIVE_TOOL_SURFACE_HOST_BINDING_EVENT_TYPE,
  recordEffectiveToolSurfaceHostBindingEvent,
} from "../src/effective-tool-surface-host-binding-events.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { createWorkRun } from "../src/runs.ts";
import { StensiblyStore } from "../src/store.ts";

const runner = {
  id: "agent:host-binding",
  name: "Host Binding Runner",
  kind: "agent" as const,
};
const otherRunner = {
  id: "agent:other-host-binding",
  name: "Other Host Binding Runner",
  kind: "agent" as const,
};
const supervisor = {
  id: "service:host-binding",
  name: "Host Binding Supervisor",
  kind: "service" as const,
};
const requiredApp = [
  { class: "app_connector", id: "stensibly.get_brief" },
] as const;
const nativeCore = toolClass(["shell.exec"], "host:native:private-build");

function toolClass(
  ids: readonly string[],
  provenance: string,
): ToolSurfaceClassInput {
  return {
    catalogue: ids.map((id) => ({ id, name: "Private capability name" })),
    executable: ids.map((id) => ({ id, name: "Private capability name" })),
    provenance: [provenance],
  };
}

describe("durable effective tool-surface host-binding events", () => {
  test("persists present-empty to absent even when the v1 capability surface is unchanged", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const ledger = new SqliteWorkLedger(store);
      const item = store.createItem({
        project: "orchestration",
        kind: "task",
        title: "Preserve host binding loss",
        summary: "Keep namespace disappearance evidence after the chat is gone.",
        nextAction: "Persist bounded host-binding observations.",
        priority: 95,
        actor: supervisor,
      });
      const run = createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "chatgpt",
        runnerProfile: "gpt-5.6-sol",
        externalRunId: "private-chat-reference",
        leaseSeconds: 300,
      }, new Date("2026-08-08T00:00:00.000Z"));

      const previous = hostSnapshot(run.id, run.generation, {
        snapshotId: "host_present_empty",
        observedAt: "2026-08-08T00:00:01.000Z",
        classes: {
          native_core: nativeCore,
          app_connector: {
            executable: [],
            provenance: ["host:namespace-present:private-workspace"],
          },
        },
        requiredCapabilities: requiredApp,
        recoveryActions: ["refresh_catalogue", "reconnect", "restart"],
      });
      const absent = hostSnapshot(run.id, run.generation, {
        snapshotId: "host_namespace_absent",
        observedAt: "2026-08-08T00:01:00.000Z",
        transition: "reconnect",
        classes: {
          native_core: nativeCore,
          app_connector: {
            executable: [],
            provenance: ["host:namespace-absent:private-workspace"],
          },
        },
        classObservations: { app_connector: "absent" },
        requiredCapabilities: requiredApp,
        recoveryActions: ["refresh_catalogue", "reconnect", "restart"],
      });

      expect(previous.toolSurface.surfaceFingerprint)
        .toBe(absent.toolSurface.surfaceFingerprint);
      expect(previous.hostBindingFingerprint)
        .not.toBe(absent.hostBindingFingerprint);

      const first = await recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: previous,
        actor: runner,
      });
      const second = await recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: absent,
        previousSnapshot: previous,
        actor: runner,
      });
      const replay = await recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: absent,
        previousSnapshot: previous,
        actor: runner,
      });

      const detail = await ledger.getItem(item.id);
      const events = detail.events.filter(
        (event) => event.type === EFFECTIVE_TOOL_SURFACE_HOST_BINDING_EVENT_TYPE,
      );
      expect(events).toHaveLength(2);
      expect(replay).toEqual(second);
      expect(first.payload).toMatchObject({
        reconciliation: {
          state: "degraded",
          hostBindingChanged: false,
          recommendedRecoveryAction: "refresh_catalogue",
          recommendedRecoveryReason: "catalogue_present_empty",
        },
      });
      expect(second.payload).toMatchObject({
        version: 1,
        run: {
          id: run.id,
          itemId: item.id,
          actorId: runner.id,
          generation: run.generation,
          runnerType: "chatgpt",
          runnerProfile: "gpt-5.6-sol",
        },
        observation: {
          snapshotId: "host_namespace_absent",
          snapshotFingerprint: absent.snapshotFingerprint,
          hostBindingFingerprint: absent.hostBindingFingerprint,
          toolSurfaceSnapshotFingerprint: absent.toolSurface.snapshotFingerprint,
          toolSurfaceSurfaceFingerprint: absent.toolSurface.surfaceFingerprint,
          requiredFingerprint: absent.toolSurface.requiredFingerprint,
          transition: "reconnect",
          observedAt: "2026-08-08T00:01:00.000Z",
          traceId: "trace_host_binding",
        },
        classes: {
          app_connector: {
            observation: "absent",
            catalogueCount: 0,
            executableCount: 0,
            provenanceCount: 1,
          },
        },
        reconciliation: {
          state: "degraded",
          previousSnapshotId: "host_present_empty",
          hostBindingChanged: true,
          toolSurfaceChanged: false,
          classObservationChanges: [{
            class: "app_connector",
            previous: "present",
            current: "absent",
          }],
          absentClasses: ["app_connector"],
          dispatchDecision: "block_or_reroute",
          consequentialCallsAllowed: false,
          recommendedRecoveryAction: "reconnect",
          recommendedRecoveryReason: "host_binding_absent",
          serverContractHealthInferred: false,
          historicalCallsProveCurrentBinding: false,
        },
        evidencePolicy: {
          observationAuthority: "runner_report",
          reportedByActorId: runner.id,
          serverVerifiedHostBinding: false,
          serverContractHealthInferred: false,
          containsCapabilityIds: false,
          containsCapabilityDisplayNames: false,
          containsRawProvenance: false,
          containsExternalSurfaceReference: false,
          containsSecrets: false,
          historicalCallsProveCurrentBinding: false,
        },
      });

      const serialized = JSON.stringify(second.payload);
      expect(serialized).not.toContain("stensibly.get_brief");
      expect(serialized).not.toContain("Private capability name");
      expect(serialized).not.toContain("private-workspace");
      expect(serialized).not.toContain("secret-thread-reference");
    } finally {
      store.close();
    }
  });

  test("appends recovery evidence instead of rewriting the absent observation", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const ledger = new SqliteWorkLedger(store);
      const item = store.createItem({
        project: "orchestration",
        kind: "task",
        title: "Preserve host binding recovery",
        priority: 90,
        actor: supervisor,
      });
      const run = createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "chatgpt",
        runnerProfile: "gpt-5.6-sol",
        leaseSeconds: 300,
      }, new Date("2026-08-08T00:10:00.000Z"));
      const absent = hostSnapshot(run.id, run.generation, {
        snapshotId: "host_absent_before_recovery",
        observedAt: "2026-08-08T00:10:01.000Z",
        classes: {
          native_core: nativeCore,
          app_connector: { executable: [] },
        },
        classObservations: { app_connector: "absent" },
        requiredCapabilities: requiredApp,
        recoveryActions: ["reconnect", "restart"],
      });
      const recovered = hostSnapshot(run.id, run.generation, {
        snapshotId: "host_present_after_recovery",
        observedAt: "2026-08-08T00:11:00.000Z",
        transition: "reconnect",
        classes: {
          native_core: nativeCore,
          app_connector: toolClass(
            ["stensibly.get_brief"],
            "host:stensibly:private-workspace",
          ),
        },
        requiredCapabilities: requiredApp,
        recoveryActions: ["reconnect", "restart"],
      });

      await recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: absent,
        actor: runner,
      });
      const recovery = await recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: recovered,
        previousSnapshot: absent,
        actor: runner,
      });
      const detail = await ledger.getItem(item.id);
      const events = detail.events.filter(
        (event) => event.type === EFFECTIVE_TOOL_SURFACE_HOST_BINDING_EVENT_TYPE,
      );

      expect(events).toHaveLength(2);
      expect(recovery.payload).toMatchObject({
        reconciliation: {
          state: "recovered",
          hostBindingChanged: true,
          classObservationChanges: [{
            class: "app_connector",
            previous: "absent",
            current: "present",
          }],
          dispatchDecision: "allow",
          consequentialCallsAllowed: true,
          recommendedRecoveryAction: null,
          recommendedRecoveryReason: null,
        },
      });
      expect((events[0]!.payload as Record<string, unknown>))
        .not.toEqual(recovery.payload);
    } finally {
      store.close();
    }
  });

  test("rejects host-binding evidence detached from the durable run or prior observation", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const ledger = new SqliteWorkLedger(store);
      const item = store.createItem({
        project: "orchestration",
        kind: "task",
        title: "Reject detached host binding evidence",
        priority: 80,
        actor: supervisor,
      });
      const run = createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "chatgpt",
        runnerProfile: "gpt-5.6-sol",
        leaseSeconds: 300,
      }, new Date("2026-08-08T00:20:00.000Z"));
      const current = hostSnapshot(run.id, run.generation, {
        snapshotId: "host_current_binding",
        observedAt: "2026-08-08T00:21:00.000Z",
        classes: { app_connector: { executable: [] } },
        requiredCapabilities: requiredApp,
      });

      await expect(recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: current,
        actor: otherRunner,
      })).rejects.toThrow("reporter does not match");
      await expect(recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: hostSnapshot("run_other", run.generation),
        actor: runner,
      })).rejects.toThrow("run ID does not match");
      await expect(recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: hostSnapshot(run.id, run.generation + 1),
        actor: runner,
      })).rejects.toThrow("generation does not match");
      await expect(recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: hostSnapshot(run.id, run.generation, {
          runnerAdapter: "other-runner",
        }),
        actor: runner,
      })).rejects.toThrow("adapter does not match");

      const differentRequirements = hostSnapshot(run.id, run.generation, {
        snapshotId: "host_previous_different_requirements",
        observedAt: "2026-08-08T00:20:30.000Z",
        classes: { native_core: nativeCore },
        requiredCapabilities: [{ class: "native_core", id: "shell.exec" }],
      });
      await expect(recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: current,
        previousSnapshot: differentRequirements,
        actor: runner,
      })).rejects.toThrow("required-capability set changed");

      const nonChronological = hostSnapshot(run.id, run.generation, {
        snapshotId: "host_previous_not_older",
        observedAt: current.toolSurface.observedAt,
        classes: { app_connector: { executable: [] } },
        requiredCapabilities: requiredApp,
      });
      await expect(recordEffectiveToolSurfaceHostBindingEvent({
        ledger,
        run,
        snapshot: current,
        previousSnapshot: nonChronological,
        actor: runner,
      })).rejects.toThrow("chronological order");
    } finally {
      store.close();
    }
  });
});

function hostSnapshot(
  runId: string,
  runGeneration: number,
  overrides: Partial<EffectiveToolSurfaceSnapshotInput> & {
    classObservations?: Parameters<
      typeof buildEffectiveToolSurfaceHostBindingSnapshot
    >[0]["classObservations"];
  } = {},
): EffectiveToolSurfaceHostBindingSnapshot {
  const { classObservations, ...toolSurfaceOverrides } = overrides;
  return buildEffectiveToolSurfaceHostBindingSnapshot({
    toolSurface: {
      snapshotId: toolSurfaceOverrides.snapshotId ?? "host_binding_default",
      runnerAdapter: toolSurfaceOverrides.runnerAdapter ?? "chatgpt",
      runnerVersion: toolSurfaceOverrides.runnerVersion ?? "2026.08.08",
      clientProduct: toolSurfaceOverrides.clientProduct ?? "ChatGPT",
      clientBuild: toolSurfaceOverrides.clientBuild ?? "web-2026.08.08",
      modelProfile: toolSurfaceOverrides.modelProfile ?? "gpt-5.6-sol",
      externalSurfaceRef:
        toolSurfaceOverrides.externalSurfaceRef
        ?? "chatgpt:private/secret-thread-reference",
      runId,
      runGeneration,
      transport: toolSurfaceOverrides.transport ?? "host-registry",
      transition: toolSurfaceOverrides.transition ?? "new",
      classes: toolSurfaceOverrides.classes ?? {},
      requiredCapabilities: toolSurfaceOverrides.requiredCapabilities ?? [],
      recoveryActions: toolSurfaceOverrides.recoveryActions ?? [],
      observedAt:
        toolSurfaceOverrides.observedAt ?? "2026-08-08T00:20:00.000Z",
      traceId: toolSurfaceOverrides.traceId ?? "trace_host_binding",
    },
    classObservations,
  });
}
