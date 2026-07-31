import { describe, expect, test } from "bun:test";
import {
  compileGitHubToolCatalogue,
  type GitHubToolCatalogueInput,
  type GitHubToolDefinitionInput,
} from "../src/github-tool-catalogue.ts";
import {
  resolveGitHubToolsetProfileSelection,
} from "../src/github-toolset-profile-selection.ts";

type SelectionInput = Parameters<typeof resolveGitHubToolsetProfileSelection>[1];

describe("GitHub toolset profile catalogue selection", () => {
  test("inherits additive tools from every selected reviewed toolset", () => {
    const first = resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      { profile: "actions", providerMode: "remote" },
    );
    const expandedInput = catalogueInput();
    expandedInput.toolsets.find((toolset) => toolset.name === "actions")!
      .tools.push(tool("get_workflow_job", true));
    const expanded = resolveGitHubToolsetProfileSelection(
      expandedInput,
      { profile: "actions", providerMode: "remote" },
    );

    expect(first.tools.map((entry) => entry.name)).toEqual([
      "list_workflow_runs",
      "rerun_workflow",
    ]);
    expect(expanded.tools.map((entry) => entry.name)).toEqual([
      "get_workflow_job",
      "list_workflow_runs",
      "rerun_workflow",
    ]);
    expect(expanded.selectedToolsets).toEqual(["actions"]);
    expect(expanded.catalogueMissingToolsets).toEqual([]);
    expect(expanded.selectionFingerprint).not.toBe(first.selectionFingerprint);
  });

  test("quarantines newly observed toolsets until inventory review", () => {
    const expandedInput = catalogueInput();
    expandedInput.toolsets.push({
      name: "new_provider_surface",
      description: "A newly observed official provider toolset.",
      defaultEnabled: false,
      tools: [
        tool("new_provider_read", true),
        tool("new_provider_write", false),
      ],
    });
    const remote = resolveGitHubToolsetProfileSelection(expandedInput, {
      profile: "all",
      providerMode: "remote",
      additionalTools: ["new_provider_read"],
    });
    const remoteReadOnly = resolveGitHubToolsetProfileSelection(expandedInput, {
      profile: "read_only",
      providerMode: "remote",
    });
    const local = resolveGitHubToolsetProfileSelection(expandedInput, {
      profile: "all",
      providerMode: "local",
    });

    for (const selection of [remote, remoteReadOnly, local]) {
      expect(selection.catalogueAddedToolsets).toEqual(["new_provider_surface"]);
      expect(selection.selectedToolsets).not.toContain("new_provider_surface");
      expect(selection.tools.map((entry) => entry.name)).not.toContain(
        "new_provider_read",
      );
      expect(selection.tools.map((entry) => entry.name)).not.toContain(
        "new_provider_write",
      );
    }
    expect(remote.omittedAdditionalTools).toEqual([{
      name: "new_provider_read",
      reason: "toolset_pending_review",
    }]);
  });

  test("adds exact tools outside the profile and applies exclusions last", () => {
    const selection = resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      {
        profile: "actions",
        providerMode: "remote",
        additionalTools: ["get_file_contents"],
        excludedTools: ["future_destructive_tool", "rerun_workflow"],
      },
    );

    expect(selection.tools.map((entry) => entry.name)).toEqual([
      "get_file_contents",
      "list_workflow_runs",
    ]);
    expect(selection.additionalTools).toEqual(["get_file_contents"]);
    expect(selection.excludedTools).toEqual([
      "future_destructive_tool",
      "rerun_workflow",
    ]);
  });

  test("explains provider, read-only, and exclusion omissions", () => {
    const selection = resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      {
        profile: "read_only",
        providerMode: "local",
        additionalTools: [
          "copilot_space_search",
          "get_file_contents",
          "rerun_workflow",
        ],
        excludedTools: ["get_file_contents"],
      },
    );

    expect(selection.profile.omittedToolsets).toContain("copilot_spaces");
    expect(selection.tools.map((entry) => entry.name)).toEqual([
      "list_workflow_runs",
    ]);
    expect(selection.omittedAdditionalTools).toEqual([
      { name: "copilot_space_search", reason: "provider_unavailable" },
      { name: "get_file_contents", reason: "excluded" },
      { name: "rerun_workflow", reason: "read_only" },
    ]);
  });

  test("reports profile toolsets absent from the exact catalogue", () => {
    const selection = resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      { profile: "default", providerMode: "remote" },
    );

    expect(selection.selectedToolsets).toEqual(["repos"]);
    expect(selection.catalogueMissingToolsets).toEqual([
      "context",
      "issues",
      "pull_requests",
      "users",
    ]);
  });

  test("recompiles untrusted catalogues before trusting authority metadata", () => {
    const compiled = compileGitHubToolCatalogue(catalogueInput());
    const forged = {
      ...compiled,
      fingerprint: `sha256:${"0".repeat(64)}`,
    } as unknown as GitHubToolCatalogueInput;

    expect(() => resolveGitHubToolsetProfileSelection(forged, {
      profile: "read_only",
      providerMode: "remote",
    })).toThrow("GitHub tool catalogue has unknown field fingerprint");

    const relabeled = catalogueInput();
    const writeTool = relabeled.toolsets
      .find((toolset) => toolset.name === "actions")!
      .tools.find((entry) => entry.name === "rerun_workflow")!;
    writeTool.readOnly = true;
    expect(() => resolveGitHubToolsetProfileSelection(relabeled, {
      profile: "read_only",
      providerMode: "remote",
    })).toThrow("must use read risk exactly when read-only");
  });

  test("snapshots untrusted catalogue JSON without invoking accessors", () => {
    let sourceReads = 0;
    const sourceAccessor = catalogueInput();
    Object.defineProperty(sourceAccessor, "sourceRevision", {
      enumerable: true,
      get() {
        sourceReads += 1;
        return "github/github-mcp-server:accessor";
      },
    });
    expect(() => resolveGitHubToolsetProfileSelection(sourceAccessor, {
      profile: "actions",
      providerMode: "remote",
    })).toThrow("field must be an enumerable data property");
    expect(sourceReads).toBe(0);

    let readOnlyReads = 0;
    const toolAccessor = catalogueInput();
    const writeTool = toolAccessor.toolsets
      .find((toolset) => toolset.name === "actions")!
      .tools.find((entry) => entry.name === "rerun_workflow")!;
    Object.defineProperty(writeTool, "readOnly", {
      enumerable: true,
      get() {
        readOnlyReads += 1;
        return true;
      },
    });
    expect(() => resolveGitHubToolsetProfileSelection(toolAccessor, {
      profile: "read_only",
      providerMode: "remote",
    })).toThrow("field must be an enumerable data property");
    expect(readOnlyReads).toBe(0);

    const decorated = catalogueInput();
    Object.defineProperty(decorated.toolsets, "credentialRef", {
      enumerable: false,
      value: "secret://hidden",
    });
    expect(() => resolveGitHubToolsetProfileSelection(decorated, {
      profile: "actions",
      providerMode: "remote",
    })).toThrow("array contains unknown field credentialRef");

    const symbolic = catalogueInput();
    Object.defineProperty(symbolic.toolsets[0]!.tools[0]!, Symbol("credential"), {
      value: "github_pat_secret",
    });
    expect(() => resolveGitHubToolsetProfileSelection(symbolic, {
      profile: "actions",
      providerMode: "remote",
    })).toThrow("contains a symbol field");

    const nullPrototype = Object.assign(
      Object.create(null),
      catalogueInput(),
    ) as GitHubToolCatalogueInput;
    expect(resolveGitHubToolsetProfileSelection(nullPrototype, {
      profile: "actions",
      providerMode: "remote",
    }).catalogueFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("bounds catalogue JSON strings and aggregate encoded bytes", () => {
    const oversizedString = catalogueInput();
    oversizedString.toolsets[0]!.tools[0]!.inputSchema = {
      type: "object",
      properties: {
        value: {
          type: "string",
          description: "x".repeat(512 * 1024 + 1),
        },
      },
      required: [],
      additionalProperties: false,
    };
    expect(() => resolveGitHubToolsetProfileSelection(oversizedString, {
      profile: "default",
      providerMode: "remote",
    })).toThrow("exceeds 524288 UTF-8 bytes");

    const aggregate = catalogueInput();
    const chunk = "x".repeat(256 * 1024);
    aggregate.toolsets[0]!.tools[0]!.inputSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [
          `field_${index}`,
          { type: "string", description: chunk },
        ]),
      ),
      required: [],
      additionalProperties: false,
    };
    expect(() => resolveGitHubToolsetProfileSelection(aggregate, {
      profile: "default",
      providerMode: "remote",
    })).toThrow("exceeds 8388608 UTF-8 bytes");
  });

  test("admits exact plain selection records without invoking accessors", () => {
    const nullPrototype = Object.assign(Object.create(null), {
      profile: "actions",
      providerMode: "remote",
    }) as SelectionInput;
    expect(resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      nullPrototype,
    ).profile.name).toBe("actions");

    const inherited = Object.create({
      profile: "actions",
      providerMode: "remote",
    }) as SelectionInput;
    expect(() => resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      inherited,
    )).toThrow("GitHub toolset profile selection must be a plain object");

    let profileReads = 0;
    const accessor = { providerMode: "remote" } as unknown as SelectionInput;
    Object.defineProperty(accessor, "profile", {
      enumerable: true,
      get() {
        profileReads += 1;
        return "actions";
      },
    });
    expect(() => resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      accessor,
    )).toThrow("field profile must be an enumerable data property");
    expect(profileReads).toBe(0);

    expect(() => resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      {
        profile: "actions",
        providerMode: "remote",
        approvalId: "approval-1",
      } as unknown as SelectionInput,
    )).toThrow("contains unknown field approvalId");

    const symbolic = {
      profile: "actions",
      providerMode: "remote",
    } as SelectionInput;
    Object.defineProperty(symbolic, Symbol("credential"), {
      value: "github_pat_secret",
    });
    expect(() => resolveGitHubToolsetProfileSelection(
      catalogueInput(),
      symbolic,
    )).toThrow("contains a symbol field");
  });

  test("rejects decorated override arrays without invoking accessors", () => {
    const decorated = ["get_file_contents"];
    Object.defineProperty(decorated, "credentialRef", {
      enumerable: false,
      value: "secret://hidden",
    });
    expect(() => resolveGitHubToolsetProfileSelection(catalogueInput(), {
      profile: "actions",
      providerMode: "remote",
      additionalTools: decorated,
    })).toThrow("list contains unknown field credentialRef");

    const symbolic = ["get_file_contents"];
    Object.defineProperty(symbolic, Symbol("credential"), {
      value: "github_pat_secret",
    });
    expect(() => resolveGitHubToolsetProfileSelection(catalogueInput(), {
      profile: "actions",
      providerMode: "remote",
      additionalTools: symbolic,
    })).toThrow("list contains a symbol field");

    const inherited = ["get_file_contents"];
    Object.setPrototypeOf(
      inherited,
      Object.assign(Object.create(Array.prototype), {
        credentialRef: "secret://hidden",
      }),
    );
    expect(() => resolveGitHubToolsetProfileSelection(catalogueInput(), {
      profile: "actions",
      providerMode: "remote",
      additionalTools: inherited,
    })).toThrow("list must use the default array prototype");

    const nonEnumerable = ["get_file_contents"];
    Object.defineProperty(nonEnumerable, 0, {
      enumerable: false,
      value: "get_file_contents",
    });
    expect(() => resolveGitHubToolsetProfileSelection(catalogueInput(), {
      profile: "actions",
      providerMode: "remote",
      additionalTools: nonEnumerable,
    })).toThrow("list must contain enumerable data entries");

    let toolReads = 0;
    const accessor = ["get_file_contents"];
    Object.defineProperty(accessor, 0, {
      enumerable: true,
      get() {
        toolReads += 1;
        return "get_file_contents";
      },
    });
    expect(() => resolveGitHubToolsetProfileSelection(catalogueInput(), {
      profile: "actions",
      providerMode: "remote",
      additionalTools: accessor,
    })).toThrow("list must contain enumerable data entries");
    expect(toolReads).toBe(0);
  });

  test("fingerprints semantic selections deterministically", () => {
    const input = catalogueInput();
    const first = resolveGitHubToolsetProfileSelection(input, {
      profile: "actions",
      providerMode: "remote",
      additionalTools: ["get_file_contents"],
      excludedTools: ["future_destructive_tool", "rerun_workflow"],
    });
    const reordered = resolveGitHubToolsetProfileSelection(input, {
      profile: "actions",
      providerMode: "remote",
      additionalTools: ["get_file_contents"],
      excludedTools: ["rerun_workflow", "future_destructive_tool"],
    });
    const narrowed = resolveGitHubToolsetProfileSelection(input, {
      profile: "actions",
      providerMode: "remote",
      additionalTools: ["get_file_contents"],
      excludedTools: [
        "future_destructive_tool",
        "list_workflow_runs",
        "rerun_workflow",
      ],
    });

    expect(first.selectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reordered.selectionFingerprint).toBe(first.selectionFingerprint);
    expect(narrowed.selectionFingerprint).not.toBe(first.selectionFingerprint);
  });

  test("rejects ambiguous overrides and deeply freezes the selection", () => {
    const input = catalogueInput();
    expect(() => resolveGitHubToolsetProfileSelection(input, {
      profile: "actions",
      providerMode: "remote",
      additionalTools: ["unknown_tool"],
    })).toThrow("Unknown GitHub additional tool: unknown_tool");
    expect(() => resolveGitHubToolsetProfileSelection(input, {
      profile: "actions",
      providerMode: "remote",
      excludedTools: ["list_workflow_runs", "list_workflow_runs"],
    })).toThrow("GitHub excluded tool list values must be unique");

    const sparse = new Array<string>(1);
    expect(() => resolveGitHubToolsetProfileSelection(input, {
      profile: "actions",
      providerMode: "remote",
      additionalTools: sparse,
    })).toThrow("GitHub additional tool list must be dense");

    const selection = resolveGitHubToolsetProfileSelection(input, {
      profile: "actions",
      providerMode: "remote",
    });
    const compiled = compileGitHubToolCatalogue(catalogueInput());
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.tools)).toBe(true);
    expect(Object.isFrozen(selection.profile)).toBe(true);
    expect(() => selection.tools.push(compiled.toolsets[0]!.tools[0]!)).toThrow(TypeError);
  });
});

function catalogueInput(): GitHubToolCatalogueInput {
  return {
    version: 1,
    source: "github-mcp",
    sourceRevision: "github/github-mcp-server:test",
    toolsets: [
      {
        name: "repos",
        description: "Repository operations.",
        defaultEnabled: true,
        tools: [tool("get_file_contents", true)],
      },
      {
        name: "actions",
        description: "GitHub Actions operations.",
        defaultEnabled: false,
        tools: [
          tool("list_workflow_runs", true),
          tool("rerun_workflow", false),
        ],
      },
      {
        name: "copilot_spaces",
        description: "Remote Copilot Spaces operations.",
        defaultEnabled: false,
        tools: [tool("copilot_space_search", true)],
      },
    ],
  };
}

function tool(name: string, readOnly: boolean): GitHubToolDefinitionInput {
  return {
    name,
    description: `${readOnly ? "Read" : "Write"} through ${name}.`,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    readOnly,
    riskClass: readOnly ? "read" : "write",
    repositoryScoped: true,
    requiresApproval: !readOnly,
  };
}
