import { describe, expect, test } from "bun:test";
import {
  createMcpReleaseManifest,
  diffMcpReleaseManifests,
  type McpToolContract,
} from "../src/mcp-release-manifest.ts";

const baseSchema = {
  type: "object",
  properties: {
    count: {
      type: "integer",
      minimum: 1,
      maximum: 10,
    },
  },
  required: ["count"],
  additionalProperties: false,
};

describe("MCP release manifest numeric bounds", () => {
  test.each([
    ["minimum", 2, "breaking-contract-change", "$.count: minimum became more restrictive"],
    ["minimum", 0, "compatible-contract-change", "$.count: minimum was relaxed"],
    ["maximum", 9, "breaking-contract-change", "$.count: maximum became more restrictive"],
    ["maximum", 11, "compatible-contract-change", "$.count: maximum was relaxed"],
  ] as const)(
    "classifies %s=%s as %s",
    (keyword, value, classification, reason) => {
      const previous = createMcpReleaseManifest([tool(baseSchema)]);
      const candidate = createMcpReleaseManifest([tool({
        ...baseSchema,
        properties: {
          count: {
            ...baseSchema.properties.count,
            [keyword]: value,
          },
        },
      })]);

      const diff = diffMcpReleaseManifests(previous, candidate);
      expect(diff.classification).toBe(classification);
      expect(diff.changes).toEqual([
        expect.objectContaining({
          name: "bounded_tool",
          kind: classification === "breaking-contract-change"
            ? "breaking"
            : "compatible",
          reasons: expect.arrayContaining([reason]),
        }),
      ]);
    },
  );

  test("treats a newly introduced numeric bound as restrictive in either direction", () => {
    const previous = createMcpReleaseManifest([tool({
      ...baseSchema,
      properties: { count: { type: "integer" } },
    })]);

    for (const candidateCount of [
      { type: "integer", minimum: 0 },
      { type: "integer", maximum: 100 },
    ]) {
      const candidate = createMcpReleaseManifest([tool({
        ...baseSchema,
        properties: { count: candidateCount },
      })]);
      expect(diffMcpReleaseManifests(previous, candidate).classification)
        .toBe("breaking-contract-change");
    }
  });
});

function tool(inputSchema: Record<string, unknown>): McpToolContract {
  return {
    name: "bounded_tool",
    description: "Bounded tool",
    annotations: { readOnlyHint: true },
    inputSchema,
  };
}
