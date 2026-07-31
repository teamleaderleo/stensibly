import { describe, expect, test } from "bun:test";
import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
import {
  bindOpenAIAgentsExecutableToolV1,
  buildOpenAIAgentsRuntimeManifestV1,
} from "../src/runner-adapters/openai-agents-runtime-safety.ts";

describe("OpenAI Agents runtime identity collisions", () => {
  test("rejects one executable ID reused by distinct qualified tools", () => {
    const first = functionTool("first_tool", "shared-executable-v1");
    const second = functionTool("second_tool", "shared-executable-v1");
    const root = new Agent({
      name: "Root Agent",
      instructions: "Stable instructions",
      tools: [first, second],
    });

    expect(() => buildOpenAIAgentsRuntimeManifestV1(root)).toThrow(
      "duplicates executable tool identity shared-executable-v1",
    );
  });

  test("uses canonical tuples for qualified identities", () => {
    const nestedName = new Agent({
      name: "A::B",
      instructions: "Stable instructions",
      tools: [functionTool("C", "nested-name-v1")],
    });
    const splitName = new Agent({
      name: "A",
      instructions: "Stable instructions",
      tools: [functionTool("B::C", "split-name-v1")],
    });
    const root = new Agent({
      name: "Root Agent",
      instructions: "Stable instructions",
      tools: [],
      handoffs: [nestedName, splitName],
    });

    const manifest = buildOpenAIAgentsRuntimeManifestV1(root);
    expect(manifest.agents.flatMap((agent) =>
      agent.tools.map((entry) => entry.qualifiedName)
    )).toEqual(["A::B::C", "A::B::C"]);
    expect(manifest.agents.flatMap((agent) =>
      agent.tools.map((entry) => entry.executableId)
    )).toEqual(["split-name-v1", "nested-name-v1"]);
  });

  test("rejects a repeated handoff identity from one agent", () => {
    const child = new Agent({
      name: "Child Agent",
      instructions: "Stable child instructions",
      tools: [],
    });
    const root = new Agent({
      name: "Root Agent",
      instructions: "Stable instructions",
      tools: [],
      handoffs: [child, child],
    });

    expect(() => buildOpenAIAgentsRuntimeManifestV1(root)).toThrow(
      "duplicates handoff identity Child Agent",
    );
  });
});

function functionTool(name: string, executableId: string) {
  return bindOpenAIAgentsExecutableToolV1(tool({
    name,
    description: `Execute ${name}.`,
    parameters: z.object({ value: z.string().optional() }),
    needsApproval: async () => true,
    execute: ({ value }) => value ?? name,
  }), executableId);
}
