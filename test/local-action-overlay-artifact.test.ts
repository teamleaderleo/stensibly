import { describe, expect, test } from "bun:test";
import type { Artifact } from "../src/artifact-contracts.ts";
import { compileLocalOverlayArtifactV1 } from "../src/local-action-overlay-artifact.ts";

const blobSha = "9".repeat(40);
const contentSha = `sha256:${"a".repeat(64)}`;

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_patch_1",
    itemId: "item_1",
    actorId: "actor_1",
    kind: "file",
    label: "sandbox patch",
    uri: `https://api.github.com/repos/TeamLeaderLeo/Stensibly/git/blobs/${blobSha}`,
    mimeType: "text/x-diff",
    metadata: {
      transport: "github_blob",
      repository: "TeamLeaderLeo/Stensibly",
      gitBlobSha: blobSha,
      sha256: contentSha,
      bytes: 187,
      format: "unified_diff_utf8",
    },
    createdAt: "2026-08-31T19:00:00.000Z",
    ...overrides,
  };
}

const expected = {
  format: "unified_diff_utf8" as const,
  artifactRef: "art_patch_1",
  sha256: contentSha,
  bytes: 187,
};

describe("local overlay artifact", () => {
  test("reconciles one canonical GitHub blob pointer without granting authority", () => {
    const result = compileLocalOverlayArtifactV1({
      artifact: artifact(),
      expected,
      expectedRepository: "teamleaderleo/stensibly",
    });
    expect(result).toMatchObject({
      version: 1,
      transport: "github_blob",
      artifactId: "art_patch_1",
      repository: "teamleaderleo/stensibly",
      gitBlobSha: blobSha,
      apiUrl: `https://api.github.com/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      sha256: contentSha,
      bytes: 187,
      grantsAuthority: false,
      authorizesExecution: false,
    });
    expect(result.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("refuses artifact, repository, blob, digest and byte mismatches", () => {
    expect(() => compileLocalOverlayArtifactV1({ artifact: artifact(), expected: { ...expected, artifactRef: "art_other" }, expectedRepository: "teamleaderleo/stensibly" }))
      .toThrow("artifact reference changed");
    expect(() => compileLocalOverlayArtifactV1({ artifact: artifact(), expected, expectedRepository: "teamleaderleo/other" }))
      .toThrow("repository changed");
    expect(() => compileLocalOverlayArtifactV1({ artifact: artifact({ metadata: { ...artifact().metadata, gitBlobSha: "8".repeat(40) } }), expected, expectedRepository: "teamleaderleo/stensibly" }))
      .toThrow("Git blob identity changed");
    expect(() => compileLocalOverlayArtifactV1({ artifact: artifact(), expected: { ...expected, sha256: `sha256:${"b".repeat(64)}` }, expectedRepository: "teamleaderleo/stensibly" }))
      .toThrow("content identity changed");
    expect(() => compileLocalOverlayArtifactV1({ artifact: artifact(), expected: { ...expected, bytes: 188 }, expectedRepository: "teamleaderleo/stensibly" }))
      .toThrow("content identity changed");
  });

  test("refuses non-file/non-diff artifacts and noncanonical provider URLs", () => {
    expect(() => compileLocalOverlayArtifactV1({ artifact: artifact({ kind: "url" }), expected, expectedRepository: "teamleaderleo/stensibly" }))
      .toThrow("file reference");
    expect(() => compileLocalOverlayArtifactV1({ artifact: artifact({ mimeType: "text/plain" }), expected, expectedRepository: "teamleaderleo/stensibly" }))
      .toThrow("text/x-diff");
    for (const uri of [
      `http://api.github.com/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      `https://user@api.github.com/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      `https://api.github.com:444/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      `https://api.github.com/repos/teamleaderleo/stensibly/git/blobs/${blobSha}?x=1`,
      `https://github.com/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      `https://api.github.com/repos/teamleaderleo/stensibly/git/blobs/${blobSha}/extra`,
    ]) {
      expect(() => compileLocalOverlayArtifactV1({ artifact: artifact({ uri }), expected, expectedRepository: "teamleaderleo/stensibly" }))
        .toThrow();
    }
  });

  test("requires closed transport metadata", () => {
    expect(() => compileLocalOverlayArtifactV1({
      artifact: artifact({ metadata: { ...artifact().metadata, extra: "nope" } }),
      expected,
      expectedRepository: "teamleaderleo/stensibly",
    })).toThrow();
    expect(() => compileLocalOverlayArtifactV1({
      artifact: artifact({ metadata: { ...artifact().metadata, transport: "url" } }),
      expected,
      expectedRepository: "teamleaderleo/stensibly",
    })).toThrow();
  });
});
