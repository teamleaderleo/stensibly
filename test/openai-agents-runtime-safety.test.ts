import { describe, expect, test } from "bun:test";
import { Agent, tool, type FunctionTool } from "@openai/agents-core";
import { z } from "zod";
import {
  admitOpenAIAgentsClockBaseV1,
  bindOpenAIAgentsExecutableToolV1,
  bindOpenAIAgentsModelV1,
  buildOpenAIAgentsRuntimeManifestV1,
  openAIAgentsObservationTimeV1,
  requireOpenAIAgentsRuntimeManifestV1,
  type OpenAIAgentsRuntimeManifestV1,
} from "../src/runner-adapters/openai-agents-runtime-safety.ts";

const secret = "sk-proj-runtime-manifest-secret";

describe("OpenAI Agents runtime safety", () => {
  test("builds a deeply frozen content-minimised manifest from the actual SDK graph", () => {
    let toolCalls = 0;
    const child = agent("Child Agent", "Child instructions", [
      functionTool("child_record", "child-record-v1", () => {
        toolCalls += 1;
        return "child";
      }),
    ]);
    const root = agent("Root Agent", `Do not expose ${secret}`, [
      functionTool("record_value", "record-value-v1", () => {
        toolCalls += 1;
        return "root";
      }),
    ], [child]);

    const manifest = buildOpenAIAgentsRuntimeManifestV1(root);

    expect(manifest).toMatchObject({
      version: 1,
      rootAgentName: "Root Agent",
      agents: [
        {
          name: "Child Agent",
          modelKind: "string",
          modelIdentity: "test-model",
          handoffAgentNames: [],
          tools: [{
            name: "child_record",
            executableId: "child-record-v1",
          }],
        },
        {
          name: "Root Agent",
          modelKind: "string",
          modelIdentity: "test-model",
          handoffAgentNames: ["Child Agent"],
          tools: [{
            name: "record_value",
            executableId: "record-value-v1",
          }],
        },
      ],
    });
    expect(manifest.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.agents)).toBe(true);
    expect(Object.isFrozen(manifest.agents[0]?.tools)).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(secret);
    expect(JSON.stringify(manifest)).not.toContain("return \"root\"");
    expect(toolCalls).toBe(0);
  });

  test("reconstructs the same identity and rejects instruction or graph drift", () => {
    const first = buildOpenAIAgentsRuntimeManifestV1(runtimeGraph());
    const replay = buildOpenAIAgentsRuntimeManifestV1(runtimeGraph());
    const admitted = requireOpenAIAgentsRuntimeManifestV1(first, replay);
    expect(admitted).toBe(replay);

    const changedInstructions = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Changed instructions", [
        functionTool("record_value", "record-value-v1", () => "recorded"),
      ]),
    );
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      first,
      changedInstructions,
    )).toThrow("runtime graph identity is stale");

    const removedTool = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", []),
    );
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      first,
      removedTool,
    )).toThrow("runtime graph identity is stale");

    const renamedTool = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [
        functionTool("record_other", "record-value-v1", () => "recorded"),
      ]),
    );
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      first,
      renamedTool,
    )).toThrow("runtime graph identity is stale");

    const replacedTool = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [
        functionTool("record_value", "record-value-v2", () => "replacement"),
      ]),
    );
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      first,
      replacedTool,
    )).toThrow("runtime graph identity is stale");
  });

  test("binds exact string and object model identities", () => {
    const stringModel = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [], [], "test-model"),
    );
    const changedStringModel = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [], [], "other-model"),
    );
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      stringModel,
      changedStringModel,
    )).toThrow("runtime graph identity is stale");

    const firstModel = scriptedModel("first");
    expect(() => buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [], [], firstModel),
    )).toThrow("object model lacks a revision");

    bindOpenAIAgentsModelV1(firstModel, "scripted-model-v1");
    expect(bindOpenAIAgentsModelV1(
      firstModel,
      "scripted-model-v1",
    )).toBe(firstModel);
    expect(() => bindOpenAIAgentsModelV1(
      firstModel,
      "scripted-model-v2",
    )).toThrow("already bound to a different revision");

    const replayModel = bindOpenAIAgentsModelV1(
      scriptedModel("first"),
      "scripted-model-v1",
    );
    const changedModel = bindOpenAIAgentsModelV1(
      scriptedModel("second"),
      "scripted-model-v2",
    );
    const firstManifest = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [], [], firstModel),
    );
    const replayManifest = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [], [], replayModel),
    );
    const changedManifest = buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [], [], changedModel),
    );
    expect(requireOpenAIAgentsRuntimeManifestV1(
      firstManifest,
      replayManifest,
    )).toBe(replayManifest);
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      firstManifest,
      changedManifest,
    )).toThrow("runtime graph identity is stale");
  });

  test("rejects duplicate agent and qualified tool identities", () => {
    const duplicateToolGraph = agent("Root Agent", "Stable instructions", [
      functionTool("record_value", "record-value-v1", () => "first"),
      functionTool("record_value", "record-value-v2", () => "second"),
    ]);
    expect(() => buildOpenAIAgentsRuntimeManifestV1(
      duplicateToolGraph,
    )).toThrow('duplicates qualified tool identity ["Root Agent","record_value"]');

    const firstDuplicate = agent("Duplicate Agent", "First", []);
    const secondDuplicate = agent("Duplicate Agent", "Second", []);
    const duplicateAgentGraph = agent(
      "Root Agent",
      "Stable instructions",
      [],
      [
        agent("Left Parent", "Left", [], [firstDuplicate]),
        agent("Right Parent", "Right", [], [secondDuplicate]),
      ],
    );
    expect(() => buildOpenAIAgentsRuntimeManifestV1(
      duplicateAgentGraph,
    )).toThrow("duplicates agent identity Duplicate Agent");
  });

  test("requires every function tool to carry a stable executable identity", () => {
    const unbound = tool({
      name: "unbound_tool",
      description: "This tool deliberately lacks a private executable identity.",
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => value,
    });
    expect(() => buildOpenAIAgentsRuntimeManifestV1(
      agent("Root Agent", "Stable instructions", [unbound]),
    )).toThrow("lacks an executable identity");

    const bound = bindOpenAIAgentsExecutableToolV1(unbound, "unbound-tool-v1");
    expect(bindOpenAIAgentsExecutableToolV1(
      bound,
      "unbound-tool-v1",
    )).toBe(bound);
    expect(() => bindOpenAIAgentsExecutableToolV1(
      bound,
      "unbound-tool-v2",
    )).toThrow("already bound to a different executable ID");
  });

  test("rejects credential-shaped public identifiers with fixed prose", () => {
    const attempts: Array<() => unknown> = [
      () => buildOpenAIAgentsRuntimeManifestV1(
        agent("team:sk-proj-runtime-secret", "Stable", []),
      ),
      () => buildOpenAIAgentsRuntimeManifestV1(
        agent("Root Agent", "Stable", [], [], "model:github_pat_runtime_secret"),
      ),
      () => bindOpenAIAgentsExecutableToolV1(tool({
        name: "record_value",
        description: "Record one value.",
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => value,
      }), "tool:stn.tok_runtime_secret"),
      () => bindOpenAIAgentsModelV1(
        scriptedModel("first"),
        "revision:xoxb-runtime-secret",
      ),
      () => buildOpenAIAgentsRuntimeManifestV1(
        agent("Root Agent", "Stable", [], [], "env://runtime-secret"),
      ),
      () => buildOpenAIAgentsRuntimeManifestV1(
        agent("Root Agent", "Stable", [], [], "secret://runtime-secret"),
      ),
    ];

    for (const attempt of attempts) {
      let message = "";
      try {
        attempt();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("OpenAI Agents runtime identifier is invalid");
      expect(message).not.toContain("runtime-secret");
    }
  });

  test("rejects dynamic instruction and tool-use closures in the first slice", () => {
    const dynamicInstructions = new Agent({
      name: "Dynamic Instructions Agent",
      model: "test-model",
      instructions: () => "dynamic",
      tools: [],
    });
    expect(() => buildOpenAIAgentsRuntimeManifestV1(
      dynamicInstructions,
    )).toThrow("uses unsupported dynamic instructions");

    const dynamicToolUse = agent("Dynamic Tool Use Agent", "Stable", []);
    dynamicToolUse.toolUseBehavior = () => ({
      isFinalOutput: false,
      isInterrupted: undefined,
    });
    expect(() => buildOpenAIAgentsRuntimeManifestV1(
      dynamicToolUse,
    )).toThrow("uses unsupported dynamic tool-use behavior");
  });

  test("rejects forged manifest fingerprints", () => {
    const accepted = buildOpenAIAgentsRuntimeManifestV1(runtimeGraph());
    const forged = structuredClone(accepted) as OpenAIAgentsRuntimeManifestV1;
    Object.defineProperty(forged, "fingerprint", {
      value: `sha256:${"0".repeat(64)}`,
      enumerable: true,
    });
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      forged,
      accepted,
    )).toThrow("manifest fingerprint is invalid");
  });

  test("admits the clock once and derives every later timestamp purely", () => {
    let calls = 0;
    const base = admitOpenAIAgentsClockBaseV1(
      () => {
        calls += 1;
        if (calls > 1) throw new Error(`clock exposed ${secret}`);
        return new Date("2026-07-31T00:00:00.000Z");
      },
      "2026-07-31T00:00:01.000Z",
    );

    expect(openAIAgentsObservationTimeV1(base, 0)).toBe(
      "2026-07-31T00:00:01.000Z",
    );
    expect(openAIAgentsObservationTimeV1(base, 2)).toBe(
      "2026-07-31T00:00:01.002Z",
    );
    expect(openAIAgentsObservationTimeV1(base, 9)).toBe(
      "2026-07-31T00:00:01.009Z",
    );
    expect(calls).toBe(1);
  });

  test("redacts hostile or invalid clock admission", () => {
    for (const now of [
      () => {
        throw new Error(`clock provider exposed ${secret}`);
      },
      () => new Date(Number.NaN),
      () => ({ getTime: () => 0 }) as unknown as Date,
    ]) {
      let message = "";
      try {
        admitOpenAIAgentsClockBaseV1(
          now,
          "2026-07-31T00:00:00.000Z",
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("OpenAI Agents adapter clock is invalid");
      expect(message).not.toContain(secret);
    }

    const base = admitOpenAIAgentsClockBaseV1(
      () => new Date("2026-07-31T00:00:00.000Z"),
      "2026-07-31T00:00:00.000Z",
    );
    expect(() => openAIAgentsObservationTimeV1(base, -1)).toThrow(
      "OpenAI Agents adapter clock is invalid",
    );
    expect(() => openAIAgentsObservationTimeV1(
      structuredClone(base),
      1,
    )).toThrow("OpenAI Agents adapter clock is invalid");
  });
});

function runtimeGraph() {
  return agent("Root Agent", "Stable instructions", [
    functionTool("record_value", "record-value-v1", () => "recorded"),
  ]);
}

function agent(
  name: string,
  instructions: string,
  tools: FunctionTool<any, any, any>[],
  handoffs: Agent<any, any>[] = [],
  model: string | object = "test-model",
): Agent<any, any> {
  return new Agent({
    name,
    model: model as any,
    instructions,
    tools,
    handoffs,
  });
}

function functionTool(
  name: string,
  executableId: string,
  execute: () => string,
) {
  return bindOpenAIAgentsExecutableToolV1(tool({
    name,
    description: `Execute ${name}.`,
    parameters: z.object({ value: z.string().optional() }),
    needsApproval: async () => true,
    execute,
  }), executableId);
}

function scriptedModel(response: string): object {
  return {
    getResponse: async () => response,
    getStreamedResponse: async function* () {
      yield response;
    },
  };
}
