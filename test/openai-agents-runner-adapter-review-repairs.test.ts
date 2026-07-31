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
import type {
  EffectiveToolSurfaceClass,
  ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerCancellationCommandV1,
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
const runId = "run_openai_agents_review_repairs";
const itemId = "item_openai_agents_review_repairs";
const project = "scrapbook";
const acceptedNow = new Date("2026-07-31T00:30:00.000Z");
const secret = "sk-proj-review-secret-value";

type RuntimeVariant =
  | "baseline"
  | "changed-instructions"
  | "omitted-tool"
  | "renamed-tool"
  | "changed-executable"
  | "duplicate-tool"
  | "handoff"
  | "runner-model"
  | "runner-callback"
  | "runner-listener"
  | "agent-listener"
  | "own-run";

class ScriptedModel implements Model {
  constructor(
    private readonly responses: ModelResponse[],
    private readonly onRequest: () => void,
  ) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    this.onRequest();
    const response = this.responses.shift();
    if (!response) throw new Error("Scripted model response exhausted");
    return response;
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<any> {
    throw new Error("Streaming is outside this regression");
  }
}

class MemoryStore implements OpenAIAgentsExternalStore {
  readonly checkpoints = new Map<string, OpenAIAgentsCheckpointRecordV1>();
  readonly artifacts = new Map<string, OpenAIAgentsArtifactRecordV1>();
  readonly publications = new Map<string, {
    semantic: string;
    receipt: OpenAIAgentsCheckpointAppendReceiptV1;
  }>();
  readonly lineageGenerations = new Map<string, number>();
  checkpointReads = 0;
  checkpointWrites = 0;
  persistedCheckpoints = 0;
  artifactWrites = 0;
  failCheckpointWrite = false;
  failCheckpointRead = false;
  failArtifactWrite = false;
  #queue: Promise<void> = Promise.resolve();

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    this.checkpointWrites += 1;
    if (this.failCheckpointWrite) {
      throw new Error(`checkpoint provider echoed ${secret}`);
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
      this.persistedCheckpoints += 1;
      return structuredClone(receipt);
    } finally {
      release();
    }
  }

  async loadCheckpoint(
    externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    this.checkpointReads += 1;
    if (this.failCheckpointRead) {
      throw new Error(`checkpoint read echoed ${secret}`);
    }
    const record = this.checkpoints.get(externalId);
    return record ? structuredClone(record) : null;
  }

  async saveArtifact(
    record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    this.artifactWrites += 1;
    if (this.failArtifactWrite) {
      throw new Error(`artifact provider echoed ${secret}`);
    }
    const externalId = `artifact:${record.runId}:${record.runGeneration}`;
    this.artifacts.set(externalId, structuredClone(record));
    return { externalId };
  }
}

class ScriptedRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  createCalls = 0;
  prepareCalls = 0;
  modelCalls = 0;
  toolCalls = 0;

  constructor(
    private readonly options: {
      startResponses?: ModelResponse[];
      resumeResponses?: ModelResponse[];
      createFailure?: string;
      variant?: RuntimeVariant;
      completionOverride?: unknown;
    } = {},
  ) {}

  create(input: {
    phase: "start" | "resume";
    command: RunnerStartCommandV1 | RunnerResumeCommandV1;
  }) {
    this.createCalls += 1;
    if (this.options.createFailure) {
      throw new Error(this.options.createFailure);
    }

    const model = bindOpenAIAgentsModelV1(
      new ScriptedModel(
        [...(input.phase === "start"
          ? this.options.startResponses ?? [approvalResponse("call-start", "first")]
          : this.options.resumeResponses ?? [finalMessageResponse("done")])],
        () => {
          this.modelCalls += 1;
        },
      ),
      "scripted-model-v1",
    );
    const variant = this.options.variant ?? "baseline";
    const toolName = variant === "renamed-tool"
      ? "record_other"
      : "record_value";
    const executableId = variant === "changed-executable"
      ? "record-value-v2"
      : "record-value-v1";
    const primaryTool = bindOpenAIAgentsExecutableToolV1(tool({
      name: toolName,
      description: "Record one deterministic value after approval.",
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => true,
      execute: async ({ value }) => {
        this.toolCalls += 1;
        return `recorded:${value}`;
      },
    }), executableId);
    const tools: (typeof primaryTool)[] = variant === "omitted-tool"
      ? []
      : [primaryTool];
    if (variant === "duplicate-tool") {
      tools.push(bindOpenAIAgentsExecutableToolV1(tool({
        name: "record_value",
        description: "Duplicate one deterministic value.",
        parameters: z.object({ value: z.string() }),
        needsApproval: async () => true,
        execute: async ({ value }) => `duplicate:${value}`,
      }), "record-value-duplicate-v1"));
    }

    const child = variant === "handoff"
      ? new Agent({
        name: "Child Agent",
        instructions: "Return without side effects.",
        model,
        tools: [],
      })
      : undefined;
    const agent = new Agent({
      name: "Stensibly OpenAI Adapter Review Agent",
      instructions: variant === "changed-instructions"
        ? "Use a changed deterministic script."
        : "Use the deterministic script.",
      model,
      tools,
      handoffs: child ? [child] : [],
    });
    const runnerModel = variant === "runner-model"
      ? bindOpenAIAgentsModelV1(
        new ScriptedModel([finalMessageResponse("other")], () => {
          this.modelCalls += 1;
        }),
        "scripted-model-v2",
      )
      : model;
    const runner = new Runner({
      model: runnerModel,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      ...(variant === "runner-callback"
        ? { callModelInputFilter: async (value: any) => value }
        : {}),
    });
    if (variant === "runner-listener") runner.on("agent_start", () => {});
    if (variant === "agent-listener") agent.on("agent_start", () => {});
    if (variant === "own-run") {
      Object.defineProperty(runner, "run", {
        value: async () => {
          throw new Error(secret);
        },
        enumerable: true,
      });
    }
    return {
      agent,
      runner,
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

  summarizeCompletion(input: {
    generatedItemTypes: readonly string[];
  }) {
    if (this.options.completionOverride !== undefined) {
      return this.options.completionOverride as any;
    }
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
  store: MemoryStore,
  runtimeFactory = new ScriptedRuntimeFactory(),
  options: {
    now?: () => Date;
    capabilityClasses?: (
      probe: RunnerCapabilityProbeV1,
    ) => Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>;
  } = {},
) {
  const adapter = new OpenAIAgentsRunnerAdapter({
    descriptor: descriptor(),
    capabilityInspector: {
      inspect: options.capabilityClasses
        ?? ((probe) => capabilityClasses(probe.transition === "resume")),
    },
    runtimeFactory,
    externalStore: store,
    now: options.now ?? (() => acceptedNow),
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

describe("OpenAI Agents adapter review repairs", () => {
  test("requires one fresh capability inspection bound to the exact command", async () => {
    const store = new MemoryStore();
    const runtimeFactory = new ScriptedRuntimeFactory();
    const { adapter } = createAdapter(store, runtimeFactory);
    await adapter.inspectCapabilities(
      probe("weak-probe", "new", [
        { class: "native_core", id: "shell" },
      ], "2026-07-31T00:00:01.000Z"),
    );

    await expect(collect(adapter.start(startCommand()))).rejects.toThrow(
      "exact command requirements",
    );
    expect(runtimeFactory.createCalls).toBe(0);

    const stale = createAdapter(store, runtimeFactory);
    await stale.adapter.inspectCapabilities(
      probe("stale-probe", "new", startCommand().requiredCapabilities,
        "2026-07-30T22:00:00.000Z"),
    );
    await expect(collect(stale.adapter.start(startCommand()))).rejects.toThrow(
      "inspection is stale",
    );
    expect(runtimeFactory.createCalls).toBe(0);
  });

  test("consumes an inspection once", async () => {
    const store = new MemoryStore();
    const candidate = createAdapter(store);
    await candidate.adapter.inspectCapabilities(startProbe());
    const first = await collect(candidate.adapter.start(startCommand()));
    expect(first.at(-1)?.type).toBe("interrupted");
    await expect(collect(candidate.adapter.start(startCommand()))).rejects.toThrow(
      "requires a capability inspection",
    );
  });

  test("rejects expired commands before runtime or store activity", async () => {
    const store = new MemoryStore();
    const runtimeFactory = new ScriptedRuntimeFactory();
    let clockCalls = 0;
    const { adapter } = createAdapter(store, runtimeFactory, {
      now: () => {
        clockCalls += 1;
        return new Date("2026-07-31T01:00:00.000Z");
      },
    });
    await adapter.inspectCapabilities(startProbe());

    await expect(collect(adapter.start(startCommand()))).rejects.toThrow(
      "authority expired before execution",
    );
    expect(clockCalls).toBe(1);
    expect(runtimeFactory.createCalls).toBe(0);
    expect(store.checkpointWrites).toBe(0);
  });

  test("admits the injected clock once and redacts hostile clock failures", async () => {
    const acceptedStore = new MemoryStore();
    let acceptedCalls = 0;
    const accepted = createAdapter(
      acceptedStore,
      new ScriptedRuntimeFactory(),
      {
        now: () => {
          acceptedCalls += 1;
          if (acceptedCalls > 1) throw new Error(secret);
          return acceptedNow;
        },
      },
    );
    await accepted.adapter.inspectCapabilities(startProbe());
    const observations = await collect(accepted.adapter.start(startCommand()));
    expect(observations.at(-1)?.type).toBe("interrupted");
    expect(acceptedCalls).toBe(1);

    const failedStore = new MemoryStore();
    const failedFactory = new ScriptedRuntimeFactory();
    const failed = createAdapter(failedStore, failedFactory, {
      now: () => {
        throw new Error(secret);
      },
    });
    await failed.adapter.inspectCapabilities(startProbe());
    await expect(collect(failed.adapter.start(startCommand()))).rejects.toThrow(
      "OpenAI Agents adapter clock is invalid",
    );
    expect(failedFactory.createCalls).toBe(0);
    expect(failedStore.checkpointWrites).toBe(0);
  });

  test("continues checkpoint generations after a fresh adapter resumes", async () => {
    const store = new MemoryStore();
    const first = createAdapter(
      store,
      new ScriptedRuntimeFactory({
        startResponses: [approvalResponse("call-first", "first")],
      }),
    );
    await first.adapter.inspectCapabilities(startProbe());
    const firstCheckpoint = checkpointFrom(
      await collect(first.adapter.start(startCommand())),
    );
    expect(firstCheckpoint.generation).toBe(1);

    const restarted = createAdapter(
      store,
      new ScriptedRuntimeFactory({
        resumeResponses: [approvalResponse("call-second", "second")],
      }),
    );
    await restarted.adapter.inspectCapabilities(resumeProbe());
    const secondCheckpoint = checkpointFrom(await collect(
      restarted.adapter.resume(resumeCommand(firstCheckpoint)),
    ));

    expect(secondCheckpoint.generation).toBe(2);
    expect(store.checkpoints.has(firstCheckpoint.externalId!)).toBe(true);
    expect(store.checkpoints.has(secondCheckpoint.externalId!)).toBe(true);
  });

  test("conflicts a same-command replay whose serialized state changed", async () => {
    const store = new MemoryStore();
    const first = createAdapter(
      store,
      new ScriptedRuntimeFactory({
        startResponses: [approvalResponse("call-stable", "first")],
      }),
    );
    await first.adapter.inspectCapabilities(startProbe());
    const firstObservations = await collect(first.adapter.start(startCommand()));
    expect(firstObservations.at(-1)?.type).toBe("interrupted");

    const changed = createAdapter(
      store,
      new ScriptedRuntimeFactory({
        startResponses: [approvalResponse("call-stable", "changed")],
      }),
    );
    await changed.adapter.inspectCapabilities(startProbe());
    const changedObservations = await collect(
      changed.adapter.start(startCommand()),
    );

    expect(changedObservations.at(-1)?.type).toBe("failure_observed");
    expect(store.checkpointWrites).toBe(2);
    expect(store.persistedCheckpoints).toBe(1);
    expect(store.checkpoints.size).toBe(1);
    expect(store.publications.size).toBe(1);
  });

  test("rejects runtime manifest drift before state reconstruction or model work", async () => {
    for (const variant of [
      "changed-instructions",
      "omitted-tool",
      "renamed-tool",
      "changed-executable",
    ] as const) {
      const store = new MemoryStore();
      const checkpoint = await createCheckpoint(store);
      const runtimeFactory = new ScriptedRuntimeFactory({ variant });
      const { adapter } = createAdapter(store, runtimeFactory);
      await adapter.inspectCapabilities(resumeProbe());

      const observations = await collect(
        adapter.resume(resumeCommand(checkpoint)),
      );
      expect(observations.map((entry) => entry.type)).toEqual([
        "resume_accepted",
        "execution_started",
        "tool_surface_observed",
        "failure_observed",
      ]);
      expect(runtimeFactory.prepareCalls).toBe(0);
      expect(runtimeFactory.modelCalls).toBe(0);
      expect(runtimeFactory.toolCalls).toBe(0);
      expect(store.artifactWrites).toBe(0);
    }
  });

  test("rejects unsupported graph and Runner policy before SDK model work", async () => {
    for (const variant of [
      "duplicate-tool",
      "handoff",
      "runner-model",
      "runner-callback",
      "runner-listener",
      "agent-listener",
      "own-run",
    ] as const) {
      const store = new MemoryStore();
      const runtimeFactory = new ScriptedRuntimeFactory({ variant });
      const { adapter } = createAdapter(store, runtimeFactory);
      await adapter.inspectCapabilities(startProbe());

      const observations = await collect(adapter.start(startCommand()));
      expect(observations.at(-1)?.type).toBe("failure_observed");
      expect(runtimeFactory.modelCalls).toBe(0);
      expect(runtimeFactory.toolCalls).toBe(0);
      expect(store.checkpointWrites).toBe(0);
      expect(store.artifactWrites).toBe(0);
    }
  });

  test("classifies missing and failed checkpoint lookup with fixed observations", async () => {
    for (const fails of [false, true]) {
      const store = new MemoryStore();
      store.failCheckpointRead = fails;
      const runtimeFactory = new ScriptedRuntimeFactory();
      const candidate = createAdapter(store, runtimeFactory);
      await candidate.adapter.inspectCapabilities(resumeProbe());
      const observations = await collect(
        candidate.adapter.resume(resumeCommand(fakeCheckpoint())),
      );
      expect(observations.map((entry) => entry.type)).toEqual([
        "resume_accepted",
        "execution_started",
        "tool_surface_observed",
        "failure_observed",
      ]);
      expect(JSON.stringify(observations)).not.toContain(secret);
      expect(runtimeFactory.createCalls).toBe(0);
    }
  });

  test("validates the complete completion before any artifact effect", async () => {
    let getterReads = 0;
    const accessorActual: Record<string, unknown> = {};
    Object.defineProperty(accessorActual, "toolCalls", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });
    const invalidCompletions: unknown[] = [
      { outcome: secret, executionActual: {} },
      { outcome: "private context echo", executionActual: {} },
      { outcome: "completed", executionActual: accessorActual },
      {
        outcome: "completed",
        executionActual: {},
        artifactContent: secret,
        artifactMediaType: "application/json",
      },
      { outcome: "x".repeat(200), executionActual: {} },
      { outcome: "completed", executionActual: { estimateErrorReasons: [secret] } },
    ];

    for (const completionOverride of invalidCompletions) {
      const store = new MemoryStore();
      const runtimeFactory = new ScriptedRuntimeFactory({
        startResponses: [finalMessageResponse(secret)],
        completionOverride,
      });
      const candidate = createAdapter(store, runtimeFactory);
      await candidate.adapter.inspectCapabilities(startProbe());
      const observations = await collect(candidate.adapter.start(startCommand()));
      expect(observations.at(-1)?.type).toBe("failure_observed");
      expect(store.artifactWrites).toBe(0);
      expect(store.artifacts.size).toBe(0);
      expect(JSON.stringify(observations)).not.toContain(secret);
    }
    expect(getterReads).toBe(0);
  });

  test("redacts runtime and external-store failures after command acceptance", async () => {
    const runtimeFactory = new ScriptedRuntimeFactory({ createFailure: secret });
    const runtimeCandidate = createAdapter(new MemoryStore(), runtimeFactory);
    await runtimeCandidate.adapter.inspectCapabilities(startProbe());
    const runtimeFailure = await collect(
      runtimeCandidate.adapter.start(startCommand()),
    );
    expect(runtimeFailure.at(-1)?.type).toBe("failure_observed");
    expect(JSON.stringify(runtimeFailure)).not.toContain(secret);

    const checkpointStore = new MemoryStore();
    checkpointStore.failCheckpointWrite = true;
    const checkpointCandidate = createAdapter(checkpointStore);
    await checkpointCandidate.adapter.inspectCapabilities(startProbe());
    const checkpointFailure = await collect(
      checkpointCandidate.adapter.start(startCommand()),
    );
    expect(checkpointFailure.at(-1)?.type).toBe("failure_observed");
    expect(JSON.stringify(checkpointFailure)).not.toContain(secret);

    const artifactStore = new MemoryStore();
    artifactStore.failArtifactWrite = true;
    const artifactCandidate = createAdapter(
      artifactStore,
      new ScriptedRuntimeFactory({
        startResponses: [finalMessageResponse("complete")],
      }),
    );
    await artifactCandidate.adapter.inspectCapabilities(startProbe());
    const artifactFailure = await collect(
      artifactCandidate.adapter.start(startCommand()),
    );
    expect(artifactFailure.at(-1)?.type).toBe("failure_observed");
    expect(JSON.stringify(artifactFailure)).not.toContain(secret);
    expect(artifactStore.artifacts.size).toBe(0);
  });

  test("admits cancellation once and rejects expired, malformed, and accessor input", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const { adapter } = createAdapter(store, new ScriptedRuntimeFactory(), {
      now: () => {
        calls += 1;
        return acceptedNow;
      },
    });
    const observation = await adapter.requestCancellation(cancellationCommand());
    expect(observation.requestAccepted).toBe(true);
    expect(observation.observedAt).toBe("2026-07-31T00:30:00.001Z");
    expect(calls).toBe(1);

    await expect(adapter.requestCancellation({
      ...cancellationCommand(),
      authority: {
        ...cancellationCommand().authority,
        expiresAt: "2026-07-31T00:30:00.000Z",
      },
    })).rejects.toThrow("authority expired before execution");

    await expect((adapter.requestCancellation as any)({
      ...cancellationCommand(),
      requestedAt: "invalid-time",
    })).rejects.toThrow("OpenAI Agents control command is invalid");

    let getterReads = 0;
    const hostile = { ...cancellationCommand() } as Record<string, unknown>;
    Object.defineProperty(hostile, "runId", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });
    await expect((adapter.requestCancellation as any)(hostile)).rejects.toThrow(
      "OpenAI Agents control command is invalid",
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

async function createCheckpoint(
  store: MemoryStore,
): Promise<RunnerExternalReferenceV1> {
  const first = createAdapter(store);
  await first.adapter.inspectCapabilities(startProbe());
  return checkpointFrom(await collect(first.adapter.start(startCommand())));
}

function checkpointFrom(
  observations: readonly RunnerObservationV1[],
): RunnerExternalReferenceV1 {
  const publication = observations.find(
    (entry) => entry.type === "checkpoint_published",
  );
  if (!publication || publication.type !== "checkpoint_published") {
    throw new Error("Expected checkpoint publication");
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

function finalMessageResponse(text: string): ModelResponse {
  return {
    output: [{
      id: "message-review-repair",
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

function startCommand(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase("command-review-start", "2026-07-31T00:00:00.000Z"),
    kind: "start",
  });
}

function resumeCommand(
  checkpointRef: RunnerExternalReferenceV1,
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase("command-review-resume", "2026-07-31T00:10:00.000Z"),
    kind: "resume",
    continuation: { id: "continuation-review-1", generation: 1 },
    adapterResumeRef: parseRunnerExternalReferenceV1({
      version: 1,
      kind: "continuation",
      adapterId,
      externalId: "continuation:review:1",
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

function fakeCheckpoint(): RunnerExternalReferenceV1 {
  return parseRunnerExternalReferenceV1({
    version: 1,
    kind: "checkpoint",
    adapterId,
    externalId: "checkpoint:missing",
    digest: `sha256:${"0".repeat(64)}`,
    uri: null,
    generation: 1,
    createdAt: "2026-07-31T00:30:00.005Z",
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function cancellationCommand(): RunnerCancellationCommandV1 {
  return {
    version: 1,
    commandId: "command-review-cancel",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "runner-review-actor",
      generation: 1,
      expiresAt: "2026-07-31T01:00:00.000Z",
    },
    requestedAt: "2026-07-31T00:10:00.000Z",
    reason: "operator-requested cancellation",
  };
}

function commandBase(commandId: string, issuedAt: string) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId,
    correlationId: "workflow-openai-review-repairs",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "runner-review-actor",
      generation: 1,
      expiresAt: "2026-07-31T01:00:00.000Z",
    },
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove the OpenAI Agents review repairs.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Prove the OpenAI Agents review repairs.",
        summary: null,
        nextAction: "Exercise the exact adapter repair.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: [`item:${itemId}`],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 384,
    },
    requiredCapabilities: [
      { class: "native_core", id: "shell" },
      { class: "configured_mcp", id: "stensibly" },
    ],
    capabilityGrantRefs: ["grant:openai-review-repairs"],
    issuedAt,
  };
}

function startProbe(): RunnerCapabilityProbeV1 {
  return probe(
    "probe-review-start",
    "new",
    startCommand().requiredCapabilities,
    "2026-07-31T00:00:01.000Z",
  );
}

function resumeProbe(): RunnerCapabilityProbeV1 {
  return probe(
    "probe-review-resume",
    "resume",
    startCommand().requiredCapabilities,
    "2026-07-31T00:10:01.000Z",
  );
}

function probe(
  probeId: string,
  transition: "new" | "resume",
  requiredCapabilities: RunnerCapabilityProbeV1["requiredCapabilities"],
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
    clientProduct: "openai-agents-review-repairs",
    clientBuild: "0.14.1",
    modelProfile: "scripted-model",
    externalSurfaceRef: `surface:${adapterId}`,
    requiredCapabilities,
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
