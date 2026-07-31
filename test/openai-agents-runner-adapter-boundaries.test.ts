import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  Usage,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type RunState,
  type RunToolApprovalItem,
} from "@openai/agents-core";
import { z } from "zod";
import { stableJson } from "../src/canonical-json.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerCancellationCommandV1,
  type RunnerCheckpointCommandV1,
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
const runId = "run_openai_agents_boundaries";
const acceptedNow = new Date("2026-07-31T00:30:00.000Z");
const secret = "sk-proj-boundary-secret";

class BoundaryModel implements Model {
  constructor(
    private readonly response: ModelResponse,
    private readonly onCall: () => void,
  ) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    this.onCall();
    return this.response;
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<any> {
    throw new Error("Streaming is outside this boundary suite");
  }
}

class BoundaryFactory implements OpenAIAgentsRuntimeFactory {
  createCalls = 0;
  prepareCalls = 0;
  modelCalls = 0;
  toolCalls = 0;

  create(input: {
    phase: "start" | "resume";
    command: RunnerStartCommandV1 | RunnerResumeCommandV1;
  }) {
    this.createCalls += 1;
    const model = bindOpenAIAgentsModelV1(
      new BoundaryModel(
        approvalResponse(
          input.phase === "start" ? "call-start" : "call-resume",
          input.phase === "start" ? "first" : "second",
        ),
        () => {
          this.modelCalls += 1;
        },
      ),
      "boundary-model-v1",
    );
    const record = bindOpenAIAgentsExecutableToolV1(tool({
      name: "record_value",
      description: "Record one approved boundary value.",
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => true,
      execute: async ({ value }) => {
        this.toolCalls += 1;
        return `recorded:${value}`;
      },
    }), "boundary-record-v1");
    const agent = new Agent({
      name: "OpenAI Boundary Agent",
      instructions: "Use the bounded approval tool.",
      model,
      tools: [record],
    });
    return {
      agent,
      runner: new Runner({
        model,
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
      }),
      startInput: input.command.context.intent.objective,
    };
  }

  prepareResumeState(input: {
    state: RunState<any, Agent<any, any>>;
    interruptions: readonly RunToolApprovalItem[];
  }): void {
    this.prepareCalls += 1;
    for (const interruption of input.interruptions) {
      input.state.approve(interruption);
    }
  }

  summarizeCompletion() {
    return {
      outcome: "completed",
      executionActual: {
        durationMinutes: 1,
        toolCalls: 0,
        filesChanged: 0,
      },
    };
  }
}

class BoundaryStore implements OpenAIAgentsExternalStore {
  readonly checkpoints = new Map<string, OpenAIAgentsCheckpointRecordV1>();
  readonly publications = new Map<string, {
    semantic: string;
    receipt: OpenAIAgentsCheckpointAppendReceiptV1;
  }>();
  readonly lineageGenerations = new Map<string, number>();
  checkpointReads = 0;
  checkpointWrites = 0;
  artifactWrites = 0;
  loadedOverride: unknown | undefined;
  appendReceiptOverride: unknown | undefined;
  #queue: Promise<void> = Promise.resolve();

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    this.checkpointWrites += 1;
    if (this.appendReceiptOverride !== undefined) {
      return this.appendReceiptOverride as OpenAIAgentsCheckpointAppendReceiptV1;
    }
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
      const lineage = stableJson([
        input.adapterId,
        input.adapterVersion,
        input.profileId,
        input.profileVersion,
        input.runId,
        input.runGeneration,
        input.leaseGeneration,
      ]);
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
      return structuredClone(receipt);
    } finally {
      release();
    }
  }

  async loadCheckpoint(
    externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    this.checkpointReads += 1;
    if (this.loadedOverride !== undefined) {
      return this.loadedOverride as OpenAIAgentsCheckpointRecordV1;
    }
    const record = this.checkpoints.get(externalId);
    return record ? structuredClone(record) : null;
  }

  async saveArtifact(
    _record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    this.artifactWrites += 1;
    return { externalId: "artifact:boundary" };
  }
}

function createAdapter(
  store: BoundaryStore,
  factory = new BoundaryFactory(),
  now: () => Date = () => acceptedNow,
) {
  return {
    adapter: new OpenAIAgentsRunnerAdapter({
      descriptor: descriptor(),
      capabilityInspector: {
        inspect: () => ({
          native_core: {
            executable: [{ id: "shell", name: "Shell" }],
            provenance: ["boundary:core"],
          },
        }),
      },
      runtimeFactory: factory,
      externalStore: store,
      now,
    }),
    factory,
  };
}

async function collect(
  stream: AsyncIterable<RunnerObservationV1>,
): Promise<RunnerObservationV1[]> {
  const observations: RunnerObservationV1[] = [];
  for await (const observation of stream) observations.push(observation);
  return observations;
}

describe("OpenAI Agents adapter hostile boundaries", () => {
  test("rejects throwing and invalid clocks before adapter activity", async () => {
    const clocks: Array<() => Date> = [
      () => {
        throw new Error(secret);
      },
      () => new Date(Number.NaN),
    ];

    for (const clock of clocks) {
      for (const mode of ["start", "resume", "cancel"] as const) {
        const store = new BoundaryStore();
        const factory = new BoundaryFactory();
        const { adapter } = createAdapter(store, factory, clock);
        let message = "";
        try {
          if (mode === "start") {
            await adapter.inspectCapabilities(startProbe());
            await collect(adapter.start(startCommand()));
          } else if (mode === "resume") {
            await adapter.inspectCapabilities(resumeProbe());
            await collect(adapter.resume(resumeCommand(fakeCheckpoint())));
          } else {
            await adapter.requestCancellation(cancellationCommand());
          }
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toBe("OpenAI Agents adapter clock is invalid");
        expect(message).not.toContain(secret);
        expect(factory.createCalls).toBe(0);
        expect(store.checkpointReads).toBe(0);
        expect(store.checkpointWrites).toBe(0);
        expect(store.artifactWrites).toBe(0);
      }
    }
  });

  test("rejects checkpoint accessors without invoking them", async () => {
    const store = new BoundaryStore();
    let getterReads = 0;
    const record: Record<string, unknown> = {
      version: 1,
      adapterId,
      adapterVersion,
      profileId,
      profileVersion,
      sdkPackageVersion: "0.14.1",
      sdkSchemaVersion: "1.14",
      runId,
      runGeneration: 1,
      leaseGeneration: 1,
      checkpointGeneration: 1,
      serializedState: "{}",
      stateDigest: `sha256:${"0".repeat(64)}`,
      runtimeManifest: {},
      runtimeManifestFingerprint: `sha256:${"0".repeat(64)}`,
      checkpointDigest: `sha256:${"0".repeat(64)}`,
      createdAt: "2026-07-31T00:30:00.006Z",
    };
    Object.defineProperty(record, "stateDigest", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });
    store.loadedOverride = record;
    const factory = new BoundaryFactory();
    const { adapter } = createAdapter(store, factory);
    await adapter.inspectCapabilities(resumeProbe());

    const observations = await collect(
      adapter.resume(resumeCommand(fakeCheckpoint())),
    );
    expect(observations.at(-1)?.type).toBe("failure_observed");
    expect(JSON.stringify(observations)).not.toContain(secret);
    expect(getterReads).toBe(0);
    expect(store.checkpointReads).toBe(1);
    expect(factory.createCalls).toBe(0);
  });

  test("rejects accessor-bearing append receipts without publishing", async () => {
    const store = new BoundaryStore();
    let getterReads = 0;
    const hostile: Record<string, unknown> = {
      externalId: "checkpoint:hostile",
      record: {},
      replayed: false,
    };
    Object.defineProperty(hostile, "record", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });
    store.appendReceiptOverride = hostile;
    const candidate = createAdapter(store);
    await candidate.adapter.inspectCapabilities(startProbe());
    const observations = await collect(candidate.adapter.start(startCommand()));

    expect(observations.at(-1)?.type).toBe("failure_observed");
    expect(observations.some((entry) => entry.type === "checkpoint_published"))
      .toBe(false);
    expect(JSON.stringify(observations)).not.toContain(secret);
    expect(getterReads).toBe(0);
  });

  test("rejected checkpoints leave recovery state untouched", async () => {
    const store = new BoundaryStore();
    const initial = createAdapter(store);
    await initial.adapter.inspectCapabilities(startProbe());
    const checkpoint = checkpointFrom(
      await collect(initial.adapter.start(startCommand())),
    );
    const externalId = checkpoint.externalId!;
    const acceptedRecord = structuredClone(store.checkpoints.get(externalId)!);

    store.checkpoints.set(externalId, {
      ...acceptedRecord,
      checkpointGeneration: 99,
    });
    const forgedReference = parseRunnerExternalReferenceV1({
      ...checkpoint,
      generation: 99,
    });
    const candidateFactory = new BoundaryFactory();
    const candidate = createAdapter(store, candidateFactory);
    await candidate.adapter.inspectCapabilities(resumeProbe());
    const rejected = await collect(
      candidate.adapter.resume(resumeCommand(forgedReference)),
    );
    expect(rejected.at(-1)?.type).toBe("failure_observed");
    expect(candidateFactory.createCalls).toBe(0);

    await expect(
      candidate.adapter.requestCheckpoint(checkpointCommand()),
    ).rejects.toThrow("no published checkpoint");

    store.checkpoints.set(externalId, acceptedRecord);
    await candidate.adapter.inspectCapabilities(resumeProbe());
    const resumed = await collect(
      candidate.adapter.resume(resumeCommand(checkpoint)),
    );
    const nextCheckpoint = checkpointFrom(resumed);
    expect(nextCheckpoint.generation).toBe(2);
    expect(candidateFactory.createCalls).toBe(1);
    expect(candidateFactory.prepareCalls).toBe(1);
    expect(store.checkpointWrites).toBe(2);
  });

  test("rejects hostile checkpoint control commands before map access", async () => {
    const store = new BoundaryStore();
    const { adapter } = createAdapter(store);
    let getterReads = 0;
    const hostile = { ...checkpointCommand() } as Record<string, unknown>;
    Object.defineProperty(hostile, "runGeneration", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });

    await expect((adapter.requestCheckpoint as any)(hostile)).rejects.toThrow(
      "field runGeneration must be enumerable data",
    );
    expect(getterReads).toBe(0);
  });
});

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

function checkpointFrom(
  observations: readonly RunnerObservationV1[],
): RunnerExternalReferenceV1 {
  const publication = observations.find(
    (entry) => entry.type === "checkpoint_published",
  );
  if (!publication || publication.type !== "checkpoint_published") {
    throw new Error("Expected a checkpoint publication");
  }
  return publication.reference;
}

function approvalResponse(callId: string, value: string): ModelResponse {
  return {
    output: [{
      id: `function-${callId}`,
      type: "function_call",
      name: "record_value",
      callId,
      status: "completed",
      arguments: JSON.stringify({ value }),
    }],
    usage: new Usage(),
  };
}

function startCommand(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase("command-boundary-start", "2026-07-31T00:00:00.000Z"),
    kind: "start",
  });
}

function resumeCommand(
  checkpointRef: RunnerExternalReferenceV1,
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase("command-boundary-resume", "2026-07-31T00:10:00.000Z"),
    kind: "resume",
    continuation: { id: "continuation-boundary", generation: 1 },
    adapterResumeRef: parseRunnerExternalReferenceV1({
      version: 1,
      kind: "continuation",
      adapterId,
      externalId: "continuation:boundary",
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

function commandBase(commandId: string, issuedAt: string) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId,
    correlationId: "workflow-openai-boundaries",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}` as const,
      holderId: "boundary-actor",
      generation: 1,
      expiresAt: "2026-07-31T01:00:00.000Z",
    },
    itemId: "item_openai_agents_boundaries",
    project: "scrapbook",
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove the hostile adapter boundaries.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: "item_openai_agents_boundaries", project: "scrapbook" },
      intent: {
        objective: "Prove the hostile adapter boundaries.",
        summary: null,
        nextAction: "Exercise one exact boundary.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: ["item:item_openai_agents_boundaries"],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 256,
    },
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    capabilityGrantRefs: ["grant:openai-boundaries"],
    issuedAt,
  };
}

function startProbe() {
  return parseRunnerCapabilityProbeV1({
    ...probeBase("probe-boundary-start"),
    transition: "new",
    observedAt: "2026-07-31T00:00:01.000Z",
  });
}

function resumeProbe() {
  return parseRunnerCapabilityProbeV1({
    ...probeBase("probe-boundary-resume"),
    transition: "resume",
    observedAt: "2026-07-31T00:10:01.000Z",
  });
}

function probeBase(probeId: string) {
  return {
    version: 1,
    probeId,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    clientProduct: "openai-agents-boundaries",
    clientBuild: "0.14.1",
    modelProfile: "boundary-model",
    externalSurfaceRef: `surface:${adapterId}`,
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    recoveryActions: ["resume_with_current_tools"],
    traceId: `trace-${probeId}`,
  };
}

function fakeCheckpoint(): RunnerExternalReferenceV1 {
  return parseRunnerExternalReferenceV1({
    version: 1,
    kind: "checkpoint",
    adapterId,
    externalId: "checkpoint:fake",
    digest: `sha256:${"0".repeat(64)}`,
    uri: null,
    generation: 1,
    createdAt: "2026-07-31T00:30:00.006Z",
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function cancellationCommand(): RunnerCancellationCommandV1 {
  return {
    version: 1,
    commandId: "command-boundary-cancel",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: controlAuthority(),
    requestedAt: "2026-07-31T00:10:00.000Z",
    reason: "boundary cancellation",
  };
}

function checkpointCommand(): RunnerCheckpointCommandV1 {
  return {
    version: 1,
    commandId: "command-boundary-checkpoint",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: controlAuthority(),
    requestedAt: "2026-07-31T00:10:00.000Z",
  };
}

function controlAuthority(): RunnerCancellationCommandV1["authority"] {
  return {
    resource: `run:${runId}`,
    holderId: "boundary-actor",
    generation: 1,
    expiresAt: "2026-07-31T01:00:00.000Z",
  };
}
