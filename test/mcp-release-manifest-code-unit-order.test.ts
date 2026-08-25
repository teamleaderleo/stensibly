import { expect, test } from "bun:test";
import { createMcpReleaseManifest } from "../src/mcp-release-manifest.ts";

test("MCP release manifest ordering is literal and locale-independent", () => {
  const supplementary = "\u{10000}";
  const privateUse = "\uE000";

  const first = createMcpReleaseManifest([{
    name: "unicode_order",
    annotations: {
      [privateUse]: true,
      [supplementary]: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        [privateUse]: { enum: [privateUse, supplementary], type: "string" },
        [supplementary]: { type: "string" },
      },
      required: [privateUse, supplementary],
      additionalProperties: false,
    },
  }]);
  const reordered = createMcpReleaseManifest([{
    name: "unicode_order",
    annotations: {
      [supplementary]: false,
      [privateUse]: true,
    },
    inputSchema: {
      additionalProperties: false,
      required: [supplementary, privateUse],
      properties: {
        [supplementary]: { type: "string" },
        [privateUse]: { type: "string", enum: [supplementary, privateUse] },
      },
      type: "object",
    },
  }]);

  expect(reordered.digest).toBe(first.digest);
  expect(Object.keys(first.tools[0]!.annotations)).toEqual([
    supplementary,
    privateUse,
  ]);
  const schema = first.tools[0]!.inputSchema;
  const properties = schema.properties as Record<string, unknown>;
  expect(Object.keys(properties)).toEqual([supplementary, privateUse]);
  expect(schema.required).toEqual([supplementary, privateUse]);
  expect((properties[privateUse] as { enum: string[] }).enum).toEqual([
    supplementary,
    privateUse,
  ]);
});
