import { describe, expect, test } from "bun:test";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  type RunnerCancellationCommandV1,
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

class NoopStore implements OpenAIAgentsExternalStore {
  async appendCheckpoint(
    _input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    throw new Error("checkpoint publication is outside this test");
  }

  async loadCheckpoint(
    _externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    return null;
  }

  async saveArtifact(
    _record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    throw new Error("artifact publication is outside this test");
  }
}

class NoopRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  create(): never {
    throw new Error("runtime execution is outside this test");
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

function adapter(): OpenAIAgentsRunnerAdapter {
  return new OpenAIAgentsRunnerAdapter({
    descriptor: parseRunnerAdapterDescriptorV1({
      version: RUNNER_ADAPTER_V1,
      adapterId: "openai-agents-js",
      adapterVersion: "1.0.0",
      profiles: [{ id: "regular-agent", version: "2026-08-02" }],
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
    capabilityInspector: { inspect: () => ({}) },
    runtimeFactory: new NoopRuntimeFactory(),
    externalStore: new NoopStore(),
    now: () => new Date("2026-08-02T00:30:00.000Z"),
  });
}

describe("OpenAI Agents control numeric identity", () => {
  test("rejects negative-zero run generation before authority lookup", async () => {
    const command: RunnerCancellationCommandV1 = {
      version: RUNNER_ADAPTER_V1,
      commandId: "command-negative-zero",
      adapterId: "openai-agents-js",
      adapterVersion: "1.0.0",
      profileId: "regular-agent",
      runId: "run_negative_zero",
      runGeneration: -0,
      leaseGeneration: 1,
      authority: {
        resource: "run:run_negative_zero",
        holderId: "holder-negative-zero",
        generation: 1,
        expiresAt: "2026-08-02T02:00:00.000Z",
      },
      requestedAt: "2026-08-02T00:10:00.000Z",
      reason: "Reject a non-canonical numeric identity.",
    };

    await expect(adapter().requestCancellation(command))
      .rejects.toThrow("control command is invalid");
  });
});
