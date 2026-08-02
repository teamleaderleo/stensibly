import { describe, expect, test } from "bun:test";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerStartCommandV1,
  type RunnerCancellationCommandV1,
  type RunnerCheckpointCommandV1,
  type RunnerObservationV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";
import {
  OpenAIAgentsRunnerAdapter,
  type OpenAIAgentsArtifactRecordV1,
  type OpenAIAgentsCheckpointAppendReceiptV1,
  type OpenAIAgentsCheckpointAppendV1,
  type OpenAIAgentsCheckpointRecordV1,
  type OpenAIAgentsExternalStore,
  type OpenAIAgentsRuntimeFactory,
} from "../src/runner-adapters/openai-agents.ts";

const adapterId = "openai-agents-js";
const adapterVersion = "1.0.0";
const profileA = "regular-agent-a";
const profileB = "regular-agent-b";
const profileVersion = "2026-08-02";
const runId = "run_openai_agents_control_identity";
const holderA = "control-holder-a";
const holderB = "control-holder-b";
const now = new Date("2026-08-02T00:30:00.000Z");

class NoopStore implements OpenAIAgentsExternalStore {
  async appendCheckpoint(
    _input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    throw new Error("checkpoint publication is outside this control suite");
  }

  async loadCheckpoint(
    _externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    return null;
  }

  async saveArtifact(
    _record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    throw new Error("artifact publication is outside this control suite");
  }
}

class FailingRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  create(): never {
    throw new Error("fixed runtime stop after accepted authority");
  }

  prepareResumeState(): void {}

  summarizeCompletion() {
    return {
      outcome: "unreachable",
      executionActual: {
        durationMinutes: 0,
        toolCalls: 0,
        filesChanged: 0,
      },
    };
  }
}

function createAdapter(): OpenAIAgentsRunnerAdapter {
  return new OpenAIAgentsRunnerAdapter({
    descriptor: parseRunnerAdapterDescriptorV1({
      version: RUNNER_ADAPTER_V1,
      adapterId,
      adapterVersion,
      profiles: [
        { id: profileA, version: profileVersion },
        { id: profileB, version: profileVersion },
      ],
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
          provenance: ["test:control-identity"],
        },
      }),
    },
    runtimeFactory: new FailingRuntimeFactory(),
    externalStore: new NoopStore(),
    now: () => now,
  });
}

async function admitProfile(
  adapter: OpenAIAgentsRunnerAdapter,
  profileId: string,
  holderId: string,
): Promise<void> {
  await adapter.inspectCapabilities(parseRunnerCapabilityProbeV1({
    version: 1,
    probeId: `probe-control-${profileId}`,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    transition: "new",
    clientProduct: "openai-agents-control-identity",
    clientBuild: "0.14.1",
    modelProfile: `control-model-${profileId}`,
    externalSurfaceRef: `surface:${adapterId}:${profileId}`,
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt: "2026-08-02T00:00:01.000Z",
    traceId: `trace-control-${profileId}`,
  }));

  const observations = await collect(
    adapter.start(startCommand(profileId, holderId)),
  );
  expect(observations[0]?.type).toBe("start_accepted");
  expect(observations.at(-1)?.type).toBe("failure_observed");
}

function startCommand(
  profileId: string,
  holderId: string,
): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    version: RUNNER_ADAPTER_V1,
    commandId: `command-control-start-${profileId}`,
    correlationId: "workflow-control-identity",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: authority(holderId),
    itemId: "item_openai_agents_control_identity",
    project: "scrapbook",
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove profile-bound OpenAI Agents controls.",
    ),
    context: {
      version: 1,
      generatedAt: "2026-08-02T00:00:00.000Z",
      item: {
        id: "item_openai_agents_control_identity",
        project: "scrapbook",
      },
      intent: {
        objective: "Prove profile-bound OpenAI Agents controls.",
        summary: null,
        nextAction: "Admit one bounded runner authority.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: ["item:item_openai_agents_control_identity"],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 240,
    },
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    capabilityGrantRefs: ["grant:control-identity"],
    issuedAt: "2026-08-02T00:00:00.000Z",
    kind: "start",
  });
}

function checkpointCommand(
  profileId: string,
  holderId: string,
): RunnerCheckpointCommandV1 {
  return {
    version: 1,
    commandId: `command-control-checkpoint-${profileId}-${holderId}`,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: authority(holderId),
    requestedAt: "2026-08-02T00:10:00.000Z",
  };
}

function cancellationCommand(
  profileId: string,
  holderId: string,
): RunnerCancellationCommandV1 {
  return {
    version: 1,
    commandId: `command-control-cancel-${profileId}-${holderId}`,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: authority(holderId),
    requestedAt: "2026-08-02T00:10:00.000Z",
    reason: "Exercise profile-bound cancellation authority.",
  };
}

function authority(holderId: string) {
  return {
    resource: `run:${runId}` as const,
    holderId,
    generation: 1,
    expiresAt: "2026-08-02T02:00:00.000Z",
  };
}

async function collect(
  stream: AsyncIterable<RunnerObservationV1>,
): Promise<RunnerObservationV1[]> {
  const observations: RunnerObservationV1[] = [];
  for await (const observation of stream) observations.push(observation);
  return observations;
}

describe("OpenAI Agents control identity wrapper", () => {
  test("rejects a stale holder before process-local checkpoint lookup", async () => {
    const adapter = createAdapter();
    await admitProfile(adapter, profileA, holderA);

    await expect(adapter.requestCheckpoint(
      checkpointCommand(profileA, "competing-holder"),
    )).rejects.toThrow("authority holder is stale");
  });

  test("does not reuse profile A authority for profile B controls", async () => {
    const adapter = createAdapter();
    await admitProfile(adapter, profileA, holderA);

    await expect(adapter.requestCheckpoint(
      checkpointCommand(profileB, holderA),
    )).rejects.toThrow("authority holder is unknown to this adapter instance");
    await expect(adapter.requestCancellation(
      cancellationCommand(profileB, holderA),
    )).rejects.toThrow("authority holder is unknown to this adapter instance");
  });

  test("rejects padded control identity and authority aliases", async () => {
    const adapter = createAdapter();
    await admitProfile(adapter, profileA, holderA);

    const checkpoint = checkpointCommand(profileA, holderA);
    const paddedCheckpointAliases: unknown[] = [
      { ...checkpoint, commandId: ` ${checkpoint.commandId}` },
      { ...checkpoint, profileId: `${checkpoint.profileId} ` },
      {
        ...checkpoint,
        authority: {
          ...checkpoint.authority,
          holderId: ` ${checkpoint.authority.holderId}`,
        },
      },
      {
        ...checkpoint,
        authority: {
          ...checkpoint.authority,
          resource: `${checkpoint.authority.resource} `,
        },
      },
    ];
    for (const alias of paddedCheckpointAliases) {
      await expect(adapter.requestCheckpoint(
        alias as RunnerCheckpointCommandV1,
      )).rejects.toThrow("control command is invalid");
    }

    const cancellation = cancellationCommand(profileA, holderA);
    const paddedCancellationAliases: unknown[] = [
      { ...cancellation, runId: ` ${cancellation.runId}` },
      { ...cancellation, adapterId: `${cancellation.adapterId} ` },
      { ...cancellation, adapterVersion: ` ${cancellation.adapterVersion}` },
    ];
    for (const alias of paddedCancellationAliases) {
      await expect(adapter.requestCancellation(
        alias as RunnerCancellationCommandV1,
      )).rejects.toThrow("control command is invalid");
    }
  });

  test("keeps profile A cancellation valid after profile B is admitted", async () => {
    const adapter = createAdapter();
    await admitProfile(adapter, profileA, holderA);
    await admitProfile(adapter, profileB, holderB);

    const cancellation = await adapter.requestCancellation(
      cancellationCommand(profileA, holderA),
    );
    expect(cancellation).toMatchObject({
      profileId: profileA,
      runId,
      runGeneration: 1,
      leaseGeneration: 1,
      requestAccepted: true,
      deliveryKnown: false,
      remoteSettlementKnown: false,
      reference: null,
    });
  });
});
