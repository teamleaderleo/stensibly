import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "main";
const parentSha = "1".repeat(40);
const commitSha = "2".repeat(40);
const canonicalCommitUrl =
  `https://api.github.com/repos/${repositoryFullName}/git/commits/${commitSha}`;
const canonicalParentUrl =
  `https://api.github.com/repos/${repositoryFullName}/git/commits/${parentSha}`;

describe("GitHub repository-write provider state URL spelling", () => {
  test("admits canonical optional ref, commit, and write URLs", async () => {
    await expect(refHead(canonicalCommitUrl)).resolves.toBe(commitSha);
    await expect(commitParents(canonicalCommitUrl)).resolves.toEqual([parentSha]);
    await expect(writeResult(canonicalCommitUrl)).resolves.toMatchObject({
      commitSha,
      parentSha,
      targetRef,
    });
  });

  test("rejects normalized aliases before publishing provider state", async () => {
    await expect(refHead(canonicalCommitUrl.replace(
      "https://api.github.com/",
      "https://api.github.com:443/",
    ))).rejects.toThrow("GitHub ref commit URL was invalid");

    await expect(commitParents(canonicalCommitUrl.replace(
      "https://api.github.com/",
      "https://API.GITHUB.COM/",
    ))).rejects.toThrow("GitHub commit URL was invalid");

    await expect(writeResult(canonicalCommitUrl.replace(
      `/git/commits/${commitSha}`,
      `/git/commits/extra/../${commitSha}`,
    ))).rejects.toThrow("GitHub repository write commit URL was invalid");
  });
});

async function refHead(providerCommitUrl: string) {
  const adapter = adapterFor(async () => Response.json({
    ref: `refs/heads/${targetRef}`,
    object: {
      type: "commit",
      sha: commitSha,
      url: providerCommitUrl,
    },
  }));
  return await adapter.getRefHead({ repositoryFullName, targetRef });
}

async function commitParents(providerCommitUrl: string) {
  const adapter = adapterFor(async () => Response.json({
    sha: commitSha,
    url: providerCommitUrl,
    parents: [{ sha: parentSha, url: canonicalParentUrl }],
  }));
  return await adapter.getCommitParents({ repositoryFullName, commitSha });
}

async function writeResult(providerCommitUrl: string) {
  const adapter = adapterFor(async () => Response.json({
    commit: {
      sha: commitSha,
      url: providerCommitUrl,
      parents: [{ sha: parentSha, url: canonicalParentUrl }],
    },
  }));
  return await adapter.dispatchRepositoryWrite({
    repositoryFullName,
    path: "docs/provider-state.md",
    operation: "create_file",
    targetRef,
    expectedParentSha: parentSha,
    payload: {
      operation: "create_file",
      content: "provider state\n",
      message: "Create provider state fixture",
    },
    idempotencyKey: "provider-state-url-spelling",
  });
}

function adapterFor(
  fetchImplementation: () => Promise<Response>,
): GitHubRestRepositoryWriteAdapter {
  return new GitHubRestRepositoryWriteAdapter({
    tokenProvider: {
      async getRepositoryContentsToken() {
        return {
          token: "installation-token",
          expiresAt: "2026-08-05T00:00:00.000Z",
        };
      },
    },
    fetch: fetchImplementation as typeof fetch,
  });
}
