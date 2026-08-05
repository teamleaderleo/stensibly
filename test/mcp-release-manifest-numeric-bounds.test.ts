import { describe, expect, test } from "bun:test";
import {
  createMcpReleaseManifest,
  diffMcpReleaseManifests,
  type McpReleaseManifest,
  type McpToolContract,
} from "../src/mcp-release-manifest.ts";

const boundCases = [
  ["minimum", 1, 2, 0],
  ["exclusiveMinimum", 1, 2, 0],
  ["minLength", 1, 2, 0],
  ["minItems", 1, 2, 0],
  ["minProperties", 1, 2, 0],
  ["maximum", 10, 9, 11],
  ["exclusiveMaximum", 10, 9, 11],
  ["maxLength", 10, 9, 11],
  ["maxItems", 10, 9, 11],
  ["maxProperties", 10, 9, 11],
] as const;

describe("MCP release manifest numeric bounds", () => {
  test.each(boundCases)(
    "preserves restrictive and relaxed classification for %s",
    (keyword, baseline, restrictive, relaxed) => {
      const previous = manifest(keyword, baseline);

      expectChange(
        previous,
        manifest(keyword, restrictive),
        "breaking-contract-change",
        `${keyword} became more restrictive`,
      );
      expectChange(
        previous,
        manifest(keyword, relaxed),
        "compatible-contract-change",
        `${keyword} was relaxed`,
      );
    },
  );

  test.each(boundCases)(
    "treats a newly introduced %s bound as restrictive",
    (keyword, baseline) => {
      expectChange(
        manifest(),
        manifest(keyword, baseline),
        "breaking-contract-change",
        `${keyword} became more restrictive`,
      );
    },
  );
});

function manifest(keyword?: string, value?: number): McpReleaseManifest {
  return createMcpReleaseManifest([tool({
    type: "object",
    properties: {
      count: {
        type: "number",
        ...(keyword === undefined ? {} : { [keyword]: value }),
      },
    },
    required: ["count"],
    additionalProperties: false,
  })]);
}

function expectChange(
  previous: McpReleaseManifest,
  candidate: McpReleaseManifest,
  classification: "compatible-contract-change" | "breaking-contract-change",
  reason: string,
): void {
  const diff = diffMcpReleaseManifests(previous, candidate);
  expect(diff.classification).toBe(classification);
  expect(diff.changes).toEqual([
    expect.objectContaining({
      name: "bounded_tool",
      kind: classification === "breaking-contract-change"
        ? "breaking"
        : "compatible",
      reasons: expect.arrayContaining([`$.count: ${reason}`]),
    }),
  ]);
}

function tool(inputSchema: Record<string, unknown>): McpToolContract {
  return {
    name: "bounded_tool",
    description: "Bounded tool",
    annotations: { readOnlyHint: true },
    inputSchema,
  };
}
