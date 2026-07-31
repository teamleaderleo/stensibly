import { describe, expect, test } from "bun:test";
import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
import {
  admitOpenAIAgentsClockBaseV1,
  bindOpenAIAgentsExecutableToolV1,
  buildOpenAIAgentsRuntimeManifestV1,
  openAIAgentsObservationTimeV1,
  requireOpenAIAgentsRuntimeManifestV1,
  type OpenAIAgentsRuntimeManifestV1,
} from "../src/runner-adapters/openai-agents-runtime-safety.ts";

const secret = "sk-proj-runtime-admission-secret";

describe("OpenAI Agents runtime manifest admission", () => {
  test("admits hostile expected evidence against the exact fresh manifest", () => {
    const expected = structuredClone(manifest());
    const current = manifest();

    const admitted = requireOpenAIAgentsRuntimeManifestV1(expected, current);

    expect(admitted).toBe(current);
    expect(admitted).toEqual(expected);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.agents)).toBe(true);
    expect(Object.isFrozen(admitted.agents[0]?.tools)).toBe(true);
  });

  test("rejects a serialized clone as the current runtime graph", () => {
    const expected = manifest();
    const current = structuredClone(expected);

    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      expected,
      current,
    )).toThrow("OpenAI Agents current runtime manifest is invalid");
  });

  test("rejects accessors without invoking them", () => {
    const accepted = manifest();
    let reads = 0;
    const accessor = { ...accepted } as Record<string, unknown>;
    Object.defineProperty(accessor, "agents", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(secret);
      },
    });

    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      accessor,
      accepted,
    )).toThrow("field agents must be an enumerable data property");
    expect(reads).toBe(0);
  });

  test("rejects unknown fields and forged nested records", () => {
    const accepted = manifest();
    const unknown = structuredClone(accepted) as unknown as Record<string, unknown>;
    unknown.privateState = secret;
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      unknown,
      accepted,
    )).toThrow("manifest fields are invalid");

    const nested = structuredClone(accepted) as unknown as {
      agents: Array<Record<string, unknown>>;
    };
    nested.agents[0]!.privateState = secret;
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      nested,
      accepted,
    )).toThrow("agent 1 fields are invalid");

    const inheritedAgent = Object.create(nested.agents[0]!);
    const inherited = structuredClone(accepted) as unknown as {
      agents: unknown[];
    };
    inherited.agents[0] = inheritedAgent;
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      inherited,
      accepted,
    )).toThrow("agent 1 must be a plain object");
  });

  test("rejects sparse and decorated manifest arrays without invoking methods", () => {
    const accepted = manifest();
    const sparse = structuredClone(accepted) as unknown as {
      agents: unknown[];
    };
    sparse.agents = new Array(1);
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      sparse,
      accepted,
    )).toThrow("must contain dense enumerable data entries");

    const decorated = structuredClone(accepted) as unknown as {
      agents: unknown[];
    };
    Object.defineProperty(decorated.agents, "privateState", {
      value: secret,
      enumerable: false,
    });
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      decorated,
      accepted,
    )).toThrow("contains an unknown field");

    let calls = 0;
    const hostileMap = structuredClone(accepted) as unknown as {
      agents: unknown[];
    };
    Object.defineProperty(hostileMap.agents, "map", {
      enumerable: false,
      get() {
        calls += 1;
        throw new Error(secret);
      },
    });
    expect(() => requireOpenAIAgentsRuntimeManifestV1(
      hostileMap,
      accepted,
    )).toThrow("contains an unknown field");
    expect(calls).toBe(0);
  });

  test("requires exact millisecond UTC timestamps", () => {
    for (const issuedAt of [
      "2026-07-31",
      "2026-07-31T00:00:00Z",
      "2026-07-31T01:00:00.000+01:00",
      "2026-02-30T00:00:00.000Z",
    ]) {
      expect(() => admitOpenAIAgentsClockBaseV1(
        () => new Date("2026-07-31T00:00:00.000Z"),
        issuedAt,
      )).toThrow("OpenAI Agents adapter clock is invalid");
    }
  });

  test("never invokes an overridden Date getTime method", () => {
    const current = new Date("2026-07-31T00:00:02.000Z");
    let calls = 0;
    Object.defineProperty(current, "getTime", {
      value() {
        calls += 1;
        throw new Error(secret);
      },
    });

    const base = admitOpenAIAgentsClockBaseV1(
      () => current,
      "2026-07-31T00:00:01.000Z",
    );
    expect(openAIAgentsObservationTimeV1(base, 1)).toBe(
      "2026-07-31T00:00:02.001Z",
    );
    expect(calls).toBe(0);
  });
});

function manifest(): OpenAIAgentsRuntimeManifestV1 {
  const record = bindOpenAIAgentsExecutableToolV1(tool({
    name: "record_value",
    description: "Record one value.",
    parameters: z.object({ value: z.string() }),
    needsApproval: async () => true,
    execute: ({ value }) => value,
  }), "record-value-v1");
  return buildOpenAIAgentsRuntimeManifestV1(new Agent({
    name: "Root Agent",
    model: "test-model",
    instructions: "Stable instructions",
    tools: [record],
  }));
}
