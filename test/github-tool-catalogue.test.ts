import { describe, expect, test } from "bun:test";
import {
  classifyGitHubToolCatalogueChange,
  compileGitHubToolCatalogue,
  githubReadOnlySeedCatalogue,
  searchGitHubTools,
  type GitHubToolCatalogueInput,
  type GitHubToolDefinitionInput,
} from "../src/github-tool-catalogue.ts";

describe("GitHub tool catalogue", () => {
  test("canonicalizes ordering and produces a deterministic immutable fingerprint", () => {
    const first = compileGitHubToolCatalogue(catalogueInput());
    const reorderedInput = catalogueInput();
    reorderedInput.toolsets.reverse();
    for (const toolset of reorderedInput.toolsets) toolset.tools.reverse();
    const second = compileGitHubToolCatalogue(reorderedInput);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.toolsets.map((entry) => entry.name)).toEqual([
      "actions",
      "repos",
    ]);
    expect(first.toolsets[0]?.tools.map((entry) => entry.name)).toEqual([
      "actions_get",
      "actions_list",
    ]);

    const fingerprint = first.fingerprint;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.toolsets)).toBe(true);
    expect(Object.isFrozen(first.toolsets[0])).toBe(true);
    expect(Object.isFrozen(first.toolsets[0]?.tools)).toBe(true);
    expect(Object.isFrozen(first.toolsets[0]?.tools[0]?.inputSchema)).toBe(true);
    expect(() => {
      first.toolsets[0]!.defaultEnabled = !first.toolsets[0]!.defaultEnabled;
    }).toThrow(TypeError);
    expect(() => {
      first.toolsets[0]!.tools[0]!.inputSchema.type = "string";
    }).toThrow(TypeError);
    expect(first.fingerprint).toBe(fingerprint);
  });

  test("rejects duplicate names, malformed schemas, and inconsistent risk", () => {
    const duplicate = catalogueInput();
    duplicate.toolsets[1]!.tools.push(tool("actions_get"));
    expect(() => compileGitHubToolCatalogue(duplicate)).toThrow(
      "Duplicate GitHub tool: actions_get",
    );

    const malformed = catalogueInput();
    malformed.toolsets[0]!.tools[0]!.inputSchema = [] as unknown as Record<string, unknown>;
    expect(() => compileGitHubToolCatalogue(malformed)).toThrow(
      "input schema must be a JSON object",
    );

    const inconsistent = catalogueInput();
    inconsistent.toolsets[0]!.tools[0]!.riskClass = "write";
    expect(() => compileGitHubToolCatalogue(inconsistent)).toThrow(
      "must use read risk exactly when read-only",
    );
  });

  test("searches the bounded catalogue with deterministic filters", () => {
    const results = searchGitHubTools(githubReadOnlySeedCatalogue, {
      query: "workflow actions",
      toolsets: ["actions"],
      readOnly: true,
      limit: 5,
    });

    expect(results.map((entry) => entry.name)).toEqual([
      "actions_get",
      "actions_list",
    ]);
    expect(results.every((entry) => entry.toolset === "actions")).toBe(true);
    expect(() => searchGitHubTools(githubReadOnlySeedCatalogue, {
      query: "actions",
      limit: 101,
    })).toThrow("limit must be between 1 and 100");
  });

  test("classifies additive and compatible catalogue drift", () => {
    const previous = compileGitHubToolCatalogue(catalogueInput());
    const additiveInput = catalogueInput();
    additiveInput.toolsets[1]!.tools.push(tool("get_repository"));
    const additive = classifyGitHubToolCatalogueChange(
      previous,
      compileGitHubToolCatalogue(additiveInput),
    );
    expect(additive).toMatchObject({
      classification: "additive",
      addedTools: ["get_repository"],
      removedTools: [],
    });

    const compatibleInput = catalogueInput();
    compatibleInput.sourceRevision = "github-mcp:test-2";
    compatibleInput.toolsets[0]!.description = "Updated repository description.";
    const compatible = classifyGitHubToolCatalogueChange(
      previous,
      compileGitHubToolCatalogue(compatibleInput),
    );
    expect(compatible.classification).toBe("compatible");
    expect(compatible.reasons).toContain("provider source revision changed");
  });

  test("classifies removals, schema changes, and authority changes as breaking", () => {
    const previous = compileGitHubToolCatalogue(catalogueInput());
    const nextInput = catalogueInput();
    const actions = nextInput.toolsets.find((entry) => entry.name === "actions")!;
    actions.tools = actions.tools.filter((entry) => entry.name !== "actions_get");
    const repositoryTool = nextInput.toolsets
      .find((entry) => entry.name === "repos")!
      .tools.find((entry) => entry.name === "get_file_contents")!;
    repositoryTool.inputSchema = {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
      additionalProperties: false,
    };
    repositoryTool.repositoryScoped = false;

    const change = classifyGitHubToolCatalogueChange(
      previous,
      compileGitHubToolCatalogue(nextInput),
    );
    expect(change.classification).toBe("breaking");
    expect(change.removedTools).toEqual(["actions_get"]);
    expect(change.changedTools).toEqual(["get_file_contents"]);
    expect(change.reasons.some((reason) => reason.includes("input schema"))).toBe(true);
    expect(change.reasons.some((reason) => reason.includes("repository scope"))).toBe(true);
  });

  test("classifies authority and default-exposure changes as breaking", () => {
    const adminInput = catalogueInput();
    const adminTool = adminInput.toolsets
      .find((entry) => entry.name === "repos")!
      .tools.find((entry) => entry.name === "get_file_contents")!;
    adminTool.readOnly = false;
    adminTool.riskClass = "admin";

    const writeInput = catalogueInput();
    const writeTool = writeInput.toolsets
      .find((entry) => entry.name === "repos")!
      .tools.find((entry) => entry.name === "get_file_contents")!;
    writeTool.readOnly = false;
    writeTool.riskClass = "write";

    const riskDowngrade = classifyGitHubToolCatalogueChange(
      compileGitHubToolCatalogue(adminInput),
      compileGitHubToolCatalogue(writeInput),
    );
    expect(riskDowngrade.classification).toBe("breaking");
    expect(riskDowngrade.reasons.some((reason) => reason.includes("risk class"))).toBe(true);

    const readOnlyInput = catalogueInput();
    const writeToRead = classifyGitHubToolCatalogueChange(
      compileGitHubToolCatalogue(writeInput),
      compileGitHubToolCatalogue(readOnlyInput),
    );
    expect(writeToRead.classification).toBe("breaking");
    expect(writeToRead.reasons.some((reason) => reason.includes("read-only capability"))).toBe(true);

    const enabledInput = catalogueInput();
    enabledInput.toolsets.find((entry) => entry.name === "actions")!.defaultEnabled = true;
    const defaultExposure = classifyGitHubToolCatalogueChange(
      compileGitHubToolCatalogue(catalogueInput()),
      compileGitHubToolCatalogue(enabledInput),
    );
    expect(defaultExposure.classification).toBe("breaking");
    expect(defaultExposure.reasons).toContain("breaking toolset default changed: actions");
  });
});

function catalogueInput(): GitHubToolCatalogueInput {
  return {
    version: 1,
    source: "github-mcp",
    sourceRevision: "github-mcp:test-1",
    toolsets: [
      {
        name: "repos",
        description: "Repository reads.",
        defaultEnabled: true,
        tools: [tool("get_file_contents")],
      },
      {
        name: "actions",
        description: "Actions reads.",
        defaultEnabled: false,
        tools: [tool("actions_list"), tool("actions_get")],
      },
    ],
  };
}

function tool(name: string): GitHubToolDefinitionInput {
  return {
    name,
    description: `Read through ${name}.`,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    readOnly: true,
    riskClass: "read",
    repositoryScoped: true,
    requiresApproval: false,
  };
}
