import { describe, expect, test } from "bun:test";
import { compactPublicMcpResult } from "../src/public-mcp-result.ts";

describe("compact public MCP results", () => {
  test("keeps small JSON readable for compatibility", () => {
    const result = compactPublicMcpResult({
      content: [{ type: "text", text: "old" }],
      structuredContent: { data: { status: "ready" } },
    }) as Record<string, unknown>;
    expect(result.content).toEqual([{
      type: "text",
      text: '{"status":"ready"}',
    }]);
  });

  test("replaces a duplicated large text payload with one deterministic digest", () => {
    const result = compactPublicMcpResult({
      content: [{ type: "text", text: "old" }],
      structuredContent: { data: { body: "x".repeat(3_000) } },
    }) as Record<string, unknown>;
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringMatching(
        /^\{"structured":true,"sha256":"sha256:[a-f0-9]{64}"\}$/,
      ),
    }]);
    expect(JSON.stringify(result.content)).not.toContain("x".repeat(100));
  });
});
