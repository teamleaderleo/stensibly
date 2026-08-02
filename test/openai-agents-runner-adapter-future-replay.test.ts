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
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerStartCommandV1,
  type RunnerObservationV1,
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
const runId = "run_openai_agents_future_replay";
const invocationNow = new Date("2026-07-31T00:30:00.000Z");
const impossibleFuture = "2026-07-31T00:31:00.000Z";

class ApprovalModel implements Model {
  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    return {
      output: [{
        id: "function-future-replay",
        type: "function_call",
        name: "record_value",
        callId: "call-future-replay",
        status: "completed",
        arguments: JSON.stringify({ value: "stable" }),
      }],
      usage: new Usage(),
    };
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<any> {
    throw new Error("Streaming is outside this replay control");
  }
}

class FutureReplayRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  create(_input: { phase: "start" | "resume"; command: RunnerStartCommandV1 }) {
    const model = bindOpenAIAgentsModelV1(
      new ApprovalModel(),
      "future-replay-model-v1",
    );
    const record = bindOpenAIAgentsExecutableToolV1(tool({
      name: "record_value",
      description: "Record one deterministic future-replay value.",
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => true,
      execute: async ({ value }) => `recorded:${value}`,
    }), "future-replay-tool-v1");
    const agent = new Agent({
      name: "Future Replay Agent",
      instructions: "Request one deterministic approved tool call.",
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
      startInput: "Request the deterministic future-replay value.",
    };
  }

  prepareResumeState(): void {}

  summarizeCompletion() {
    return {
      outcome: "completed",
      executionActual: { durationMinutes: 1, toolCalls: 0, filesChanged: 0 },
    };
  }
}

class FutureReplayStore implements OpenAIAgentsExternalStore {
  appendCalls = 0;

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    this.appendCalls += 1;
    const record = finalizeOpenAIAgentsCheckpointAppendV1({
      ...input,
      proposedCreatedAt: impossibleFuture,
    }, 1);
    return {
      externalId: "checkpoint:future-replay:1",
      record,
      replayed: true,
    };
  }

  async loadCheckpoint(
    _externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    return null;
  }

  async saveArtifact(
    _record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    throw new Error("Completion is outside this replay control");
  }
}

function createAdapter(store: FutureReplayStore) {
  return new OpenAIAgentsRunnerAdapter({
    descriptor: parseRunnerAdapterDescriptorV1({
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
    }),
    capabilityInspector: {
      inspect: () => ({
        native_core: {
          executable: [{ id: "shell", name: "Shell" }],
          provenance: ["test:future-replay"],
        },
      }),
    },
    runtimeFactory: new FutureReplayRuntimeFactory(),
    externalStore: store,
    now: () => invocationNow,
  });
}

async function collect(
  stream: AsyncIterable<RunnerObservationV1>,
): Promise<RunnerObservationV1[]> {
  const observations: RunnerObservationV1[] = [];
  for await (const observation of stream) observations.push(observation);
  return observations;
}

function command(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    version: RUNNER_ADAPTER_V1,
    commandId: "command-future-replay",
    correlationId: "workflow-future-replay",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "future-replay-worker",
      generation: 1,
      expiresAt: "2026-07-31T02:00:00.000Z",
    },
    itemId: "item_future_replay",
    project: "scrapbook",
    executionEnvelope: compatibilityExecutionEnvelope(
      "Reject a replayed checkpoint created after the current proposal.",
    ),
    context: {
      version: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      item: { id: "item_future_replay", project: "scrapbook" },
      intent: {
        objective: "Reject a future-dated replay receipt.",
        summary: null,
        nextAction: "Publish one deterministic interruption.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: ["item:item_future_replay"],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 220,
    },
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    capabilityGrantRefs: ["grant:future-replay"],
    issuedAt: "2026-07-31T00:00:00.000Z",
    kind: "start",
  });
}

function probe() {
  return parseRunnerCapabilityProbeV1({
    version: 1,
    probeId: "probe-future-replay",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    transition: "new",
    clientProduct: "openai-agents-future-replay",
    clientBuild: "0.14.1",
    modelProfile: "future-replay-model",
    externalSurfaceRef: `surface:${adapterId}`,
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt: "2026-07-31T00:00:01.000Z",
    traceId: "trace-future-replay",
  });
}

describe("OpenAI Agents replay receipt time boundary", () => {
  test("rejects a replayed checkpoint created after the current proposal", async () => {
    const store = new FutureReplayStore();
    const adapter = createAdapter(store);
    await adapter.inspectCapabilities(probe());
    const observations = await collect(adapter.start(command()));

    expect(observations.at(-1)?.type).toBe("failure_observed");
    expect(observations.some(
      (observation) => observation.type === "checkpoint_published",
    )).toBe(false);
    expect(store.appendCalls).toBe(1);
  });
});
