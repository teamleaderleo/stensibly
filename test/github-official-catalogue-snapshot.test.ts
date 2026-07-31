import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type {
  GitHubToolCatalogueInput,
  GitHubToolDefinitionInput,
  GitHubToolsetInput,
} from "../src/github-tool-catalogue.ts";
import {
  compareGitHubOfficialCatalogueManifests,
  importGitHubOfficialCatalogueSnapshot,
  type GitHubOfficialCatalogueManifestInput,
} from "../src/github-official-catalogue-snapshot.ts";

const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);

describe("official GitHub MCP catalogue snapshots", () => {
  test("imports exact source proof deterministically without retaining source text", () => {
    const manifest = manifestJson(firstCommit, baselineCatalogue(firstCommit), {
      warnings: ["Remote catalogue excludes preview-only tools."],
    });

    const first = importGitHubOfficialCatalogueSnapshot(manifest);
    const second = importGitHubOfficialCatalogueSnapshot(manifest);

    expect(first).toEqual(second);
    expect(first.repository).toBe("github/github-mcp-server");
    expect(first.commitSha).toBe(firstCommit);
    expect(first.providerMode).toBe("remote");
    expect(first.files.map((file) => file.path)).toEqual([
      "docs/remote-server.md",
      "pkg/github/tools.go",
    ]);
    expect(first.files.every((file) =>
      file.contentSha256.match(/^sha256:[a-f0-9]{64}$/)
    )).toBe(true);
    expect(first.snapshotFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect("content" in first.files[0]!).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
    expect(Object.isFrozen(first.catalogue)).toBe(true);
    expect(Object.isFrozen(first.catalogue.toolsets[0]!.tools[0]!.inputSchema)).toBe(
      true,
    );
    expect(() => first.files.push(first.files[0]!)).toThrow(TypeError);
  });

  test("rejects mismatched, duplicate, and path-escaping source evidence", () => {
    const base = manifestObject(firstCommit, baselineCatalogue(firstCommit));
    base.files[0]!.blobSha = "0".repeat(40);
    expect(() => importGitHubOfficialCatalogueSnapshot(JSON.stringify(base))).toThrow(
      "blob SHA mismatch",
    );

    const duplicate = manifestObject(firstCommit, baselineCatalogue(firstCommit));
    duplicate.files[1]!.path = duplicate.files[0]!.path;
    expect(() => importGitHubOfficialCatalogueSnapshot(JSON.stringify(duplicate))).toThrow(
      "Duplicate GitHub official catalogue source path",
    );

    const escaping = manifestObject(firstCommit, baselineCatalogue(firstCommit));
    escaping.files[0]!.path = "../remote-server.md";
    expect(() => importGitHubOfficialCatalogueSnapshot(JSON.stringify(escaping))).toThrow(
      "source path is invalid",
    );

    const staleRevision = manifestObject(firstCommit, baselineCatalogue(firstCommit));
    staleRevision.catalogue.sourceRevision =
      `github/github-mcp-server@${secondCommit}:remote`;
    expect(() => importGitHubOfficialCatalogueSnapshot(
      JSON.stringify(staleRevision),
    )).toThrow(`source revision must equal github/github-mcp-server@${firstCommit}:remote`);
  });

  test("classifies additive tools inside reviewed groups", () => {
    const before = baselineCatalogue(firstCommit);
    const after = baselineCatalogue(secondCommit);
    after.toolsets.find((toolset) => toolset.name === "projects")!.tools.push(
      tool("update_project_items", false, {
        type: "object",
        properties: {
          project_id: { type: "string" },
        },
        required: ["project_id"],
        additionalProperties: false,
      }),
    );

    const report = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, before),
      manifestJson(secondCommit, after, { sourceSuffix: "updated" }),
    );

    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "tools.update_project_items",
      kind: "tool_added",
      promotion: "auto_additive",
    }));
    expect(report.sourceOnly).toBe(false);
    expect(report.reportFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.entries)).toBe(true);
  });

  test("quarantines entirely new read-only toolsets", () => {
    const before = baselineCatalogue(firstCommit);
    const after = baselineCatalogue(secondCommit);
    after.toolsets.push({
      name: "billing_context",
      description: "New provider billing context.",
      defaultEnabled: false,
      tools: [tool("get_billing_context", true)],
    });

    const report = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, before),
      manifestJson(secondCommit, after, { sourceSuffix: "billing" }),
    );

    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "toolsets.billing_context",
      kind: "toolset_added_pending_review",
      promotion: "review_required",
    }));
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "tools.get_billing_context",
      kind: "tool_added",
      promotion: "review_required",
    }));
  });

  test("distinguishes optional schema growth from required-input narrowing", () => {
    const before = baselineCatalogue(firstCommit);
    const optional = baselineCatalogue(secondCommit);
    const optionalSchema = repositoryRead(optional).inputSchema;
    (optionalSchema.properties as Record<string, unknown>).fields = {
      type: "array",
      items: { type: "string" },
    };

    const optionalReport = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, before),
      manifestJson(secondCommit, optional, { sourceSuffix: "optional-fields" }),
    );
    expect(optionalReport.entries).toContainEqual(expect.objectContaining({
      path: "tools.get_file_contents.inputSchema.properties.fields",
      kind: "schema_property_added",
      promotion: "auto_additive",
    }));

    const required = baselineCatalogue(secondCommit);
    const requiredSchema = repositoryRead(required).inputSchema;
    (requiredSchema.properties as Record<string, unknown>).fields = {
      type: "array",
      items: { type: "string" },
    };
    (requiredSchema.required as string[]).push("fields");
    const requiredReport = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, before),
      manifestJson(secondCommit, required, { sourceSuffix: "required-fields" }),
    );
    expect(requiredReport.entries).toContainEqual(expect.objectContaining({
      path: "tools.get_file_contents.inputSchema.required.fields",
      kind: "schema_required_added",
      promotion: "reject",
    }));
  });

  test("rejects enum narrowing and read-to-write authority changes", () => {
    const before = baselineCatalogue(firstCommit);
    const narrowed = baselineCatalogue(secondCommit);
    const state = ((repositoryRead(narrowed).inputSchema.properties as Record<
      string,
      unknown
    >).state as Record<string, unknown>);
    state.enum = ["open"];
    const narrowedReport = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, before),
      manifestJson(secondCommit, narrowed, { sourceSuffix: "narrowed" }),
    );
    expect(narrowedReport.entries).toContainEqual(expect.objectContaining({
      kind: "schema_enum_removed",
      promotion: "reject",
      previous: "closed",
    }));

    const writable = baselineCatalogue(secondCommit);
    const read = repositoryRead(writable);
    read.readOnly = false;
    read.riskClass = "write";
    read.requiresApproval = true;
    const writableReport = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, before),
      manifestJson(secondCommit, writable, { sourceSuffix: "write" }),
    );
    expect(writableReport.entries).toContainEqual(expect.objectContaining({
      path: "tools.get_file_contents.readOnly",
      kind: "tool_read_only_changed",
      promotion: "reject",
    }));
    expect(writableReport.entries).toContainEqual(expect.objectContaining({
      path: "tools.get_file_contents.riskClass",
      kind: "tool_risk_changed",
      promotion: "reject",
    }));
  });

  test("separates source-only movement from catalogue behavior", () => {
    const before = baselineCatalogue(firstCommit);
    const after = baselineCatalogue(secondCommit);
    const report = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, before),
      manifestJson(secondCommit, after),
    );

    expect(report.sourceOnly).toBe(true);
    expect(report.entries.map((entry) => entry.kind)).toEqual([
      "source_revision_changed",
    ]);
    expect(report.coarse.classification).toBe("compatible");
    expect(report.coarse.reasons).toContain("provider source revision changed");
  });
});

function baselineCatalogue(commitSha: string): GitHubToolCatalogueInput {
  return {
    version: 1,
    source: "github-mcp",
    sourceRevision: `github/github-mcp-server@${commitSha}:remote`,
    toolsets: [
      {
        name: "repos",
        description: "Repository reads.",
        defaultEnabled: true,
        tools: [tool("get_file_contents", true, {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            state: { type: "string", enum: ["open", "closed"] },
          },
          required: ["owner", "repo"],
          additionalProperties: false,
        })],
      },
      {
        name: "projects",
        description: "Project operations.",
        defaultEnabled: false,
        tools: [tool("get_project", true)],
      },
    ],
  };
}

function repositoryRead(catalogue: GitHubToolCatalogueInput): GitHubToolDefinitionInput {
  return catalogue.toolsets
    .find((toolset) => toolset.name === "repos")!
    .tools.find((entry) => entry.name === "get_file_contents")!;
}

function tool(
  name: string,
  readOnly: boolean,
  inputSchema: Record<string, unknown> = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
): GitHubToolDefinitionInput {
  return {
    name,
    description: `${readOnly ? "Read" : "Write"} through ${name}.`,
    inputSchema,
    readOnly,
    riskClass: readOnly ? "read" : "write",
    repositoryScoped: true,
    requiresApproval: !readOnly,
  };
}

function manifestJson(
  commitSha: string,
  catalogue: GitHubToolCatalogueInput,
  options: {
    sourceSuffix?: string;
    warnings?: string[];
  } = {},
): string {
  return JSON.stringify(manifestObject(commitSha, catalogue, options));
}

function manifestObject(
  commitSha: string,
  catalogue: GitHubToolCatalogueInput,
  options: {
    sourceSuffix?: string;
    warnings?: string[];
  } = {},
): GitHubOfficialCatalogueManifestInput {
  const suffix = options.sourceSuffix ? `:${options.sourceSuffix}` : "";
  const contents = [
    {
      path: "docs/remote-server.md",
      content: `remote catalogue${suffix}\n`,
    },
    {
      path: "pkg/github/tools.go",
      content: `shared inventory${suffix}\n`,
    },
  ];
  return {
    version: 1,
    repository: "github/github-mcp-server",
    commitSha,
    providerMode: "remote",
    files: contents.map(({ path, content }) => ({
      path,
      blobSha: gitBlobSha(content),
      content,
    })),
    catalogue,
    ...(options.warnings ? { warnings: options.warnings } : {}),
  };
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes}\0`)
    .update(content, "utf8")
    .digest("hex");
}
