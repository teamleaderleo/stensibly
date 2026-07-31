import { describe, expect, test } from "bun:test";
import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
import {
  bindOpenAIAgentsExecutableToolV1,
  buildOpenAIAgentsRuntimeManifestV1,
  requireOpenAIAgentsRuntimeManifestV1,
} from "../src/runner-adapters/openai-agents-runtime-safety.ts";

describe("OpenAI Agents runtime identity collisions", () => {
  test("rejects one executable ID reused by distinct qualified tools", () => {
    const first = functionTool("first_tool", "shared-executable-v1");
    const second = functionTool("second_tool", "shared-executable-v1");
    const root = new Agent({
      name: "Root Agent",
      model: "test-model",
      instructions: "Stable instructions",
      tools: [first, second],
    });

    expect(() => buildOpenAIAgentsRuntimeManifestV1(root)).toThrow(
      "duplicates executable tool identity shared-executable-v1",
    );
  });

  test("uses canonical agent and SDK tool tuples for qualified identities", () => {
    const nestedName = new Agent({
      name: "A::B",
      model: "test-model",
      instructions: "Stable instructions",
      tools: [functionTool("C", "nested-name-v1")],
    });
    const splitName = new Agent({
      name: "A",
      model: "test-model",
      instructions: "Stable instructions",
      tools: [functionTool("B::C", "split-name-v1")],
    });
    const root = new Agent({
      name: "Root Agent",
      model: "test-model",
      instructions: "Stable instructions",
      tools: [],
      handoffs: [nestedName, splitName],
    });

    const manifest = buildOpenAIAgentsRuntimeManifestV1(root);
    expect(manifest.agents.flatMap((agent) =>
      agent.tools.map((entry) => [agent.name, entry.name])
    )).toEqual([
      ["A", "B__C"],
      ["A::B", "C"],
    ]);
    expect(manifest.agents.flatMap((agent) =>
      agent.tools.map((entry) => entry.executableId)
    )).toEqual(["split-name-v1", "nested-name-v1"]);
  });

  test("rejects a repeated handoff identity from one agent", () => {
    const child = new Agent({
      name: "Child Agent",
      model: "test-model",
      instructions: "Stable child instructions",
      tools: [],
    });
    const root = new Agent({
      name: "Root Agent",
      model: "test-model",
      instructions: "Stable instructions",
      tools: [],
      handoffs: [child, child],
    });

    expect(() => buildOpenAIAgentsRuntimeManifestV1(root)).toThrow(
      "duplicates handoff identity Child Agent",
    );
  });

  test("uses the executable revision as the closure-semantic identity", () => {
    const first = buildOpenAIAgentsRuntimeManifestV1(graphWithCapturedValue(
      "first",
      "captured-tool-v1",
    ));
    const changed = buildOpenAIAgentsRuntimeManifestV1(graphWithCapturedValue(
      "second",
      "captured-tool-v2",
    ));

    expect(first.agents[0]?.tools[0]?.invokeDigest).toBe(
      changed.agents[0]?.tools[0]?.invokeDigest,
    );
    expect(() => requireOpenAIAgentsRuntimeManifestV1(first, changed)).toThrow(
      "runtime graph identity is stale",
    );
  });

  test("rejects unsupported behavior-changing function-tool fields", () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.allowedCallers = ["direct"];
      },
      (value) => {
        value.providerData = { mode: "different" };
      },
      (value) => {
        value.outputSchema = { type: "object" };
      },
      (value) => {
        value.errorFunction = async () => "fallback";
      },
      (value) => {
        value.timeoutMs = 10;
      },
      (value) => {
        value.timeoutBehavior = "raise_exception";
      },
      (value) => {
        value.timeoutErrorFunction = async () => "timeout";
      },
      (value) => {
        value.customDataExtractor = () => ({ private: true });
      },
      (value) => {
        value.inputGuardrails = [{ name: "input", run: async () => ({}) }];
      },
      (value) => {
        value.outputGuardrails = [{ name: "output", run: async () => ({}) }];
      },
    ];

    for (const mutate of mutations) {
      const candidate = functionTool("policy_tool", "policy-tool-v1");
      mutate(candidate as unknown as Record<string, unknown>);
      expect(() => buildOpenAIAgentsRuntimeManifestV1(new Agent({
        name: "Root Agent",
        model: "test-model",
        instructions: "Stable instructions",
        tools: [candidate],
      }))).toThrow("uses unsupported first-slice policy");
    }
  });
});

function graphWithCapturedValue(value: string, executableId: string) {
  return new Agent({
    name: "Root Agent",
    model: "test-model",
    instructions: "Stable instructions",
    tools: [functionTool(
      "captured_tool",
      executableId,
      () => value,
    )],
  });
}

function functionTool(
  name: string,
  executableId: string,
  execute: (input: { value?: string }) => string = ({ value }) => value ?? name,
) {
  return bindOpenAIAgentsExecutableToolV1(tool({
    name,
    description: `Execute ${name}.`,
    parameters: z.object({ value: z.string().optional() }),
    needsApproval: async () => true,
    execute,
  }), executableId);
}
