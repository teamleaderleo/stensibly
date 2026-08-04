import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const path = "docs/provider-sync.md";
const targetRef = "main";
const parentSha = "1".repeat(40);
const commitSha = "2".repeat(40);
const content = "created\n";
const fixedEffectError =
  "GitHub repository write response file effect was invalid";

describe("GitHub repository write exact effect URL spelling", () => {
  test("admits canonical content and blob URLs", async () => {
    await expect(dispatch(effect())).resolves.toMatchObject({
      commitSha,
      targetRef,
      parentSha,
    });
  });

  test("rejects normalized aliases of exact content and blob URLs", async () => {
    const canonical = effect();
    const cases = [
      {
        ...canonical,
        url: canonical.url.replace(
          "https://api.github.com/",
          "https://api.github.com:443/",
        ),
      },
      {
        ...canonical,
        url: canonical.url.replace(
          "https://api.github.com/",
          "https://API.GITHUB.COM/",
        ),
      },
      {
        ...canonical,
        url: canonical.url.replace(
          "/contents/docs/provider-sync.md",
          "/contents/docs/extra/../provider-sync.md",
        ),
      },
      {
        ...canonical,
        git_url: canonical.git_url.replace(
          "https://api.github.com/",
          "https://api.github.com:443/",
        ),
      },
      {
        ...canonical,
        git_url: canonical.git_url.replace(
          `/git/blobs/${canonical.sha}`,
          `/git/blobs/extra/../${canonical.sha}`,
        ),
      },
    ];

    for (const changed of cases) {
      await expect(dispatch(changed)).rejects.toThrow(fixedEffectError);
    }
  });
});

async function dispatch(effectValue: ReturnType<typeof effect>) {
  const adapter = new GitHubRestRepositoryWriteAdapter({
    tokenProvider: {
      async getRepositoryContentsToken() {
        return {
          token: "installation-token",
          expiresAt: "2026-08-03T23:00:00.000Z",
        };
      },
    },
    fetch: (async () => Response.json({
      content: effectValue,
      commit: {
        sha: commitSha,
        url:
          `https://api.github.com/repos/${repositoryFullName}/git/commits/${commitSha}`,
        parents: [{
          sha: parentSha,
          url:
            `https://api.github.com/repos/${repositoryFullName}/git/commits/${parentSha}`,
        }],
      },
    }, { status: 201 })) as unknown as typeof fetch,
  });

  return await adapter.dispatchRepositoryWrite({
    repositoryFullName,
    path,
    operation: "create_file",
    targetRef,
    expectedParentSha: parentSha,
    payload: {
      operation: "create_file",
      content,
      message: "Create file",
    },
    idempotencyKey: "repository-effect-url-spelling",
  });
}

function effect() {
  const bytes = Buffer.from(content, "utf8");
  const sha = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
  return {
    name: "provider-sync.md",
    path,
    sha,
    size: bytes.byteLength,
    url:
      `https://api.github.com/repos/${repositoryFullName}/contents/docs/provider-sync.md`,
    git_url:
      `https://api.github.com/repos/${repositoryFullName}/git/blobs/${sha}`,
    type: "file",
  };
}
