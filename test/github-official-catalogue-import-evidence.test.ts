import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  githubOfficialCatalogueSourceRevision,
  importGitHubOfficialCatalogueManifest,
  type GitHubOfficialCatalogueManifestInput,
} from "../src/github-official-catalogue-import.ts";

describe("official GitHub catalogue evidence bytes", () => {
  test("requires compact canonical JSON and rejects duplicate keys", () => {
    const input = manifest([]);
    const compact = JSON.stringify(input);

    expect(importGitHubOfficialCatalogueManifest(compact).commitSha)
      .toBe(input.commitSha);
    expect(() => importGitHubOfficialCatalogueManifest(
      JSON.stringify(input, null, 2),
    )).toThrow("canonical compact JSON encoding");

    const duplicateVersion = compact.replace(
      '{"version":1,',
      '{"version":1,"version":1,',
    );
    expect(() => importGitHubOfficialCatalogueManifest(duplicateVersion))
      .toThrow("canonical compact JSON encoding");

    const alternateEscape = compact.replace(
      "github/github-mcp-server",
      "github\\/github-mcp-server",
    );
    expect(() => importGitHubOfficialCatalogueManifest(alternateEscape))
      .toThrow("canonical compact JSON encoding");
  });

  test("rejects unsafe warning controls and preserves exact safe Unicode", () => {
    const unsafe = manifest(["unsafe\nwarning"]);
    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(unsafe)))
      .toThrow("warning contains unsafe characters");

    const bidi = manifest(["review\u202ehidden"]);
    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(bidi)))
      .toThrow("warning contains unsafe characters");

    const warning = "Résumé — upstream exporter observation.";
    const accepted = importGitHubOfficialCatalogueManifest(
      JSON.stringify(manifest([warning])),
    );
    expect(accepted.warnings).toEqual([warning]);
  });

  test("rejects excessive nesting before canonical encoding or catalogue compilation", () => {
    const input = manifest([]) as unknown as Record<string, unknown>;
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 70; depth += 1) {
      nested = { nested };
    }
    input.unreviewed = nested;

    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(input)))
      .toThrow("exceeds JSON depth 64");
  });

  test("rejects excessive node counts before catalogue compilation", () => {
    const input = manifest([]) as unknown as Record<string, unknown>;
    input.unreviewed = Array.from({ length: 100_001 }, () => null);

    expect(() => importGitHubOfficialCatalogueManifest(JSON.stringify(input)))
      .toThrow("exceeds 100000 JSON nodes");
  });
});

function manifest(warnings: string[]): GitHubOfficialCatalogueManifestInput {
  const commitSha = "c".repeat(40);
  const sourceContent = "invented canonical exporter evidence\n";
  return {
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
      selectedToolsets: ["context"],
      additionalTools: [],
      readOnly: true,
      excludedTools: [],
    },
    files: [{
      path: "pkg/github/exported-catalogue.json",
      blobSha: gitBlobSha(sourceContent),
      content: sourceContent,
    }],
    availability: [{
      name: "context",
      availability: "local_and_remote",
    }],
    catalogue: {
      version: 1,
      source: "github-mcp",
      sourceRevision: githubOfficialCatalogueSourceRevision(commitSha, "remote"),
      toolsets: [{
        name: "context",
        description: "Authenticated GitHub context.",
        defaultEnabled: true,
        tools: [{
          name: "get_me",
          description: "Get the authenticated GitHub identity.",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          readOnly: true,
          riskClass: "read",
          repositoryScoped: false,
          requiresApproval: false,
        }],
      }],
    },
    warnings,
  };
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
