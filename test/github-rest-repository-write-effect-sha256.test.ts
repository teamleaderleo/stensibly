import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "feature/repository-write-sha256-effect";
const expectedParentSha = "a".repeat(64);
const commitSha = "b".repeat(64);
const path = "docs/sha256-effect.md";
const content = "sha256 file effect\n";
const apiBaseUrl = "https://api.github.test";

describe("GitHub repository file effect SHA-256 admission", () => {
  test("rejects a well-shaped response with the wrong canonical SHA-256 blob", async () => {
    const bytes = Buffer.from(content, "utf8");
    const canonicalBlobSha = createHash("sha256")
      .update(`blob ${bytes.byteLength}\0`, "utf8")
      .update(bytes)
      .digest("hex");
    const wrongBlobSha = canonicalBlobSha === "c".repeat(64)
      ? "d".repeat(64)
      : "c".repeat(64);
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: {
        async getRepositoryContentsToken() {
          return {
            token: "contents-write-token-secret",
            expiresAt: "2026-08-03T11:00:00.000Z",
          };
        },
      },
      apiBaseUrl,
      fetch: (async () => Response.json({
        content: {
          name: "sha256-effect.md",
          path,
          sha: wrongBlobSha,
          size: bytes.byteLength,
          url: `${apiBaseUrl}/repos/${repositoryFullName}/contents/${path}`,
          git_url: `${apiBaseUrl}/repos/${repositoryFullName}/git/blobs/${wrongBlobSha}`,
          type: "file",
        },
        commit: {
          sha: commitSha,
          url: `${apiBaseUrl}/repos/${repositoryFullName}/git/commits/${commitSha}`,
          parents: [{ sha: expectedParentSha }],
        },
      }, { status: 201 })) as unknown as typeof fetch,
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha,
      payload: {
        operation: "create_file",
        content,
        message: "Reject wrong SHA-256 file effect",
      },
      idempotencyKey: "repository-file-effect-sha256-mismatch",
    })).rejects.toThrow(
      "GitHub repository write response file effect was invalid",
    );
  });
});
