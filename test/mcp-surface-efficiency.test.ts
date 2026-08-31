import { describe, expect, test } from "bun:test";
import {
  assertCompactPublishedSurface,
  measureMcpSurface,
  publishedSurfaceBudgets,
} from "../src/mcp-surface-efficiency.ts";

describe("published MCP surface efficiency", () => {
  test("measures the declared context tax and enforces every budget", () => {
    const receipt = measureMcpSurface([{
      name: "brief",
      title: "Brief",
      description: "Read work.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    }], "Start here.");

    expect(receipt.toolCount).toBe(1);
    expect(receipt.wireNameChars).toBe(5);
    expect(receipt.largestTools).toEqual([{
      name: "brief",
      chars: expect.any(Number),
    }]);
    expect(() => assertCompactPublishedSurface(receipt)).not.toThrow();

    expect(() => assertCompactPublishedSurface({
      ...receipt,
      catalogueChars: publishedSurfaceBudgets.catalogueChars + 1,
    })).toThrow("catalogueChars");
  });
});
