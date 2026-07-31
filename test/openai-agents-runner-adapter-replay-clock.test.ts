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
const runId = "run_openai_agents_replay_clock";
const firstNow = new Date("2026-07-31T00:30:00.000Z");
const laterNow = new Date("2026-07-31T00:31:00.000Z");

class ApprovalModel implements Model {
  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    return {
      output: [{
        id: "function-replay-clock",
        type: "function_call",
        name: "record_value",
        callId: "call-replay-clock",
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

class ReplayRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  create(_input: { phase: "start" | "resume"; command: RunnerStartCommandV1 }) {
    const model = bindOpenAIAgentsModelV1(
      new ApprovalModel(),
      "replay-clock-model-v1",
    );
    const record = bindOpenAIAgentsExecutableToolV1(tool({
      name: "record_value",
      description: "Record one deterministic replay value.",
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => true,
      execute: async ({ value }) => `recorded:${value}`,
    }), "replay-clock-tool-v1");
    const agent = new Agent({
      name: "Replay Clock Agent",
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
      startInput: "Request the deterministic replay value.",
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

class ReplayStore implements OpenAIAgentsExternalStore {
  readonly publications = new Map<string, {
    semantic: string;
    receipt: OpenAIAgentsCheckpointAppendReceiptV1;
  }>();
  appendCalls = 0;
  persistedCheckpoints = 0;

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    this.appendCalls += 1;
    const { proposedCreatedAt: _proposalTime, ...semanticInput } = input;
    const semantic = stableJson(semanticInput);
    const existing = this.publications.get(input.publicationKey);
    if (existing) {
      if (existing.semantic !== semantic) {
        throw new RangeError("Checkpoint publication replay conflicts");
      }
      return structuredClone({ ...existing.receipt, replayed: true });
    }

    const record = finalizeOpenAIAgentsCheckpointAppendV1(input, 1);
    const receipt = {
      externalId: "checkpoint:replay-clock:1",
      record,
      replayed: false,
    };
    this.publications.set(input.publicationKey, {
      semantic,
      receipt: structuredClone(receipt),
    });
    this.persistedCheckpoints += 1;
    return structuredClone(receipt);
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

function createAdapter(store: ReplayStore, now: Date) {
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
          provenance: ["test:replay-clock"],
        },
      }),
    },
    runtimeFactory: new ReplayRuntimeFactory(),
    externalStore: store,
    now: () => now,
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
    commandId: "command-replay-clock",
    correlationId: "workflow-replay-clock",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "replay-clock-worker",
      generation: 1,
      expiresAt: "2026-07-31T02:00:00.000Z",
    },
    itemId: "item_replay_clock",
    project: "scrapbook",
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove checkpoint replay across a later retry clock.",
    ),
    context: {
      version: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      item: { id: "item_replay_clock", project: "scrapbook" },
      intent: {
        objective: "Prove checkpoint replay across a later retry clock.",
        summary: null,
        nextAction: "Publish the same deterministic interruption twice.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: ["item:item_replay_clock"],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 256,
    },
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    capabilityGrantRefs: ["grant:replay-clock"],
    issuedAt: "2026-07-31T00:00:00.000Z",
    kind: "start",
  });
}

function probe(observedAt: string) {
  return parseRunnerCapabilityProbeV1({
    version: 1,
    probeId: `probe-${observedAt}`,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    transition: "new",
    clientProduct: "openai-agents-replay-clock",
    clientBuild: "0.14.1",
    modelProfile: "replay-clock-model",
    externalSurfaceRef: `surface:${adapterId}`,
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: `trace-${observedAt}`,
  });
}

function checkpointFrom(observations: readonly RunnerObservationV1[]) {
  const publication = observations.find(
    (observation) => observation.type === "checkpoint_published",
  );
  if (!publication || publication.type !== "checkpoint_published") {
    throw new Error("Expected checkpoint publication");
  }
  return publication.reference;
}

describe("OpenAI Agents durable replay clock boundary", () => {
  test("replays one checkpoint when the same publication is retried later", async () => {
    const store = new ReplayStore();
    const first = createAdapter(store, firstNow);
    await first.inspectCapabilities(probe("2026-07-31T00:00:01.000Z"));
    const firstObservations = await collect(first.start(command()));
    const firstCheckpoint = checkpointFrom(firstObservations);

    const later = createAdapter(store, laterNow);
    await later.inspectCapabilities(probe("2026-07-31T00:01:01.000Z"));
    const laterObservations = await collect(later.start(command()));

    expect(laterObservations.at(-1)?.type).toBe("interrupted");
    const replayedCheckpoint = checkpointFrom(laterObservations);
    expect(replayedCheckpoint).toEqual(firstCheckpoint);
    expect(store.appendCalls).toBe(2);
    expect(store.persistedCheckpoints).toBe(1);
    expect(store.publications.size).toBe(1);
  });
});
