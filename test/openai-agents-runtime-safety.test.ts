import { describe, expect, test } from "bun:test";
import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
import {
  bindOpenAIAgentsExecutableToolV1,
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
          handoffAgentNames: [],
          tools: [{
            qualifiedName: "Child Agent::child_record",
            executableId: "child-record-v1",
          }],
        },
        {
          name: "Root Agent",
          handoffAgentNames: ["Child Agent"],
          tools: [{
            qualifiedName: "Root Agent::record_value",
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
    expect(requireOpenAIAgentsRuntimeManifestV1(first, replay)).toBe(replay);

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

  test("rejects duplicate agent and qualified tool identities", () => {
    const duplicateToolGraph = agent("Root Agent", "Stable instructions", [
      functionTool("record_value", "record-value-v1", () => "first"),
      functionTool("record_value", "record-value-v2", () => "second"),
    ]);
    expect(() => buildOpenAIAgentsRuntimeManifestV1(
      duplicateToolGraph,
    )).toThrow("duplicates qualified tool identity Root Agent::record_value");

    const duplicateAgentGraph = agent(
      "Root Agent",
      "Stable instructions",
      [],
      [
        agent("Duplicate Agent", "First", []),
        agent("Duplicate Agent", "Second", []),
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
    )).toThrow("runtime graph identity is stale");
  });

  test("admits one finite observation time and redacts hostile clock failures", () => {
    expect(openAIAgentsObservationTimeV1(
      () => new Date("2026-07-31T00:00:00.000Z"),
      "2026-07-31T00:00:01.000Z",
      2,
    )).toBe("2026-07-31T00:00:01.002Z");

    for (const now of [
      () => {
        throw new Error(`clock provider exposed ${secret}`);
      },
      () => new Date(Number.NaN),
      () => ({ getTime: () => 0 }) as unknown as Date,
    ]) {
      let message = "";
      try {
        openAIAgentsObservationTimeV1(
          now,
          "2026-07-31T00:00:00.000Z",
          1,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("OpenAI Agents adapter clock is invalid");
      expect(message).not.toContain(secret);
    }

    expect(() => openAIAgentsObservationTimeV1(
      () => new Date("2026-07-31T00:00:00.000Z"),
      "not-a-timestamp",
      1,
    )).toThrow("OpenAI Agents adapter clock is invalid");
    expect(() => openAIAgentsObservationTimeV1(
      () => new Date("2026-07-31T00:00:00.000Z"),
      "2026-07-31T00:00:00.000Z",
      -1,
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
  tools: ReturnType<typeof functionTool>[],
  handoffs: Agent<any, any>[] = [],
): Agent<any, any> {
  return new Agent({
    name,
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
