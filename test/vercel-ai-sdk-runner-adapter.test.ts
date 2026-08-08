import { describe, expect, test } from "bun:test";
import { ToolLoopAgent, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  runRunnerAdapterConformanceV1,
  type RunnerAdapterConformanceScenarioV1,
} from "../src/runner-adapter-conformance.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerCapabilityProbeV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerCapabilityProbeV1,
  type RunnerExternalReferenceV1,
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
  vercelAISDKCheckpointReferenceForStart,
  type VercelAISDKCheckpointRecordV1,
  type VercelAISDKCheckpointStore,
} from "../src/runner-adapters/vercel-ai-sdk.ts";

const runId = "run_vercel_ai_sdk";
const itemId = "item_vercel_ai_sdk";
const project = "scrapbook";
const correlationId = "workflow_vercel_ai_sdk";

class InMemoryCheckpointStore implements VercelAISDKCheckpointStore {
  readonly records = new Map<string, VercelAISDKCheckpointRecordV1>();

  saveCheckpoint(record: VercelAISDKCheckpointRecordV1): void {
    this.records.set(record.externalId, structuredClone(record));
  }

  loadCheckpoint(externalId: string): VercelAISDKCheckpointRecordV1 | null {
    const record = this.records.get(externalId);
    return record ? structuredClone(record) : null;
  }
}

describe("Vercel AI SDK runner adapter", () => {
  test("runs the real ToolLoopAgent through RunnerAdapterV1 conformance without network or MCP", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult("bounded reply"),
    });
    const agent = new ToolLoopAgent({
      id: "stensibly-conformance",
      model,
      tools: {
        probeTool: tool({
          description: "A deterministic local conformance tool.",
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      },
    });
    const store = new InMemoryCheckpointStore();
    const adapter = new VercelAISDKRunnerAdapter({ agent, checkpointStore: store });
    const scenario = conformanceScenario();

    const report = await runRunnerAdapterConformanceV1(adapter, scenario);

    expect(report.passed).toBe(true);
    expect(report.adapterId).toBe(VERCEL_AI_SDK_ADAPTER_ID);
    expect(report.adapterVersion).toBe(VERCEL_AI_SDK_ADAPTER_VERSION);
    expect(report.profileId).toBe(VERCEL_AI_SDK_PROFILE_ID);
    expect(report.profileVersion).toBe(VERCEL_AI_SDK_PROFILE_VERSION);
    expect(report.startCapabilityState).toBe("healthy");
    expect(report.resumeCapabilityState).toBe("healthy");
    expect(report.resumeDispatchDecision).toBe("allow");
    expect(report.sideEffectsPerformed).toBe(false);
    expect(report.executionCertaintyImplemented).toBe(false);
    expect(report.authoritativeSettlementImplemented).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(store.records).toHaveLength(1);
  });

  test("authorizes each ToolLoopAgent tool execution before the tool runs", async () => {
    const order: string[] = [];
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        callCount += 1;
        return callCount === 1
          ? toolCallResult("probeTool", "call-1", { value: "local-only" })
          : textResult("done");
      },
    });
    const agent = new ToolLoopAgent({
      id: "stensibly-tool-authorization",
      model,
      tools: {
        probeTool: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => {
            order.push(`execute:${value}`);
            return value;
          },
        }),
      },
    });
    const adapter = new VercelAISDKRunnerAdapter({
      agent,
      checkpointStore: new InMemoryCheckpointStore(),
      authorizeToolExecution: ({ event }) => {
        const toolName = toolNameFromEvent(event);
        order.push(`authorize:${toolName}`);
      },
    });
    await adapter.inspectCapabilities(startProbe());

    const observations = await collect(adapter.start(startCommand()));

    expect(order).toEqual(["authorize:probeTool", "execute:local-only"]);
    expect(observations.at(-1)?.type).toBe("interrupted");
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  test("a rejected tool authorization prevents the local tool effect", async () => {
    let executed = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        toolCallResult("probeTool", "call-denied", { value: "blocked" }),
    });
    const agent = new ToolLoopAgent({
      id: "stensibly-tool-denial",
      model,
      tools: {
        probeTool: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => {
            executed += 1;
            return value;
          },
        }),
      },
    });
    const adapter = new VercelAISDKRunnerAdapter({
      agent,
      checkpointStore: new InMemoryCheckpointStore(),
      authorizeToolExecution: () => {
        throw new Error("Stensibly capability grant rejected the tool proposal");
      },
    });
    await adapter.inspectCapabilities(startProbe());

    const observations = await collect(adapter.start(startCommand()));

    expect(executed).toBe(0);
    expect(observations.at(-1)?.type).toBe("failure_observed");
    expect(
      observations.some(
        (entry) =>
          entry.type === "failure_observed"
          && entry.message.includes("capability grant rejected"),
      ),
    ).toBe(true);
  });

  test("pins the adapter profile to the reviewed AI SDK package version", () => {
    const adapter = new VercelAISDKRunnerAdapter({
      agent: new ToolLoopAgent({
        model: new MockLanguageModelV4({
          doGenerate: async () => textResult("reply"),
        }),
      }),
      checkpointStore: new InMemoryCheckpointStore(),
    });

    expect(VERCEL_AI_SDK_PACKAGE_VERSION).toBe("7.0.58");
    expect(adapter.describe().profiles).toEqual([
      {
        id: VERCEL_AI_SDK_PROFILE_ID,
        version: `ai@${VERCEL_AI_SDK_PACKAGE_VERSION}`,
      },
    ]);
  });
});

function conformanceScenario(): RunnerAdapterConformanceScenarioV1 {
  const start = startCommand();
  const checkpoint = vercelAISDKCheckpointReferenceForStart(start);
  return {
    version: RUNNER_ADAPTER_V1,
    scenarioId: "scenario-vercel-ai-sdk-tool-loop",
    suiteVersion: "1.0.0",
    startCommand: start,
    startProbe: startProbe(),
    resumeCommand: parseRunnerResumeCommandV1({
      ...commandBase("command-resume", "2026-08-09T00:10:00.000Z"),
      kind: "resume",
      continuation: { id: "continuation-ai-sdk-1", generation: 1 },
      adapterResumeRef: checkpoint,
      checkpointRef: checkpoint,
      reason: "continuation",
    }),
    resumeProbe: probe(
      "probe-resume",
      "resume",
      "2026-08-09T00:10:01.000Z",
    ),
    expect: {
      startCapabilityState: "healthy",
      resumeCapabilityState: "healthy",
      resumeDispatchDecision: "allow",
    },
  };
}

function startCommand(): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase("command-start", "2026-08-09T00:00:00.000Z"),
    kind: "start",
  });
}

function commandBase(commandId: string, issuedAt: string) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId,
    correlationId,
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
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove the Vercel AI SDK ToolLoopAgent runner seam.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Prove the Vercel AI SDK ToolLoopAgent runner seam.",
        summary: null,
        nextAction: "Resume from the bounded external checkpoint.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: [`item:${itemId}`],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 512,
    },
    requiredCapabilities: [{ class: "host_dynamic", id: "probeTool" }],
    capabilityGrantRefs: ["grant:ai-sdk-test"],
    issuedAt,
  };
}

function startProbe(): RunnerCapabilityProbeV1 {
  return probe("probe-start", "new", "2026-08-09T00:00:01.000Z");
}

function probe(
  probeId: string,
  transition: "new" | "resume",
  observedAt: string,
): RunnerCapabilityProbeV1 {
  return parseRunnerCapabilityProbeV1({
    version: RUNNER_ADAPTER_V1,
    probeId,
    adapterId: VERCEL_AI_SDK_ADAPTER_ID,
    adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
    profileId: VERCEL_AI_SDK_PROFILE_ID,
    runId,
    runGeneration: 1,
    transport: "in_process",
    transition,
    clientProduct: "vercel-ai-sdk-conformance",
    clientBuild: VERCEL_AI_SDK_PACKAGE_VERSION,
    modelProfile: "MockLanguageModelV4",
    externalSurfaceRef: "surface:vercel-ai-sdk-local",
    requiredCapabilities: [{ class: "host_dynamic", id: "probeTool" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: `trace-${probeId}`,
  });
}

async function collect(
  stream: AsyncIterable<RunnerObservationV1>,
): Promise<RunnerObservationV1[]> {
  const observations: RunnerObservationV1[] = [];
  for await (const observation of stream) observations.push(observation);
  return observations;
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: mockUsage(),
    warnings: [],
  };
}

function toolCallResult(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallType: "function" as const,
        toolCallId,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

function mockUsage() {
  return {
    cachedInputTokens: undefined,
    inputTokens: {
      total: 3,
      noCache: 3,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 10,
      text: 10,
      reasoning: undefined,
    },
  };
}

function toolNameFromEvent(event: unknown): string {
  if (
    event !== null
    && typeof event === "object"
    && "toolCall" in event
    && (event as { toolCall?: unknown }).toolCall !== null
    && typeof (event as { toolCall?: unknown }).toolCall === "object"
    && "toolName" in ((event as { toolCall: object }).toolCall)
  ) {
    return String(
      (event as { toolCall: { toolName: unknown } }).toolCall.toolName,
    );
  }
  return "unknown";
}
