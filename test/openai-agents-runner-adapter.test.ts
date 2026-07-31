import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  Usage,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents-core";
import { z } from "zod";
import { stableJson } from "../src/canonical-json.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import type {
  EffectiveToolSurfaceClass,
  ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import {
  runRunnerAdapterConformanceV1,
  type RunnerAdapterConformanceScenarioV1,
} from "../src/runner-adapter-conformance.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerCapabilityProbeV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";
import {
  bindOpenAIAgentsExecutableToolV1,
  bindOpenAIAgentsModelV1,
} from "../src/runner-adapters/openai-agents-runtime-safety.ts";
import {
  OPENAI_AGENTS_PACKAGE_VERSION,
  OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION,
  OpenAIAgentsRunnerAdapter,
  finalizeOpenAIAgentsCheckpointAppendV1,
  type OpenAIAgentsArtifactRecordV1,
  type OpenAIAgentsCheckpointAppendReceiptV1,
  type OpenAIAgentsCheckpointAppendV1,
  type OpenAIAgentsCheckpointRecordV1,
  type OpenAIAgentsExternalStore,
  type OpenAIAgentsRuntimeFactory,
} from "../src/runner-adapters/openai-agents.ts";

const adapterId = "openai-agents-js";
const adapterVersion = "1.0.0";
const profileId = "regular-agent";
const profileVersion = "2026-07-31";
const runId = "run_openai_agents_adapter";
const itemId = "item_openai_agents_adapter";
const project = "scrapbook";
const correlationId = "workflow_openai_agents_adapter";
const fixedNow = new Date("2026-07-31T00:30:00.000Z");

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("Fake OpenAI model response script is exhausted");
    return response;
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<any> {
    throw new Error("Streaming is outside the first OpenAI adapter slice");
  }
}

class MemoryExternalStore implements OpenAIAgentsExternalStore {
  readonly checkpoints = new Map<string, OpenAIAgentsCheckpointRecordV1>();
  readonly artifacts = new Map<string, OpenAIAgentsArtifactRecordV1>();
  readonly publications = new Map<string, {
    semantic: string;
    receipt: OpenAIAgentsCheckpointAppendReceiptV1;
  }>();
  readonly lineageGenerations = new Map<string, number>();
  readonly appendInputs: OpenAIAgentsCheckpointAppendV1[] = [];
  appendCalls = 0;
  persistedCheckpoints = 0;
  #queue: Promise<void> = Promise.resolve();

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    this.appendCalls += 1;
    this.appendInputs.push(structuredClone(input));
    const prior = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const semantic = stableJson(input);
      const existing = this.publications.get(input.publicationKey);
      if (existing) {
        if (existing.semantic !== semantic) {
          throw new RangeError("Checkpoint publication replay conflicts");
        }
        return structuredClone({ ...existing.receipt, replayed: true });
      }
      const lineage = lineageKey(input);
      const generation = (this.lineageGenerations.get(lineage) ?? 0) + 1;
      const record = finalizeOpenAIAgentsCheckpointAppendV1(input, generation);
      const externalId =
        `checkpoint:${input.runId}:${input.runGeneration}:${input.leaseGeneration}:${generation}`;
      const receipt = { externalId, record, replayed: false };
      this.lineageGenerations.set(lineage, generation);
      this.checkpoints.set(externalId, structuredClone(record));
      this.publications.set(input.publicationKey, {
        semantic,
        receipt: structuredClone(receipt),
      });
      this.persistedCheckpoints += 1;
      return structuredClone(receipt);
    } finally {
      release();
    }
  }

  async loadCheckpoint(
    externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    const record = this.checkpoints.get(externalId);
    return record ? structuredClone(record) : null;
  }

  async saveArtifact(
    record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    const externalId = `artifact:${record.runId}:${record.runGeneration}`;
    this.artifacts.set(externalId, structuredClone(record));
    return { externalId };
  }
}

class ModelFreeRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  readonly executedValues: string[] = [];
  readonly createdPhases: string[] = [];

  create(input: {
    phase: "start" | "resume";
    command: RunnerStartCommandV1 | RunnerResumeCommandV1;
  }) {
    this.createdPhases.push(input.phase);
    const model = bindOpenAIAgentsModelV1(
      new ScriptedModel(
        input.phase === "start"
          ? [approvalToolCallResponse()]
          : [finalMessageResponse("The model-free OpenAI adapter completed.")],
      ),
      "scripted-model-v1",
    );
    const approvalTool = bindOpenAIAgentsExecutableToolV1(tool({
      name: "record_value",
      description: "Record one deterministic value after approval.",
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => true,
      execute: async ({ value }) => {
        this.executedValues.push(value);
        return `recorded:${value}`;
      },
    }), "record-value-v1");
    const agent = new Agent({
      name: "Stensibly OpenAI Adapter Test Agent",
      instructions:
        "Use the deterministic tool once, then return a concise final answer.",
      model,
      tools: [approvalTool],
    });
    const runner = new Runner({
      model,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
    return {
      agent,
      runner,
      startInput: input.command.context.intent.objective,
    };
  }

  prepareResumeState(input: {
    state: import("@openai/agents-core").RunState<any, Agent<any, any>>;
    interruptions: readonly import("@openai/agents-core").RunToolApprovalItem[];
  }): void {
    for (const interruption of input.interruptions) {
      input.state.approve(interruption);
    }
  }

  summarizeCompletion(input: {
    generatedItemTypes: readonly string[];
  }) {
    return {
      outcome: "completed",
      executionActual: {
        durationMinutes: 1,
        toolCalls: input.generatedItemTypes.filter(
          (type) => type === "function_call",
        ).length,
        filesChanged: 0,
      },
    };
  }
}

function createAdapter(
  store: MemoryExternalStore,
  options: {
    runtimeFactory?: ModelFreeRuntimeFactory;
    capabilityClasses?: (
      probe: RunnerCapabilityProbeV1,
    ) => Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>;
  } = {},
) {
  const runtimeFactory = options.runtimeFactory ?? new ModelFreeRuntimeFactory();
  const adapter = new OpenAIAgentsRunnerAdapter({
    descriptor: descriptor(),
    capabilityInspector: {
      inspect: options.capabilityClasses
        ?? ((probe) => capabilityClasses(probe.transition === "resume")),
    },
    runtimeFactory,
    externalStore: store,
    now: () => fixedNow,
  });
  return { adapter, runtimeFactory };
}

async function collect(
  stream: AsyncIterable<RunnerObservationV1>,
): Promise<RunnerObservationV1[]> {
  const observations: RunnerObservationV1[] = [];
  for await (const observation of stream) observations.push(observation);
  return observations;
}

async function prepareCheckpoint(
  adapter: OpenAIAgentsRunnerAdapter,
): Promise<RunnerExternalReferenceV1> {
  await adapter.inspectCapabilities(startProbe());
  return checkpointFrom(await collect(adapter.start(startCommand())));
}

describe("OpenAI Agents RunnerAdapterV1", () => {
  test("uses the real SDK for checkpointed interruption and fresh-runtime resume", async () => {
    const store = new MemoryExternalStore();
    const first = createAdapter(store);
    const checkpoint = await prepareCheckpoint(first.adapter);

    expect(checkpoint).toMatchObject({
      kind: "checkpoint",
      adapterId,
      generation: 1,
      containsPrivateContent: false,
      containsCredentials: false,
    });
    const stored = [...store.checkpoints.values()][0]!;
    expect(stored.sdkPackageVersion).toBe(OPENAI_AGENTS_PACKAGE_VERSION);
    expect(stored.sdkSchemaVersion).toBe(
      OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION,
    );
    expect(stored.runtimeManifest.fingerprint).toBe(
      stored.runtimeManifestFingerprint,
    );
    expect(checkpoint.digest).toBe(stored.checkpointDigest);

    const second = createAdapter(store);
    await second.adapter.inspectCapabilities(resumeProbe());
    const observations = await collect(
      second.adapter.resume(resumeCommand(checkpoint)),
    );

    expect(second.runtimeFactory.createdPhases).toEqual(["resume"]);
    expect(second.runtimeFactory.executedValues).toEqual(["approved-value"]);
    expect(observations.map((entry) => entry.type)).toEqual([
      "resume_accepted",
      "execution_started",
      "tool_surface_observed",
      "heartbeat",
      "artifact_published",
      "completion_proposed",
    ]);
    expect(store.artifacts.size).toBe(1);
    const artifact = [...store.artifacts.values()][0]!;
    expect(artifact.mediaType).toBe("application/json");
    expect(artifact.content).toBe(stableJson({
      version: 1,
      outcome: "completed",
      executionActual: {
        durationMinutes: 1,
        toolCalls: 1,
        filesChanged: 0,
      },
    }));
    expect(artifact.content).not.toContain("approved-value");
    expect(artifact.content).not.toContain("model-free OpenAI adapter completed");
  });

  test("passes the shared Group A conformance report with the real SDK", async () => {
    const store = new MemoryExternalStore();
    const preview = createAdapter(store);
    const checkpoint = await prepareCheckpoint(preview.adapter);
    const candidate = createAdapter(store);
    const report = await runRunnerAdapterConformanceV1(
      candidate.adapter,
      conformanceScenario(checkpoint),
    );

    expect(report.passed).toBe(true);
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
    expect(report.canonicalRunPreserved).toBe(true);
    expect(report.durableTransitionsAppliedByAdapter).toBe(false);
    expect(report.sideEffectsPerformed).toBe(false);
  });

  test("replays one publication key exactly across fresh adapter instances", async () => {
    const store = new MemoryExternalStore();
    const first = createAdapter(store);
    const second = createAdapter(store);
    const firstCheckpoint = await prepareCheckpoint(first.adapter);
    const secondCheckpoint = await prepareCheckpoint(second.adapter);

    expect(secondCheckpoint).toEqual(firstCheckpoint);
    expect(store.appendCalls).toBe(2);
    expect(store.persistedCheckpoints).toBe(1);
    expect(store.checkpoints.size).toBe(1);
    expect(store.publications.size).toBe(1);
  });

  test("allocates distinct generations atomically for competing publications", async () => {
    const store = new MemoryExternalStore();
    await prepareCheckpoint(createAdapter(store).adapter);
    const original = store.appendInputs[0]!;
    const [left, right] = await Promise.all([
      store.appendCheckpoint({
        ...structuredClone(original),
        publicationKey: `sha256:${"1".repeat(64)}`,
      }),
      store.appendCheckpoint({
        ...structuredClone(original),
        publicationKey: `sha256:${"2".repeat(64)}`,
      }),
    ]);

    expect([left.record.checkpointGeneration, right.record.checkpointGeneration]
      .sort((a, b) => a - b)).toEqual([2, 3]);
    expect(left.externalId).not.toBe(right.externalId);
    expect(store.checkpoints.size).toBe(3);
  });

  test("conflicts a changed replay and keeps separate lineages independent", async () => {
    const store = new MemoryExternalStore();
    await prepareCheckpoint(createAdapter(store).adapter);
    const original = store.appendInputs[0]!;
    await expect(store.appendCheckpoint({
      ...structuredClone(original),
      serializedState: `${original.serializedState} `,
    })).rejects.toThrow("replay conflicts");
    expect(store.checkpoints.size).toBe(1);

    const otherLease = await store.appendCheckpoint({
      ...structuredClone(original),
      publicationKey: `sha256:${"3".repeat(64)}`,
      leaseGeneration: 2,
    });
    expect(otherLease.record.checkpointGeneration).toBe(1);
  });

  test("reports a competing lease as a fixed resume failure", async () => {
    const store = new MemoryExternalStore();
    const checkpoint = await prepareCheckpoint(createAdapter(store).adapter);
    const candidate = createAdapter(store);
    await candidate.adapter.inspectCapabilities(resumeProbe());
    const observations = await collect(
      candidate.adapter.resume(resumeCommand(checkpoint, 2)),
    );

    expect(observations.map((entry) => entry.type)).toEqual([
      "resume_accepted",
      "execution_started",
      "tool_surface_observed",
      "failure_observed",
    ]);
    expect(candidate.runtimeFactory.createdPhases).toEqual([]);
  });

  test("rejects cross-adapter and altered checkpoint state", async () => {
    const store = new MemoryExternalStore();
    const checkpoint = await prepareCheckpoint(createAdapter(store).adapter);
    const crossAdapter = parseRunnerExternalReferenceV1({
      ...checkpoint,
      adapterId: "other-adapter",
    });
    const crossCandidate = createAdapter(store);
    await crossCandidate.adapter.inspectCapabilities(resumeProbe());
    const cross = await collect(
      crossCandidate.adapter.resume(resumeCommand(crossAdapter)),
    );
    expect(cross.at(-1)?.type).toBe("failure_observed");

    const externalId = checkpoint.externalId!;
    const accepted = store.checkpoints.get(externalId)!;
    store.checkpoints.set(externalId, {
      ...accepted,
      serializedState: `${accepted.serializedState} `,
    });
    const alteredCandidate = createAdapter(store);
    await alteredCandidate.adapter.inspectCapabilities(resumeProbe());
    const altered = await collect(
      alteredCandidate.adapter.resume(resumeCommand(checkpoint)),
    );
    expect(altered.at(-1)?.type).toBe("failure_observed");
  });

  test("blocks execution when current required tools disappear", async () => {
    const store = new MemoryExternalStore();
    const candidate = createAdapter(store, {
      capabilityClasses: () => ({
        native_core: {
          executable: [{ id: "shell", name: "Shell" }],
          provenance: ["test:core"],
        },
        configured_mcp: {
          catalogue: [{ id: "stensibly", name: "Stensibly" }],
          executable: [],
          provenance: ["test:mcp-disabled"],
        },
      }),
    });
    await candidate.adapter.inspectCapabilities(startProbe());

    await expect(collect(candidate.adapter.start(startCommand()))).rejects.toThrow(
      "cannot satisfy the required capabilities",
    );
    expect(candidate.runtimeFactory.createdPhases).toEqual([]);
  });
});

function lineageKey(input: OpenAIAgentsCheckpointAppendV1): string {
  return stableJson([
    input.adapterId,
    input.adapterVersion,
    input.profileId,
    input.profileVersion,
    input.runId,
    input.runGeneration,
    input.leaseGeneration,
  ]);
}

function checkpointFrom(
  observations: readonly RunnerObservationV1[],
): RunnerExternalReferenceV1 {
  const publication = observations.find(
    (entry) => entry.type === "checkpoint_published",
  );
  if (!publication || publication.type !== "checkpoint_published") {
    throw new Error("OpenAI adapter did not publish the expected checkpoint");
  }
  return publication.reference;
}

function approvalToolCallResponse(): ModelResponse {
  return {
    output: [{
      id: "function-item-1",
      type: "function_call",
      name: "record_value",
      callId: "call-record-value-1",
      status: "completed",
      arguments: JSON.stringify({ value: "approved-value" }),
    }],
    usage: new Usage(),
  };
}

function finalMessageResponse(text: string): ModelResponse {
  return {
    output: [{
      id: "message-item-1",
      status: "completed",
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text,
        providerData: { annotations: [] },
      }],
    }],
    usage: new Usage(),
  };
}

function descriptor() {
  return parseRunnerAdapterDescriptorV1({
    version: RUNNER_ADAPTER_V1,
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
      traceReferences: false,
    },
  });
}

function startCommand(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase("command-openai-start", "2026-07-31T00:00:00.000Z", 1),
    kind: "start",
  });
}

function resumeCommand(
  checkpointRef: RunnerExternalReferenceV1,
  leaseGeneration = 1,
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase(
      "command-openai-resume",
      "2026-07-31T00:10:00.000Z",
      leaseGeneration,
    ),
    kind: "resume",
    continuation: { id: "continuation-openai-1", generation: 1 },
    adapterResumeRef: parseRunnerExternalReferenceV1({
      version: 1,
      kind: "continuation",
      adapterId,
      externalId: "continuation:openai:1",
      digest: null,
      uri: null,
      generation: 1,
      createdAt: "2026-07-31T00:00:08.000Z",
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    }),
    checkpointRef,
    reason: "continuation",
  });
}

function commandBase(
  commandId: string,
  issuedAt: string,
  leaseGeneration: number,
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
    leaseGeneration,
    authority: {
      resource: `run:${runId}` as const,
      holderId: leaseGeneration === 1 ? "runner-actor" : "competing-actor",
      generation: leaseGeneration,
      expiresAt: "2026-07-31T01:00:00.000Z",
    },
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove the OpenAI Agents runner adapter contract.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Prove the OpenAI Agents runner adapter contract.",
        summary: null,
        nextAction: "Run the model-free approval and resume scenario.",
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
    capabilityGrantRefs: ["grant:test-openai-adapter"],
    issuedAt,
  };
}

function startProbe(): RunnerCapabilityProbeV1 {
  return probe("probe-openai-start", "new", "2026-07-31T00:00:01.000Z");
}

function resumeProbe(): RunnerCapabilityProbeV1 {
  return probe(
    "probe-openai-resume",
    "resume",
    "2026-07-31T00:10:01.000Z",
  );
}

function probe(
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
    clientProduct: "openai-agents-model-free-test",
    clientBuild: OPENAI_AGENTS_PACKAGE_VERSION,
    modelProfile: "scripted-model",
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
): Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>> {
  return {
    native_core: {
      executable: [{ id: "shell", name: "Shell" }],
      provenance: ["test:core"],
    },
    configured_mcp: {
      executable: [{ id: "stensibly", name: "Stensibly" }],
      provenance: ["test:mcp"],
    },
    ...(resumed
      ? {
        app_connector: {
          executable: [{ id: "github", name: "GitHub" }],
          provenance: ["test:connector"],
        },
      }
      : {}),
  };
}

function conformanceScenario(
  checkpointRef: RunnerExternalReferenceV1,
): RunnerAdapterConformanceScenarioV1 {
  return {
    version: 1,
    scenarioId: "scenario-openai-agents-js",
    suiteVersion: "1.0.0",
    startCommand: startCommand(),
    startProbe: startProbe(),
    resumeCommand: resumeCommand(checkpointRef),
    resumeProbe: resumeProbe(),
    expect: {
      startCapabilityState: "healthy",
      resumeCapabilityState: "changed",
      resumeDispatchDecision: "allow",
    },
  };
}
