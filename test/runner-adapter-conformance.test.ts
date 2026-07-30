import { describe, expect, test } from "bun:test";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import type {
  EffectiveToolSurfaceSnapshot,
  ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import {
  runRunnerAdapterConformanceV1,
  type RunnerAdapterConformanceScenarioV1,
} from "../src/runner-adapter-conformance.ts";
import {
  RUNNER_ADAPTER_V1,
  buildRunnerCapabilitySnapshotV1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerObservationV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerCapabilityProbeV1,
  type RunnerCheckpointCommandV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";

const adapterVersion = "1.0.0";
const profileId = "test-profile";
const profileVersion = "2026-07-31";
const runId = "run_adapter_conformance";
const itemId = "item_adapter_conformance";
const project = "scrapbook";
const correlationId = "workflow_adapter_conformance";
const checkpoint = parseRunnerExternalReferenceV1({
  version: 1,
  kind: "checkpoint",
  adapterId: "placeholder",
  externalId: "checkpoint-1",
  digest: null,
  uri: null,
  generation: 1,
  createdAt: "2026-07-31T00:00:05.000Z",
  accessClass: "project",
  containsPrivateContent: false,
  containsCredentials: false,
});

class SequentialLoopAdapter implements RunnerAdapterV1 {
  readonly descriptor: RunnerAdapterDescriptorV1;
  readonly checkpoint: RunnerExternalReferenceV1;
  private snapshots = new Map<string, EffectiveToolSurfaceSnapshot>();

  constructor(readonly adapterId: string) {
    this.descriptor = descriptor(adapterId);
    this.checkpoint = reference(checkpoint, adapterId);
  }

  describe(): RunnerAdapterDescriptorV1 {
    return this.descriptor;
  }

  async inspectCapabilities(
    input: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot> {
    const probe = parseRunnerCapabilityProbeV1(input);
    const snapshot = buildRunnerCapabilitySnapshotV1(
      probe,
      capabilityClasses(probe.transition === "resume"),
    );
    this.snapshots.set(probe.transition, snapshot);
    return snapshot;
  }

  async *start(input: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1> {
    yield observation(input, "start_accepted", 2);
    yield observation(input, "execution_started", 3);
    yield observation(input, "tool_surface_observed", 4, {
      snapshot: requiredSnapshot(this.snapshots, "new"),
    });
    yield observation(input, "work_step", 5, {
      phase: "analysis",
      summary: "Inspected the bounded runner context.",
    });
    yield observation(input, "checkpoint_published", 6, {
      reference: this.checkpoint,
    });
    yield observation(input, "interrupted", 7, {
      code: "simulated_disconnect",
      message: "The fake transport disconnected after publishing a checkpoint.",
      checkpointRef: this.checkpoint,
      recoveryAction: "resume",
      remoteSettlementKnown: false,
    });
  }

  async *resume(input: RunnerResumeCommandV1): AsyncIterable<RunnerObservationV1> {
    yield observation(input, "resume_accepted", 2);
    yield observation(input, "execution_started", 3);
    yield observation(input, "tool_surface_observed", 4, {
      snapshot: requiredSnapshot(this.snapshots, "resume"),
    });
    yield observation(input, "heartbeat", 5, {
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        toolCalls: 2,
        childAgents: 0,
      },
      checkpointRef: this.checkpoint,
    });
    yield observation(input, "artifact_published", 6, {
      reference: externalReference(this.adapterId, "artifact", "artifact-1", 1),
    });
    yield observation(input, "completion_proposed", 7, {
      outcome: "The fake runner completed the conformance objective.",
      executionActual: {
        durationMinutes: 12,
        toolCalls: 2,
        filesChanged: 1,
      },
    });
  }

  async requestCheckpoint(
    _input: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1> {
    return this.checkpoint;
  }

  async requestCancellation(
    input: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    return {
      version: 1,
      commandId: input.commandId,
      adapterId: this.adapterId,
      adapterVersion,
      profileId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      leaseGeneration: input.leaseGeneration,
      observedAt: input.requestedAt,
      requestAccepted: true,
      deliveryKnown: false,
      remoteSettlementKnown: false,
      reference: null,
    };
  }
}

class ResumableGraphAdapter extends SequentialLoopAdapter {
  private readonly graph = {
    start: ["start_accepted", "execution_started", "tool_surface_observed", "work_step", "checkpoint_published", "interrupted"],
    resume: ["resume_accepted", "execution_started", "tool_surface_observed", "heartbeat", "artifact_published", "completion_proposed"],
  } as const;

  override async *start(
    input: RunnerStartCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    for (const [index, node] of this.graph.start.entries()) {
      yield this.graphObservation(input, node, index + 2, "new");
    }
  }

  override async *resume(
    input: RunnerResumeCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    for (const [index, node] of this.graph.resume.entries()) {
      yield this.graphObservation(input, node, index + 2, "resume");
    }
  }

  private graphObservation(
    input: RunnerStartCommandV1 | RunnerResumeCommandV1,
    node: typeof this.graph.start[number] | typeof this.graph.resume[number],
    second: number,
    transition: "new" | "resume",
  ): RunnerObservationV1 {
    switch (node) {
      case "tool_surface_observed":
        return observation(input, node, second, {
          snapshot: requiredSnapshot(
            (this as unknown as { snapshots: Map<string, EffectiveToolSurfaceSnapshot> }).snapshots,
            transition,
          ),
        });
      case "work_step":
        return observation(input, node, second, {
          phase: "graph_node",
          summary: "Executed the private graph analysis node.",
        });
      case "checkpoint_published":
        return observation(input, node, second, { reference: this.checkpoint });
      case "interrupted":
        return observation(input, node, second, {
          code: "simulated_disconnect",
          message: "The fake graph paused after a durable checkpoint.",
          checkpointRef: this.checkpoint,
          recoveryAction: "resume",
          remoteSettlementKnown: false,
        });
      case "heartbeat":
        return observation(input, node, second, {
          usage: {
            inputTokens: 120,
            outputTokens: 80,
            toolCalls: 2,
            childAgents: 0,
          },
          checkpointRef: this.checkpoint,
        });
      case "artifact_published":
        return observation(input, node, second, {
          reference: externalReference(this.adapterId, "artifact", "artifact-1", 1),
        });
      case "completion_proposed":
        return observation(input, node, second, {
          outcome: "The fake graph completed the conformance objective.",
          executionActual: {
            durationMinutes: 12,
            toolCalls: 2,
            filesChanged: 1,
          },
        });
      default:
        return observation(input, node, second);
    }
  }
}

describe("runner-adapter v1 conformance", () => {
  test("validates compact descriptors and content-minimised references", () => {
    const value = descriptor("loop-adapter");
    expect(value.version).toBe(1);
    expect(value.supports.start).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.profiles)).toBe(true);

    expect(() => parseRunnerExternalReferenceV1({
      ...externalReference("loop-adapter", "trace", "trace-1", null),
      externalId: "Bearer secret-value",
    })).toThrow("credential-shaped text");
    expect(() => parseRunnerExternalReferenceV1({
      ...externalReference("loop-adapter", "trace", "trace-1", null),
      containsPrivateContent: true,
    })).toThrow("exclude private content and credentials");
  });

  test("accepts sequential-loop and resumable-graph styles through one report", async () => {
    const reports = [];
    for (const adapter of [
      new SequentialLoopAdapter("loop-adapter"),
      new ResumableGraphAdapter("graph-adapter"),
    ]) {
      const scenario = conformanceScenario(adapter.adapterId, adapter.checkpoint);
      const report = await runRunnerAdapterConformanceV1(adapter, scenario);
      reports.push(report);

      expect(report.passed).toBe(true);
      expect(report.startCapabilityState).toBe("healthy");
      expect(report.resumeCapabilityState).toBe("changed");
      expect(report.resumeDispatchDecision).toBe("allow");
      expect(report.start.observationTypes).toEqual([
        "start_accepted",
        "execution_started",
        "tool_surface_observed",
        "work_step",
        "checkpoint_published",
        "interrupted",
      ]);
      expect(report.resume.observationTypes).toEqual([
        "resume_accepted",
        "execution_started",
        "tool_surface_observed",
        "heartbeat",
        "artifact_published",
        "completion_proposed",
      ]);
      expect(report.start.replayIdempotent).toBe(true);
      expect(report.start.conflictingReplayRejected).toBe(true);
      expect(report.start.staleGenerationRejected).toBe(true);
      expect(report.canonicalRunPreserved).toBe(true);
      expect(report.durableTransitionsAppliedByAdapter).toBe(false);
      expect(report.executionCertaintyImplemented).toBe(false);
      expect(report.authoritativeSettlementImplemented).toBe(false);
      expect(report.sideEffectsPerformed).toBe(false);
      expect(report.evidenceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    expect(reports[0]!.start.observationTypes).toEqual(
      reports[1]!.start.observationTypes,
    );
    expect(reports[0]!.resume.observationTypes).toEqual(
      reports[1]!.resume.observationTypes,
    );
  });

  test("rejects adapter observations that claim durable transitions", () => {
    const command = startCommand("loop-adapter");
    expect(() => parseRunnerObservationV1({
      ...observation(command, "start_accepted", 2),
      durableTransitionApplied: true,
    })).toThrow("cannot apply durable transitions");
  });

  test("rejects a completion callback before checkpointed interruption and resume", async () => {
    class PrematureAdapter extends SequentialLoopAdapter {
      override async *start(
        input: RunnerStartCommandV1,
      ): AsyncIterable<RunnerObservationV1> {
        yield observation(input, "start_accepted", 2);
        yield observation(input, "execution_started", 3);
        yield observation(input, "completion_proposed", 4, {
          outcome: "Premature completion",
          executionActual: {},
        });
      }
    }

    const adapter = new PrematureAdapter("premature-adapter");
    await expect(
      runRunnerAdapterConformanceV1(
        adapter,
        conformanceScenario(adapter.adapterId, adapter.checkpoint),
      ),
    ).rejects.toThrow("missing ordered checkpoint_published");
  });
});

function descriptor(adapterId: string): RunnerAdapterDescriptorV1 {
  return parseRunnerAdapterDescriptorV1({
    version: 1,
    adapterId,
    adapterVersion,
    profiles: [{ id: profileId, version: profileVersion }],
    transports: ["memory"],
    checkpointMode: "external_reference",
    cancellationMode: "best_effort",
    supports: {
      start: true,
      resume: true,
      capabilityInspection: true,
      streamingObservations: true,
      durableReplay: true,
      usageReferences: true,
      traceReferences: true,
    },
  });
}

function startCommand(adapterId: string): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase(adapterId, "command-start", "2026-07-31T00:00:00.000Z"),
    kind: "start",
  });
}

function resumeCommand(
  adapterId: string,
  checkpointRef: RunnerExternalReferenceV1,
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase(adapterId, "command-resume", "2026-07-31T00:10:00.000Z"),
    kind: "resume",
    continuation: { id: "continuation-1", generation: 1 },
    adapterResumeRef: externalReference(
      adapterId,
      "continuation",
      "resume-token-1",
      1,
      "2026-07-31T00:00:06.000Z",
    ),
    checkpointRef,
    reason: "continuation",
  });
}

function commandBase(
  adapterId: string,
  commandId: string,
  issuedAt: string,
) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId,
    correlationId,
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "runner-actor",
      generation: 1,
      expiresAt: "2026-07-31T01:00:00.000Z",
    },
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove the framework-neutral runner adapter contract.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Prove the framework-neutral runner adapter contract.",
        summary: null,
        nextAction: "Run the shared conformance scenario.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: [`item:${itemId}`],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 512,
    },
    requiredCapabilities: [
      { class: "native_core", id: "shell" },
      { class: "configured_mcp", id: "stensibly" },
    ],
    capabilityGrantRefs: ["grant:test-runner"],
    issuedAt,
  };
}

function conformanceScenario(
  adapterId: string,
  checkpointRef: RunnerExternalReferenceV1,
): RunnerAdapterConformanceScenarioV1 {
  return {
    version: 1,
    scenarioId: `scenario-${adapterId}`,
    suiteVersion: "1.0.0",
    startCommand: startCommand(adapterId),
    startProbe: probe(
      adapterId,
      "probe-start",
      "new",
      "2026-07-31T00:00:01.000Z",
    ),
    resumeCommand: resumeCommand(adapterId, checkpointRef),
    resumeProbe: probe(
      adapterId,
      "probe-resume",
      "resume",
      "2026-07-31T00:10:01.000Z",
    ),
    expect: {
      startCapabilityState: "healthy",
      resumeCapabilityState: "changed",
      resumeDispatchDecision: "allow",
    },
  };
}

function probe(
  adapterId: string,
  probeId: string,
  transition: "new" | "resume",
  observedAt: string,
): RunnerCapabilityProbeV1 {
  return parseRunnerCapabilityProbeV1({
    version: 1,
    probeId,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    transition,
    clientProduct: "fake-conformance",
    clientBuild: "1.0.0",
    modelProfile: "fake-model",
    externalSurfaceRef: `surface:${adapterId}`,
    requiredCapabilities: [
      { class: "native_core", id: "shell" },
      { class: "configured_mcp", id: "stensibly" },
    ],
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: `trace-${probeId}`,
  });
}

function capabilityClasses(
  resumed: boolean,
): Partial<Record<string, ToolSurfaceClassInput>> {
  return {
    native_core: {
      executable: [{ id: "shell", name: "Shell" }],
      provenance: ["fake:core"],
    },
    configured_mcp: {
      executable: [{ id: "stensibly", name: "Stensibly" }],
      provenance: ["fake:mcp"],
    },
    ...(resumed
      ? {
        app_connector: {
          executable: [{ id: "github", name: "GitHub" }],
          provenance: ["fake:connector"],
        },
      }
      : {}),
  };
}

function observation(
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  type: RunnerObservationV1["type"],
  second: number,
  payload: Record<string, unknown> = {},
): RunnerObservationV1 {
  return parseRunnerObservationV1({
    version: 1,
    type,
    observationId: `${command.commandId}.${type}.${second}`,
    commandId: command.commandId,
    correlationId: command.correlationId,
    adapterId: command.adapterId,
    adapterVersion: command.adapterVersion,
    profileId: command.profileId,
    profileVersion: command.profileVersion,
    runId: command.runId,
    runGeneration: command.runGeneration,
    leaseGeneration: command.leaseGeneration,
    observedAt: command.kind === "start"
      ? `2026-07-31T00:00:${String(second).padStart(2, "0")}.000Z`
      : `2026-07-31T00:10:${String(second).padStart(2, "0")}.000Z`,
    references: [],
    observationAuthority: "adapter_report",
    durableTransitionApplied: false,
    ...payload,
  });
}

function externalReference(
  adapterId: string,
  kind: RunnerExternalReferenceV1["kind"],
  externalId: string,
  generation: number | null,
  createdAt = "2026-07-31T00:10:06.000Z",
): RunnerExternalReferenceV1 {
  return parseRunnerExternalReferenceV1({
    version: 1,
    kind,
    adapterId,
    externalId,
    digest: null,
    uri: null,
    generation,
    createdAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function reference(
  value: RunnerExternalReferenceV1,
  adapterId: string,
): RunnerExternalReferenceV1 {
  return parseRunnerExternalReferenceV1({ ...value, adapterId });
}

function requiredSnapshot(
  snapshots: Map<string, EffectiveToolSurfaceSnapshot>,
  transition: string,
): EffectiveToolSurfaceSnapshot {
  const snapshot = snapshots.get(transition);
  if (!snapshot) throw new Error(`Missing ${transition} fake capability snapshot`);
  return snapshot;
}
