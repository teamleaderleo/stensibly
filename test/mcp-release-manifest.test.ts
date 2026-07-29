import { describe, expect, test } from "bun:test";
import {
  createMcpReleaseManifest,
  diffMcpReleaseManifests,
  type McpToolContract,
} from "../src/mcp-release-manifest.ts";

function tool(
  name: string,
  inputSchema: Record<string, unknown> = {
    type: "object",
    properties: { project: { type: "string" } },
    required: ["project"],
    additionalProperties: false,
  },
  options: {
    description?: string;
    annotations?: Record<string, unknown>;
  } = {},
): McpToolContract {
  return {
    name,
    description: options.description ?? `${name} description`,
    annotations: options.annotations ?? { readOnlyHint: true },
    inputSchema,
  };
}

describe("MCP release manifests", () => {
  test("canonicalizes tool, object, required, type, and enum order", () => {
    const first = createMcpReleaseManifest([
      tool("zeta", {
        required: ["mode", "project"],
        properties: {
          mode: { enum: ["write", "read"], type: ["null", "string"] },
          project: { maxLength: 80, type: "string" },
        },
        type: "object",
      }),
      tool("alpha"),
    ]);
    const reordered = createMcpReleaseManifest([
      tool("alpha"),
      tool("zeta", {
        type: "object",
        properties: {
          project: { type: "string", maxLength: 80 },
          mode: { type: ["string", "null"], enum: ["read", "write"] },
        },
        required: ["project", "mode"],
      }),
    ]);

    expect(reordered.digest).toBe(first.digest);
    expect(first.tools.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("rejects duplicate and invalid public names", () => {
    expect(() => createMcpReleaseManifest([tool("same"), tool("same")]))
      .toThrow("Duplicate MCP tool name");
    expect(() => createMcpReleaseManifest([tool("Bad Name")]))
      .toThrow("Invalid MCP tool name");
  });

  test("classifies an unchanged catalogue as implementation-only", () => {
    const previous = createMcpReleaseManifest([tool("get_brief"), tool("list_work")]);
    const candidate = createMcpReleaseManifest([tool("list_work"), tool("get_brief")]);
    const diff = diffMcpReleaseManifests(previous, candidate);

    expect(diff).toMatchObject({
      classification: "implementation-only",
      refreshRequired: false,
      chatGptAction: "none",
      changes: [],
    });
  });

  test("classifies descriptions and optional inputs as compatible changes", () => {
    const previous = createMcpReleaseManifest([
      tool("get_brief", {
        type: "object",
        properties: {
          project: { type: "string" },
          mode: { enum: ["read"], type: "string" },
        },
        required: ["project"],
        additionalProperties: false,
      }),
    ]);
    const candidate = createMcpReleaseManifest([
      tool("get_brief", {
        additionalProperties: false,
        required: ["project"],
        properties: {
          project: { type: "string" },
          mode: { type: "string", enum: ["read", "summary"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        type: "object",
      }, { description: "A clearer project brief." }),
    ]);
    const diff = diffMcpReleaseManifests(previous, candidate);

    expect(diff.classification).toBe("compatible-contract-change");
    expect(diff.refreshRequired).toBe(true);
    expect(diff.chatGptAction).toBe("refresh-actions");
    expect(diff.changes).toEqual([
      expect.objectContaining({ name: "get_brief", kind: "compatible" }),
    ]);
    expect(diff.changes[0]?.reasons).toEqual(expect.arrayContaining([
      "description changed",
      "$.limit: optional property was added",
      "$.mode: enum values were broadened",
    ]));
  });

  test("classifies added tools as new actions requiring approval", () => {
    const previous = createMcpReleaseManifest([tool("get_brief")]);
    const candidate = createMcpReleaseManifest([
      tool("get_brief"),
      tool("get_release"),
    ]);
    const diff = diffMcpReleaseManifests(previous, candidate);

    expect(diff).toMatchObject({
      classification: "new-actions",
      refreshRequired: true,
      chatGptAction: "refresh-and-approve-actions",
    });
    expect(diff.changes).toContainEqual({
      name: "get_release",
      kind: "added",
      reasons: ["tool was added"],
    });
  });

  test("classifies schema-valued additional properties and patterns conservatively", () => {
    const unrestricted = createMcpReleaseManifest([
      tool("record_event", {
        type: "object",
        properties: { type: { type: "string" } },
      }),
    ]);
    const constrained = createMcpReleaseManifest([
      tool("record_event", {
        type: "object",
        properties: { type: { type: "string" } },
        additionalProperties: { type: "string" },
      }),
    ]);
    const unrestrictedDiff = diffMcpReleaseManifests(unrestricted, constrained);
    expect(unrestrictedDiff.classification).toBe("breaking-contract-change");
    expect(unrestrictedDiff.changes[0]?.reasons).toContain(
      "$.*: unrestricted additional properties became schema-constrained",
    );

    const broadSchema = createMcpReleaseManifest([
      tool("record_event", {
        type: "object",
        additionalProperties: { type: "string", maxLength: 100 },
      }),
    ]);
    const narrowSchema = createMcpReleaseManifest([
      tool("record_event", {
        type: "object",
        additionalProperties: { type: "string", maxLength: 10 },
      }),
    ]);
    const narrowedDiff = diffMcpReleaseManifests(broadSchema, narrowSchema);
    expect(narrowedDiff.classification).toBe("breaking-contract-change");
    expect(narrowedDiff.changes[0]?.reasons).toContain(
      "$.*: maxLength became more restrictive",
    );

    const patterned = createMcpReleaseManifest([
      tool("record_event", {
        type: "object",
        patternProperties: { "^x-": { type: "string" } },
      }),
    ]);
    const patternDiff = diffMcpReleaseManifests(unrestricted, patterned);
    expect(patternDiff.classification).toBe("breaking-contract-change");
    expect(patternDiff.changes[0]?.reasons).toContain(
      "$: patternProperties changed and requires compatibility review",
    );
  });

  test("classifies required inputs, narrowed enums, and removals as breaking", () => {
    const previous = createMcpReleaseManifest([
      tool("create_item", {
        type: "object",
        properties: {
          project: { type: "string" },
          kind: { type: "string", enum: ["task", "finding"] },
          title: { type: "string", maxLength: 240 },
        },
        required: ["project", "title"],
        additionalProperties: false,
      }),
      tool("list_work"),
    ]);
    const candidate = createMcpReleaseManifest([
      tool("create_item", {
        type: "object",
        properties: {
          project: { type: "string" },
          kind: { type: "string", enum: ["task"] },
          title: { type: "string", maxLength: 120 },
        },
        required: ["project", "kind", "title"],
        additionalProperties: false,
      }),
    ]);
    const diff = diffMcpReleaseManifests(previous, candidate);

    expect(diff.classification).toBe("breaking-contract-change");
    expect(diff.refreshRequired).toBe(true);
    expect(diff.chatGptAction).toBe("preserve-compatibility-or-recreate");
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "create_item", kind: "breaking" }),
      expect.objectContaining({ name: "list_work", kind: "removed" }),
    ]));
    const createChange = diff.changes.find((change) => change.name === "create_item");
    expect(createChange?.reasons).toEqual(expect.arrayContaining([
      "$.kind: optional input became required",
      "$.kind: enum values were narrowed",
      "$.title: maxLength became more restrictive",
    ]));
  });
});
