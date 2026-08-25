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
  openAIAgentsCheckpointAppendReplayFingerprintV1,
  type OpenAIAgentsArtifactRecordV1,
  type OpenAIAgentsCheckpointAppendReceiptV1,
  type OpenAIAgentsCheckpointAppendV1,
  type OpenAIAgentsCheckpointRecordV1,
  type OpenAIAgentsExternalStore,
  type OpenAIAgentsRuntimeFactory,
} from "../src/runner-adapters/openai-agents.ts";

const adapterId = "openai-agents-js";
const adapterVersion = "1.0.0";
const profileId = "sol-manager";
const profileVersionA = "sol-manager/1";
const profileVersionB = "sol-manager/2";
const itemId = "item_profile_rollover";
const project = "stensibly";
const now = new Date("2026-08-25T12:00:00.000Z");

class PhaseModel implements Model {
  constructor(private readonly response: ModelResponse) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    return this.response;
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<any> {
    throw new Error("Streaming is outside this profile-rollover regression");
  }
}

class ProfileRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  createCalls = 0;
  prepareCalls = 0;

  create(input: { phase: "start" | "resume" }) {
    this.createCalls += 1;
    const model = bindOpenAIAgentsModelV1(
      new PhaseModel(input.phase === "start" ? approvalResponse() : finalResponse()),
      "profile-rollover-model-v1",
    );
    const record = bindOpenAIAgentsExecutableToolV1(tool({
      name: "record_value",
      description: "Record one deterministic profile-rollover value.",
      parameters: z.object({ value: z.string() }),
      needsApproval: async () => true,
      execute: async ({ value }) => `recorded:${value}`,
    }), "profile-rollover-tool-v1");
    const agent = new Agent({
      name: "Profile Rollover Agent",
      instructions: "Request one approval on start and complete after resume.",
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
      startInput: "Exercise exact runner profile version rollover.",
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
        toolCalls: 1,
        filesChanged: 0,
      },
    };
  }
}

class ProfileStore implements OpenAIAgentsExternalStore {
  readonly checkpoints = new Map<string, OpenAIAgentsCheckpointRecordV1>();
  readonly publications = new Map<string, {
    semantic: string;
    receipt: OpenAIAgentsCheckpointAppendReceiptV1;
  }>();
  readonly lineageGenerations = new Map<string, number>();

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    const semantic = openAIAgentsCheckpointAppendReplayFingerprintV1(input);
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
    const externalId = `checkpoint:${input.profileVersion}:${input.runId}:${generation}`;
    const receipt = { externalId, record, replayed: false };
    this.lineageGenerations.set(lineage, generation);
    this.checkpoints.set(externalId, structuredClone(record));
    this.publications.set(input.publicationKey, {
      semantic,
      receipt: structuredClone(receipt),
    });
    return structuredClone(receipt);
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
    return { externalId: "artifact:profile-rollover" };
  }
}

function descriptor(profileVersion: string) {
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

function createAdapter(
  store: ProfileStore,
  profileVersion: string,
  factory = new ProfileRuntimeFactory(),
) {
  return {
    adapter: new OpenAIAgentsRunnerAdapter({
      descriptor: descriptor(profileVersion),
      capabilityInspector: {
        inspect: () => ({
          native_core: {
            executable: [{ id: "shell", name: "Shell" }],
            provenance: ["test:profile-rollover"],
          },
        }),
      },
      runtimeFactory: factory,
      externalStore: store,
      now: () => now,
    }),
    factory,
  };
}

function commandBase(
  runId: string,
  profileVersion: string,
  issuedAt: string,
) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: `command:${profileVersion}:${runId}`,
    correlationId: "workflow-profile-rollover",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}` as const,
      holderId: `holder:${runId}`,
      generation: 1,
      expiresAt: "2026-08-25T18:00:00.000Z",
    },
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove exact runner profile version rollover.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Prove exact runner profile version rollover.",
        summary: null,
        nextAction: "Resume only under the exact checkpoint profile version.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: ["issue:1616", "issue:50"],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 260,
    },
    requiredCapabilities: [{ class: "native_core" as const, id: "shell" }],
    capabilityGrantRefs: ["grant:profile-rollover"],
    issuedAt,
  };
}

function startCommand(
  runId: string,
  profileVersion: string,
): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase(runId, profileVersion, "2026-08-25T11:00:00.000Z"),
    kind: "start",
  });
}

function resumeCommand(
  runId: string,
  profileVersion: string,
  checkpoint: RunnerExternalReferenceV1,
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase(runId, profileVersion, "2026-08-25T11:30:00.000Z"),
    commandId: `command:resume:${profileVersion}:${runId}`,
    kind: "resume",
    continuation: { id: "continuation-profile-rollover", generation: 1 },
    adapterResumeRef: parseRunnerExternalReferenceV1({
      version: RUNNER_ADAPTER_V1,
      kind: "continuation",
      adapterId,
      externalId: "continuation:profile-rollover",
      digest: null,
      uri: null,
      generation: 1,
      createdAt: "2026-08-25T11:15:00.000Z",
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    }),
    checkpointRef: checkpoint,
    reason: "continuation",
  });
}

function probe(
  runId: string,
  transition: "new" | "resume",
  observedAt: string,
) {
  return parseRunnerCapabilityProbeV1({
    version: RUNNER_ADAPTER_V1,
    probeId: `probe:${runId}:${transition}`,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    transition,
    clientProduct: "openai-agents-profile-rollover",
    clientBuild: "0.14.1",
    modelProfile: profileId,
    externalSurfaceRef: `surface:${adapterId}`,
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: `trace:${runId}:${transition}`,
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

function approvalResponse(): ModelResponse {
  return {
    output: [{
      id: "function-profile-rollover",
      type: "function_call",
      name: "record_value",
      callId: "call-profile-rollover",
      status: "completed",
      arguments: JSON.stringify({ value: "stable" }),
    }],
    usage: new Usage(),
  };
}

function finalResponse(): ModelResponse {
  return {
    output: [{
      id: "message-profile-rollover",
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

describe("OpenAI Agents runner profile version rollover", () => {
  test("resumes only under the exact checkpoint profile version and uses a fresh run after profile change", async () => {
    const store = new ProfileStore();
    const runA = "run-profile-a";
    const initial = createAdapter(store, profileVersionA);
    await initial.adapter.inspectCapabilities(
      probe(runA, "new", "2026-08-25T11:00:01.000Z"),
    );
    const checkpoint = checkpointFrom(
      await collect(initial.adapter.start(startCommand(runA, profileVersionA))),
    );
    expect(store.checkpoints.get(checkpoint.externalId!)?.profileVersion)
      .toBe(profileVersionA);

    const sameProfile = createAdapter(store, profileVersionA);
    await sameProfile.adapter.inspectCapabilities(
      probe(runA, "resume", "2026-08-25T11:30:01.000Z"),
    );
    const resumed = await collect(
      sameProfile.adapter.resume(
        resumeCommand(runA, profileVersionA, checkpoint),
      ),
    );
    expect(resumed.at(-1)?.type).toBe("completion_proposed");
    expect(sameProfile.factory.createCalls).toBe(1);
    expect(sameProfile.factory.prepareCalls).toBe(1);

    const changedProfile = createAdapter(store, profileVersionB);
    await changedProfile.adapter.inspectCapabilities(
      probe(runA, "resume", "2026-08-25T11:30:01.000Z"),
    );
    const rejected = await collect(
      changedProfile.adapter.resume(
        resumeCommand(runA, profileVersionB, checkpoint),
      ),
    );
    expect(rejected.at(-1)?.type).toBe("failure_observed");
    expect(changedProfile.factory.createCalls).toBe(0);
    expect(changedProfile.factory.prepareCalls).toBe(0);

    const runB = "run-profile-b";
    const successor = createAdapter(store, profileVersionB);
    await successor.adapter.inspectCapabilities(
      probe(runB, "new", "2026-08-25T11:59:59.000Z"),
    );
    const successorObservations = await collect(
      successor.adapter.start(startCommand(runB, profileVersionB)),
    );
    expect(successorObservations.at(-1)?.type).toBe("interrupted");
    const successorCheckpoint = checkpointFrom(successorObservations);
    expect(successor.factory.createCalls).toBe(1);
    expect(store.checkpoints.get(successorCheckpoint.externalId!)?.profileVersion)
      .toBe(profileVersionB);
    expect(successorCheckpoint.externalId).not.toBe(checkpoint.externalId);
  });
});
