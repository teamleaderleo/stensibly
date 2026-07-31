import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  compareGitHubOfficialCatalogueManifests,
  githubOfficialCatalogueSourceRevision,
  importGitHubOfficialCatalogueManifest,
  type GitHubOfficialCatalogueManifestInput,
  type GitHubOfficialCatalogueProviderMode,
} from "../src/github-official-catalogue-import.ts";
import type {
  GitHubToolCatalogueInput,
  GitHubToolDefinitionInput,
} from "../src/github-tool-catalogue.ts";

const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);

describe("official GitHub catalogue import policy", () => {
  test("keeps feature-profile changes distinct from provenance-only movement", () => {
    const catalogue = baselineCatalogue(firstCommit);
    const previous = manifest(firstCommit, catalogue);
    const next = manifest(firstCommit, catalogue);
    next.profile.featureFlags = ["insiders"];

    const report = compareGitHubOfficialCatalogueManifests(
      JSON.stringify(previous),
      JSON.stringify(next),
    );

    expect(report.sourceOnly).toBe(false);
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "source.profile",
      kind: "export_profile_changed",
      promotion: "review_required",
    }));
  });

  test("classifies the current upstream nested-description pattern as reviewable metadata", () => {
    const previousCatalogue = baselineCatalogue(firstCommit);
    const nextCatalogue = baselineCatalogue(secondCommit);
    const content = properties(schema(repositoryTool(nextCatalogue))).content as Record<string, unknown>;
    content.description =
      "Content exactly as it should appear once written; the server encodes it for the REST API.";

    const report = compareGitHubOfficialCatalogueManifests(
      JSON.stringify(manifest(firstCommit, previousCatalogue)),
      JSON.stringify(manifest(secondCommit, nextCatalogue)),
    );

    expect(report.sourceOnly).toBe(false);
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: "tools.create_or_update_file.inputSchema.properties.content.description",
      kind: "schema_description_changed",
      promotion: "review_required",
    }));
    expect(report.entries.some((entry) =>
      entry.kind === "source_identity_conflict"
    )).toBe(false);
    expect(report.entries.some((entry) =>
      entry.kind === "schema_description_changed" && entry.promotion === "reject"
    )).toBe(false);
  });

  test("supports exact additional tools outside selected groups and requires coverage", () => {
    const accepted = manifest(firstCommit, baselineCatalogue(firstCommit));
    accepted.profile.selectedToolsets = ["context"];
    accepted.profile.additionalTools = ["create_or_update_file"];

    const snapshot = importGitHubOfficialCatalogueManifest(JSON.stringify(accepted));
    expect(snapshot.profile.selectedToolsets).toEqual(["context"]);
    expect(snapshot.profile.additionalTools).toEqual(["create_or_update_file"]);

    const missingExactTool = manifest(firstCommit, baselineCatalogue(firstCommit));
    missingExactTool.profile.selectedToolsets = ["context"];
    expect(() => importGitHubOfficialCatalogueManifest(
      JSON.stringify(missingExactTool),
    )).toThrow(
      "effective tool create_or_update_file is outside selected toolsets and additional tools",
    );

    const unknownToolset = manifest(firstCommit, baselineCatalogue(firstCommit));
    unknownToolset.profile.selectedToolsets = ["context", "missing_group"];
    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(unknownToolset)))
      .toThrow("selected toolset missing_group is absent from the effective catalogue");
  });

  test("requires excluded tools to be absent from the effective catalogue", () => {
    const input = manifest(firstCommit, baselineCatalogue(firstCommit));
    input.profile.excludedTools = ["create_or_update_file"];

    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(input)))
      .toThrow("excluded tools must be absent from the effective catalogue");
  });

  test("rejects writes inside a read-only export", () => {
    const catalogue = baselineCatalogue(firstCommit);
    const repository = repositoryTool(catalogue);
    repository.readOnly = false;
    repository.riskClass = "write";
    repository.requiresApproval = true;
    const input = manifest(firstCommit, catalogue);
    input.profile.readOnly = true;

    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(input)))
      .toThrow("read-only export contains a write-capable tool");
  });

  test("rejects remote-only groups from a local effective catalogue", () => {
    const catalogue = baselineCatalogue(firstCommit, "local");
    const input = manifest(firstCommit, catalogue, "local");
    input.availability = input.availability.map((entry) =>
      entry.name === "repos"
        ? { ...entry, availability: "remote_only" }
        : entry
    );

    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(input)))
      .toThrow("local catalogue contains a remote-only toolset");
  });
});

function baselineCatalogue(
  commitSha: string,
  providerMode: GitHubOfficialCatalogueProviderMode = "remote",
): GitHubToolCatalogueInput {
  return {
    version: 1,
    source: "github-mcp",
    sourceRevision: githubOfficialCatalogueSourceRevision(commitSha, providerMode),
    toolsets: [
      {
        name: "context",
        description: "Authenticated GitHub context.",
        defaultEnabled: true,
        tools: [tool("get_me", { repositoryScoped: false })],
      },
      {
        name: "repos",
        description: "Repository operations.",
        defaultEnabled: true,
        tools: [tool("create_or_update_file", {
          readOnly: false,
          riskClass: "write",
          requiresApproval: true,
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: {
                type: "string",
                description: "Content of the file.",
              },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        })],
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

function manifest(
  commitSha: string,
  catalogue: GitHubToolCatalogueInput,
  providerMode: GitHubOfficialCatalogueProviderMode = "remote",
): GitHubOfficialCatalogueManifestInput {
  const sourceContent = `invented exporter fixture for ${commitSha}\n`;
  return {
    version: 1,
    sourceKind: "source_catalogue_candidate",
    repository: "github/github-mcp-server",
    commitSha,
    providerMode,
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
}

function repositoryTool(catalogue: GitHubToolCatalogueInput) {
  return catalogue.toolsets
    .find((entry) => entry.name === "repos")!
    .tools.find((entry) => entry.name === "create_or_update_file")!;
}

function schema(toolDefinition: GitHubToolDefinitionInput): Record<string, unknown> {
  return toolDefinition.inputSchema;
}

function properties(schemaValue: Record<string, unknown>): Record<string, unknown> {
  return schemaValue.properties as Record<string, unknown>;
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
