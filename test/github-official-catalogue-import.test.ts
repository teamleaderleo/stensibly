import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  compareGitHubOfficialCatalogueManifests,
  githubOfficialCatalogueSourceRevision,
  importGitHubOfficialCatalogueManifest,
  type GitHubOfficialCatalogueManifestInput,
} from "../src/github-official-catalogue-import.ts";
import type {
  GitHubToolCatalogueInput,
  GitHubToolDefinitionInput,
} from "../src/github-tool-catalogue.ts";
import { resolveGitHubToolsetProfileSelection } from "../src/github-toolset-profile-selection.ts";

const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);
const sourceContent = "package github\n\n// invented exporter fixture\n";

describe("official GitHub MCP catalogue import", () => {
  test("imports exact exporter evidence deterministically without retaining source text", () => {
    const manifest = manifestJson(firstCommit, baselineCatalogue(firstCommit));

    const first = importGitHubOfficialCatalogueManifest(manifest);
    const second = importGitHubOfficialCatalogueManifest(manifest);

    expect(first).toEqual(second);
    expect(first.repository).toBe("github/github-mcp-server");
    expect(first.commitSha).toBe(firstCommit);
    expect(first.providerMode).toBe("remote");
    expect(first.files).toEqual([{
      path: "pkg/github/exported-catalogue.json",
      blobSha: gitBlobSha(sourceContent),
      contentSha256: fingerprint(sourceContent),
      byteLength: Buffer.byteLength(sourceContent, "utf8"),
    }]);
    expect("content" in first.files[0]!).toBe(false);
    expect(first.profile.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.effectiveCatalogueFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.snapshotFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
    expect(Object.isFrozen(first.catalogue.toolsets[0]?.tools[0]?.inputSchema)).toBe(true);
    expect(() => {
      first.files[0]!.path = "changed";
    }).toThrow(TypeError);
  });

  test("rejects source proof, source revision, and manifest field mismatches", () => {
    const catalogue = baselineCatalogue(firstCommit);

    const badBlob = parsedManifest(firstCommit, catalogue);
    sourceFile(badBlob).blobSha = "0".repeat(40);
    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(badBlob)))
      .toThrow("blob SHA does not match");

    const badRevision = parsedManifest(firstCommit, catalogue);
    catalogueRecord(badRevision).sourceRevision = "github-mcp-server:moving-main";
    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(badRevision)))
      .toThrow("source revision must equal");

    const unknown = parsedManifest(firstCommit, catalogue);
    unknown.movingRef = "main";
    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(unknown)))
      .toThrow("unknown field movingRef");

    const duplicatePath = parsedManifest(firstCommit, catalogue);
    const files = duplicatePath.files as Array<Record<string, unknown>>;
    files.push({ ...files[0]! });
    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(duplicatePath)))
      .toThrow("Duplicate GitHub official catalogue source path");
  });

  test("classifies additive tools inside reviewed groups and preserves read-only filtering", () => {
    const previous = baselineCatalogue(firstCommit);
    const next = clone(previous);
    projects(next).tools.push(tool("update_project_items", {
      readOnly: false,
      riskClass: "write",
      requiresApproval: true,
    }));

    const report = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, previous),
      manifestJson(firstCommit, next),
    );
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "tools.update_project_items",
      kind: "tool_added",
      promotion: "auto_additive",
    }));

    const readOnly = resolveGitHubToolsetProfileSelection(next, {
      profile: "read_only",
      providerMode: "remote",
    });
    expect(readOnly.tools.some((entry) => entry.name === "update_project_items"))
      .toBe(false);
    const focused = resolveGitHubToolsetProfileSelection(next, {
      profile: "projects",
      providerMode: "remote",
    });
    expect(focused.tools.some((entry) => entry.name === "update_project_items"))
      .toBe(true);
  });

  test("quarantines an entirely new read-only toolset", () => {
    const previous = baselineCatalogue(firstCommit);
    const next = clone(previous);
    next.toolsets.push({
      name: "billing_insights",
      description: "Invented billing insight reads.",
      defaultEnabled: false,
      tools: [tool("list_billing_insights")],
    });

    const report = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, previous),
      manifestJson(firstCommit, next),
    );
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "toolsets.billing_insights",
      kind: "toolset_added_pending_review",
      promotion: "review_required",
    }));
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "tools.list_billing_insights",
      kind: "tool_added",
      promotion: "review_required",
    }));
  });

  test("distinguishes optional schema growth from required, enum, and write narrowing", () => {
    const previous = baselineCatalogue(firstCommit);
    const optional = clone(previous);
    const optionalSchema = schema(repositoryTool(optional));
    properties(optionalSchema).fields = {
      type: "array",
      items: { type: "string" },
    };
    const optionalReport = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, previous),
      manifestJson(firstCommit, optional),
    );
    expect(optionalReport.entries).toContainEqual(expect.objectContaining({
      path: "tools.get_file_contents.inputSchema.properties.fields",
      kind: "schema_property_added",
      promotion: "auto_additive",
    }));

    const narrowed = clone(optional);
    const narrowedTool = repositoryTool(narrowed);
    const narrowedSchema = schema(narrowedTool);
    narrowedSchema.required = ["path", "fields"];
    const method = properties(narrowedSchema).method as Record<string, unknown>;
    method.enum = ["raw"];
    narrowedTool.readOnly = false;
    narrowedTool.riskClass = "write";
    narrowedTool.requiresApproval = true;

    const narrowedReport = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, optional),
      manifestJson(firstCommit, narrowed),
    );
    expect(narrowedReport.entries).toContainEqual(expect.objectContaining({
      kind: "schema_required_added",
      promotion: "reject",
    }));
    expect(narrowedReport.entries).toContainEqual(expect.objectContaining({
      kind: "schema_enum_removed",
      promotion: "reject",
    }));
    expect(narrowedReport.entries).toContainEqual(expect.objectContaining({
      kind: "tool_read_only_changed",
      promotion: "reject",
    }));
  });

  test("separates provenance-only movement from effective catalogue drift", () => {
    const previous = baselineCatalogue(firstCommit);
    const next = baselineCatalogue(secondCommit);

    const report = compareGitHubOfficialCatalogueManifests(
      manifestJson(firstCommit, previous),
      manifestJson(secondCommit, next),
    );

    expect(report.sourceOnly).toBe(true);
    expect(report.coarse.classification).toBe("compatible");
    expect(report.entries.map((entry) => entry.kind)).toContain(
      "source_revision_changed",
    );
    expect(report.entries.some((entry) => entry.kind.startsWith("tool_"))).toBe(false);
    expect(report.entries.some((entry) => entry.kind.startsWith("schema_"))).toBe(false);
  });

  test("rejects contradictory catalogues under one exact source identity", () => {
    const previous = baselineCatalogue(firstCommit);
    const next = clone(previous);
    properties(schema(repositoryTool(next))).path = {
      type: "string",
      pattern: "^[A-Z]+$",
    };

    const previousManifest = manifestJson(firstCommit, previous);
    const nextManifest = manifestJson(firstCommit, next);
    const first = compareGitHubOfficialCatalogueManifests(
      previousManifest,
      nextManifest,
    );
    const second = compareGitHubOfficialCatalogueManifests(
      previousManifest,
      nextManifest,
    );

    expect(first).toEqual(second);
    expect(first.sourceOnly).toBe(false);
    expect(first.entries).toContainEqual(expect.objectContaining({
      path: "source.identity",
      kind: "source_identity_conflict",
      promotion: "reject",
    }));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
  });
});

function baselineCatalogue(commitSha: string): GitHubToolCatalogueInput {
  return {
    version: 1,
    source: "github-mcp",
    sourceRevision: githubOfficialCatalogueSourceRevision(commitSha, "remote"),
    toolsets: [
      {
        name: "context",
        description: "Authenticated GitHub context.",
        defaultEnabled: true,
        tools: [tool("get_me", { repositoryScoped: false })],
      },
      {
        name: "repos",
        description: "Repository reads.",
        defaultEnabled: true,
        tools: [tool("get_file_contents", {
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              method: { type: "string", enum: ["raw", "html"] },
            },
            required: ["path"],
            additionalProperties: false,
          },
        })],
      },
      {
        name: "projects",
        description: "GitHub Projects operations.",
        defaultEnabled: false,
        tools: [tool("list_projects")],
      },
    ],
  };
}

function tool(
  name: string,
  overrides: Partial<GitHubToolDefinitionInput> = {},
): GitHubToolDefinitionInput {
  return {
    name,
    description: `Operate through ${name}.`,
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
    ...overrides,
  };
}

function manifestJson(
  commitSha: string,
  catalogue: GitHubToolCatalogueInput,
): string {
  const input: GitHubOfficialCatalogueManifestInput = {
    version: 1,
    sourceKind: "source_catalogue_candidate",
    repository: "github/github-mcp-server",
    commitSha,
    providerMode: "remote",
    exporter: {
      name: "invented-network-isolated-exporter",
      version: "1.0.0",
      sourceSha256: fingerprint("exporter-source"),
      commandSha256: fingerprint("go run ./cmd/export-catalogue"),
      toolchain: "go1.25.1 linux/amd64",
      moduleLockSha256: fingerprint("go.sum fixture"),
    },
    profile: {
      locale: "en-US",
      translationMode: "default",
      featureFlags: [],
      selectedToolsets: catalogue.toolsets.map((entry) => entry.name),
      additionalTools: [],
      readOnly: false,
      excludedTools: [],
    },
    files: [{
      path: "pkg/github/exported-catalogue.json",
      blobSha: gitBlobSha(sourceContent),
      content: sourceContent,
    }],
    availability: catalogue.toolsets.map((entry) => ({
      name: entry.name,
      availability: "local_and_remote",
    })),
    catalogue,
    warnings: [],
  };
  return JSON.stringify(input);
}

function parsedManifest(
  commitSha: string,
  catalogue: GitHubToolCatalogueInput,
): Record<string, unknown> {
  return JSON.parse(manifestJson(commitSha, catalogue)) as Record<string, unknown>;
}

function sourceFile(manifest: Record<string, unknown>): Record<string, unknown> {
  return (manifest.files as Array<Record<string, unknown>>)[0]!;
}

function catalogueRecord(manifest: Record<string, unknown>): Record<string, unknown> {
  return manifest.catalogue as Record<string, unknown>;
}

function projects(catalogue: GitHubToolCatalogueInput) {
  return catalogue.toolsets.find((entry) => entry.name === "projects")!;
}

function repositoryTool(catalogue: GitHubToolCatalogueInput) {
  return catalogue.toolsets
    .find((entry) => entry.name === "repos")!
    .tools.find((entry) => entry.name === "get_file_contents")!;
}

function schema(toolDefinition: GitHubToolDefinitionInput): Record<string, unknown> {
  return toolDefinition.inputSchema;
}

function properties(schemaValue: Record<string, unknown>): Record<string, unknown> {
  return schemaValue.properties as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitBlobSha(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}
