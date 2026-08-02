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
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
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
const profileVersion = "2026-08-02";
const runId = "run_openai_agents_resume_cache";
const holderId = "resume-cache-holder";
const now = new Date("2026-08-02T00:30:00.000Z");

class PhaseModel implements Model {
  constructor(private readonly response: ModelResponse) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    return this.response;
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<any> {
    throw new Error("Streaming is outside this cache control");
  }
}

class ResumeCacheFactory implements OpenAIAgentsRuntimeFactory {
  create(input: { phase: "start" | "resume" }) {
    const response = input.phase === "start"
      ? approvalResponse()
      : finalResponse();
    const model = bindOpenAIAgentsModelV1(
      new PhaseModel(response),
      "resume-cache-model-v1",
    );
    const record = bindOpenAIAgentsExecutableToolV1(tool({
      name: "record_value",
      description: "Record one deterministic resume-cache value.",
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => true,
      execute: async ({ value }) => `recorded:${value}`,
    }), "resume-cache-tool-v1");
    const agent = new Agent({
      name: "Resume Cache Agent",
      instructions: "Request one approval and then complete after resume.",
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
      startInput: "Exercise one profile-bound resumed checkpoint.",
    };
  }

  prepareResumeState(input: {
    state: RunState<any, Agent<any, any>>;
    interruptions: readonly RunToolApprovalItem[];
  }): void {
    for (const interruption of input.interruptions) {
      input.state.approve(interruption);
    }
  }

  summarizeCompletion() {
    return {
      outcome: "completed",
      executionActual: {
        durationMinutes: 1,
        toolCalls: 1,
        filesChanged: 0,
      },
    };
  }
}

class ResumeCacheStore implements OpenAIAgentsExternalStore {
  readonly checkpoints = new Map<string, OpenAIAgentsCheckpointRecordV1>();

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    const record = finalizeOpenAIAgentsCheckpointAppendV1(input, 1);
    const externalId = "checkpoint:resume-cache:1";
    this.checkpoints.set(externalId, structuredClone(record));
    return { externalId, record, replayed: false };
  }

  async loadCheckpoint(
    externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    const record = this.checkpoints.get(externalId);
    return record ? structuredClone(record) : null;
  }

  async saveArtifact(
    _record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    return { externalId: "artifact:resume-cache" };
  }
}

function createAdapter(): OpenAIAgentsRunnerAdapter {
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
          provenance: ["test:resume-cache"],
        },
      }),
    },
    runtimeFactory: new ResumeCacheFactory(),
    externalStore: new ResumeCacheStore(),
    now: () => now,
  });
}

function approvalResponse(): ModelResponse {
  return {
    output: [{
      id: "function-resume-cache",
      type: "function_call",
      name: "record_value",
      callId: "call-resume-cache",
      status: "completed",
      arguments: JSON.stringify({ value: "stable" }),
    }],
    usage: new Usage(),
  };
}

function finalResponse(): ModelResponse {
  return {
    output: [{
      id: "message-resume-cache",
      status: "completed",
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "complete",
        providerData: { annotations: [] },
      }],
    }],
    usage: new Usage(),
  };
}

function commandBase(commandId: string, issuedAt: string) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId,
    correlationId: "workflow-resume-cache",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}` as const,
      holderId,
      generation: 1,
      expiresAt: "2026-08-02T02:00:00.000Z",
    },
    itemId: "item_openai_agents_resume_cache",
    project: "scrapbook",
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove profile-bound resumed checkpoint cache parity.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: "item_openai_agents_resume_cache", project: "scrapbook" },
      intent: {
        objective: "Prove profile-bound resumed checkpoint cache parity.",
        summary: null,
        nextAction: "Resume one admitted checkpoint and complete.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: ["item:item_openai_agents_resume_cache"],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 260,
    },
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    capabilityGrantRefs: ["grant:resume-cache"],
    issuedAt,
  };
}

function startCommand(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase("command-resume-cache-start", "2026-08-02T00:00:00.000Z"),
    kind: "start",
  });
}

function resumeCommand(
  checkpointRef: RunnerExternalReferenceV1,
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase("command-resume-cache-resume", "2026-08-02T00:10:00.000Z"),
    kind: "resume",
    continuation: { id: "continuation-resume-cache", generation: 1 },
    adapterResumeRef: parseRunnerExternalReferenceV1({
      version: 1,
      kind: "continuation",
      adapterId,
      externalId: "continuation:resume-cache",
      digest: null,
      uri: null,
      generation: 1,
      createdAt: "2026-08-02T00:00:08.000Z",
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    }),
    checkpointRef,
    reason: "continue the exact resume-cache run",
  });
}

function checkpointCommand(): RunnerCheckpointCommandV1 {
  return {
    version: 1,
    commandId: "command-resume-cache-checkpoint",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId,
      generation: 1,
      expiresAt: "2026-08-02T02:00:00.000Z",
    },
    requestedAt: "2026-08-02T00:20:00.000Z",
  };
}

function probe(transition: "new" | "resume") {
  return parseRunnerCapabilityProbeV1({
    version: 1,
    probeId: `probe-resume-cache-${transition}`,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    transition,
    clientProduct: "openai-agents-resume-cache",
    clientBuild: "0.14.1",
    modelProfile: "resume-cache-model",
    externalSurfaceRef: `surface:${adapterId}`,
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt: transition === "new"
      ? "2026-08-02T00:00:01.000Z"
      : "2026-08-02T00:10:01.000Z",
    traceId: `trace-resume-cache-${transition}`,
  });
}

async function collect(
  stream: AsyncIterable<RunnerObservationV1>,
): Promise<RunnerObservationV1[]> {
  const observations: RunnerObservationV1[] = [];
  for await (const observation of stream) observations.push(observation);
  return observations;
}

function checkpointFrom(
  observations: readonly RunnerObservationV1[],
): RunnerExternalReferenceV1 {
  const publication = observations.find(
    (observation) => observation.type === "checkpoint_published",
  );
  if (!publication || publication.type !== "checkpoint_published") {
    throw new Error("Expected one checkpoint publication");
  }
  return publication.reference;
}

describe("OpenAI Agents resumed checkpoint cache", () => {
  test("retains the admitted input checkpoint when resume completes without a newer checkpoint", async () => {
    const adapter = createAdapter();
    await adapter.inspectCapabilities(probe("new"));
    const checkpoint = checkpointFrom(
      await collect(adapter.start(startCommand())),
    );

    await adapter.inspectCapabilities(probe("resume"));
    const resumed = await collect(adapter.resume(resumeCommand(checkpoint)));
    expect(resumed.some(
      (observation) => observation.type === "checkpoint_published",
    )).toBe(false);
    expect(resumed.at(-1)?.type).toBe("completion_proposed");

    await expect(adapter.requestCheckpoint(checkpointCommand()))
      .resolves.toEqual(checkpoint);
  });
});
