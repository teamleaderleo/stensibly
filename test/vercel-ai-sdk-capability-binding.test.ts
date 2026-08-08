import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerCapabilityProbeV1,
  parseRunnerStartCommandV1,
  type RunnerCapabilityProbeV1,
  type RunnerObservationV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";
import {
  VERCEL_AI_SDK_ADAPTER_ID,
  VERCEL_AI_SDK_ADAPTER_VERSION,
  VERCEL_AI_SDK_PACKAGE_VERSION,
  VERCEL_AI_SDK_PROFILE_ID,
  VERCEL_AI_SDK_PROFILE_VERSION,
  VercelAISDKRunnerAdapter,
  type VercelAISDKCheckpointRecordV1,
  type VercelAISDKCheckpointStore,
} from "../src/runner-adapters/vercel-ai-sdk.ts";

const runId = "run_vercel_ai_sdk_binding";

class NullCheckpointStore implements VercelAISDKCheckpointStore {
  saveCheckpoint(_record: VercelAISDKCheckpointRecordV1): void {}

  loadCheckpoint(_externalId: string): VercelAISDKCheckpointRecordV1 | null {
    return null;
  }
}

describe("Vercel AI SDK capability binding", () => {
  test("detaches the admitted tool surface from caller registry drift", async () => {
    const tools: Record<string, any> = {
      probeTool: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => value,
      }),
    };
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult("unused"),
    });
    const adapter = new VercelAISDKRunnerAdapter({
      agentSettings: { model, tools },
      now: () => new Date("2026-08-09T00:00:02.000Z"),
      checkpointStore: new NullCheckpointStore(),
      authorizeToolExecution: () => {},
    });

    await adapter.inspectCapabilities(capabilityProbe());
    tools.lateTool = tool({
      inputSchema: z.object({}),
      execute: async () => "late",
    });

    const observations = await collect(adapter.start(startCommand()));
    expect(observations.at(-1)?.type).toBe("interrupted");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("rejects a command whose required capabilities differ from its inspection", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult("unused"),
    });
    const adapter = new VercelAISDKRunnerAdapter({
      agentSettings: {
        model,
        tools: {
          probeTool: tool({
            inputSchema: z.object({ value: z.string() }),
            execute: async ({ value }) => value,
          }),
        },
      },
      now: () => new Date("2026-08-09T00:00:02.000Z"),
      checkpointStore: new NullCheckpointStore(),
      authorizeToolExecution: () => {},
    });

    await adapter.inspectCapabilities(capabilityProbe());
    const mismatched = parseRunnerStartCommandV1({
      ...commandBase(),
      kind: "start",
      requiredCapabilities: [],
    });

    await expect(collect(adapter.start(mismatched))).rejects.toThrow(
      "requires a current capability inspection",
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("rejects a degraded inspection before model execution", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult("unused"),
    });
    const adapter = new VercelAISDKRunnerAdapter({
      agentSettings: { model, tools: {} },
      checkpointStore: new NullCheckpointStore(),
      now: () => new Date("2026-08-09T00:00:02.000Z"),
    });

    const snapshot = await adapter.inspectCapabilities(capabilityProbe());
    expect(snapshot.missingRequiredCapabilities).toEqual([
      { class: "host_dynamic", id: "probeTool" },
    ]);
    await expect(collect(adapter.start(startCommand()))).rejects.toThrow(
      "cannot satisfy the required capabilities",
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("detaches tool definitions from hooks added by the caller later", async () => {
    const probeTool = tool({
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => value,
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult("unused"),
    });
    const adapter = new VercelAISDKRunnerAdapter({
      agentSettings: { model, tools: { probeTool } },
      checkpointStore: new NullCheckpointStore(),
      now: () => new Date("2026-08-09T00:00:02.000Z"),
    });
    await adapter.inspectCapabilities(capabilityProbe());
    (probeTool as any).onInputStart = () => {};

    const observations = await collect(adapter.start(startCommand()));
    expect(observations.at(-1)?.type).toBe("interrupted");
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

function capabilityProbe(): RunnerCapabilityProbeV1 {
  return parseRunnerCapabilityProbeV1({
    version: RUNNER_ADAPTER_V1,
    probeId: "probe-ai-sdk-binding",
    adapterId: VERCEL_AI_SDK_ADAPTER_ID,
    adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
    profileId: VERCEL_AI_SDK_PROFILE_ID,
    runId,
    runGeneration: 1,
    transport: "in_process",
    transition: "new",
    clientProduct: "vercel-ai-sdk-binding-test",
    clientBuild: VERCEL_AI_SDK_PACKAGE_VERSION,
    modelProfile: "MockLanguageModelV4",
    externalSurfaceRef: "surface:vercel-ai-sdk-binding-test",
    requiredCapabilities: [{ class: "host_dynamic", id: "probeTool" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt: "2026-08-09T00:00:01.000Z",
    traceId: "trace-ai-sdk-binding",
  });
}

function startCommand(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase(),
    kind: "start",
  });
}

function commandBase() {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "command-ai-sdk-binding-start",
    correlationId: "workflow-ai-sdk-binding",
    adapterId: VERCEL_AI_SDK_ADAPTER_ID,
    adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
    profileId: VERCEL_AI_SDK_PROFILE_ID,
    profileVersion: VERCEL_AI_SDK_PROFILE_VERSION,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "runner-actor",
      generation: 1,
      expiresAt: "2026-08-09T01:00:00.000Z",
    },
    itemId: "item_vercel_ai_sdk_binding",
    project: "scrapbook",
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove AI SDK capability inspection binding.",
    ),
    context: {
      version: 1,
      generatedAt: "2026-08-09T00:00:00.000Z",
      item: { id: "item_vercel_ai_sdk_binding", project: "scrapbook" },
      intent: {
        objective: "Prove AI SDK capability inspection binding.",
        summary: null,
        nextAction: "Execute only under the inspected capability surface.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: ["item:item_vercel_ai_sdk_binding"],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 512,
    },
    requiredCapabilities: [{ class: "host_dynamic", id: "probeTool" }],
    capabilityGrantRefs: ["grant:ai-sdk-binding-test"],
    issuedAt: "2026-08-09T00:00:00.000Z",
  };
}

async function collect(
  stream: AsyncIterable<RunnerObservationV1>,
): Promise<RunnerObservationV1[]> {
  const output: RunnerObservationV1[] = [];
  for await (const observation of stream) output.push(observation);
  return output;
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      cachedInputTokens: undefined,
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: 1,
        text: 1,
        reasoning: undefined,
      },
    },
    warnings: [],
  };
}
