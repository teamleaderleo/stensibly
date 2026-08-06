import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWritePostEffectError,
} from "../src/github-repository-write-post-effect-error.ts";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/publication-attribution";
const path = "docs/publication-attribution.md";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const blobSha = gitBlobSha("published\n");
const treeSha = "4".repeat(40);
const commitSha = "5".repeat(40);
const apiBaseUrl = "https://api.github.test";

describe("repository publication response attribution", () => {
  test("retains request identity when successful PATCH JSON is malformed", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(),
      apiBaseUrl,
      fetch: fetcher(requests),
    });

    let error: unknown;
    try {
      await adapter.dispatchRepositoryWrite({
        repositoryFullName,
        path,
        operation: "create_file",
        targetRef,
        expectedParentSha: parentSha,
        payload: {
          operation: "create_file",
          content: "published\n",
          message: "Publish attributed file",
        },
        idempotencyKey: "publication-attribution",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitHubRepositoryWritePostEffectError);
    expect(error).toMatchObject({
      code: "repository_write_effect_readback_incomplete",
      result: {
        commitSha,
        providerRequestId: "REQ-PATCH-ATTRIBUTED",
        targetRef,
        parentSha,
      },
    });
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(requests.some((request) =>
      request.method === "GET" && request.url === commitUrl(commitSha)
    )).toBe(false);
  });
});

function fetcher(
  requests: Array<{ method: string; url: string }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    requests.push({ method, url });

    if (method === "GET" && url === commitUrl(parentSha)) {
      return Response.json({
        sha: parentSha,
        tree: { sha: parentTreeSha, url: treeUrl(parentTreeSha) },
        parents: [],
        url: commitUrl(parentSha),
      });
    }
    if (method === "GET" && url === recursiveTreeUrl(parentTreeSha)) {
      return Response.json({
        sha: parentTreeSha,
        url: treeUrl(parentTreeSha),
        tree: [],
        truncated: false,
      });
    }
    if (method === "POST" && url === blobCollectionUrl()) {
      return Response.json({ sha: blobSha, url: blobUrl(blobSha) }, {
        status: 201,
      });
    }
    if (method === "POST" && url === treeCollectionUrl()) {
      return Response.json({
        sha: treeSha,
        url: treeUrl(treeSha),
        tree: [],
        truncated: false,
      }, { status: 201 });
    }
    if (method === "POST" && url === commitCollectionUrl()) {
      return Response.json({
        sha: commitSha,
        tree: { sha: treeSha, url: treeUrl(treeSha) },
        parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
        url: commitUrl(commitSha),
      }, { status: 201 });
    }
    if (method === "PATCH" && url === updateRefUrl()) {
      return new Response("{", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-github-request-id": "REQ-PATCH-ATTRIBUTED",
        },
      });
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  }) as unknown as typeof fetch;
}

function tokenProvider(): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      return {
        token: `contents-${input.access}-token`,
        expiresAt: "2026-08-06T12:00:00.000Z",
      };
    },
  };
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function repositoryUrl(): string {
  return `${apiBaseUrl}/repos/${repositoryFullName}`;
}

function commitUrl(sha: string): string {
  return `${repositoryUrl()}/git/commits/${sha}`;
}

function commitCollectionUrl(): string {
  return `${repositoryUrl()}/git/commits`;
}

function treeUrl(sha: string): string {
  return `${repositoryUrl()}/git/trees/${sha}`;
}

function recursiveTreeUrl(sha: string): string {
  return `${treeUrl(sha)}?recursive=1`;
}

function treeCollectionUrl(): string {
  return `${repositoryUrl()}/git/trees`;
}

function blobUrl(sha: string): string {
  return `${repositoryUrl()}/git/blobs/${sha}`;
}

function blobCollectionUrl(): string {
  return `${repositoryUrl()}/git/blobs`;
}

function updateRefUrl(): string {
  return `${repositoryUrl()}/git/refs/heads/${targetRef}`;
}
