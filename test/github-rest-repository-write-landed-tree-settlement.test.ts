import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWritePostEffectError,
} from "../src/github-repository-write-post-effect-error.ts";
import type {
  GitHubRepositoryWritePayload,
} from "../src/github-repository-write-provider-service.ts";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/landed-tree";
const path = "docs/landed-tree.md";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const previousBlobSha = "3".repeat(40);
const nextTreeSha = "4".repeat(40);
const nextCommitSha = "5".repeat(40);
const apiBaseUrl = "https://api.github.test";

describe("canonical landed-tree settlement", () => {
  test.each([
    {
      operation: "create_file" as const,
      payload: {
        operation: "create_file" as const,
        content: "created exactly\n",
        message: "Create exact file",
      },
      parentMode: null,
      landedMode: "100644",
    },
    {
      operation: "update_file" as const,
      payload: {
        operation: "update_file" as const,
        content: "updated exactly\n",
        contentSha: previousBlobSha,
        message: "Update exact file",
      },
      parentMode: "100755",
      landedMode: "100755",
    },
    {
      operation: "delete_file" as const,
      payload: {
        operation: "delete_file" as const,
        contentSha: previousBlobSha,
        message: "Delete exact file",
      },
      parentMode: "100644",
      landedMode: null,
    },
  ])("settles exact $operation only after published tree readback", async ({
    operation,
    payload,
    parentMode,
    landedMode,
  }) => {
    const requests: Array<{ method: string; url: string }> = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(),
      apiBaseUrl,
      fetch: settlementFetcher({
        operation,
        payload,
        parentMode,
        landedMode,
        requests,
      }),
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation,
      targetRef,
      expectedParentSha: parentSha,
      payload,
      idempotencyKey: `landed-${operation}`,
    })).resolves.toEqual({
      commitSha: nextCommitSha,
      providerRequestId: "REQ-LANDED-TREE",
      targetRef,
      parentSha,
    });

    const patchIndex = requests.findIndex((request) => request.method === "PATCH");
    expect(patchIndex).toBeGreaterThan(-1);
    expect(requests.slice(patchIndex + 1)).toEqual([
      { method: "GET", url: commitUrl(nextCommitSha) },
      { method: "GET", url: recursiveTreeUrl(nextTreeSha) },
    ]);
  });

  test.each([
    {
      name: "wrong blob",
      postBlobSha: "9".repeat(40),
      failPostCommit: false,
    },
    {
      name: "unreadable commit",
      postBlobSha: null,
      failPostCommit: true,
    },
  ])("carries exact publication evidence when $name breaks settlement", async ({
    postBlobSha,
    failPostCommit,
  }) => {
    const requests: Array<{ method: string; url: string }> = [];
    const payload = {
      operation: "create_file" as const,
      content: "created exactly\n",
      message: "Create exact file",
    };
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(),
      apiBaseUrl,
      fetch: settlementFetcher({
        operation: "create_file",
        payload,
        parentMode: null,
        landedMode: "100644",
        requests,
        postBlobSha,
        failPostCommit,
      }),
    });

    let error: unknown;
    try {
      await adapter.dispatchRepositoryWrite({
        repositoryFullName,
        path,
        operation: "create_file",
        targetRef,
        expectedParentSha: parentSha,
        payload,
        idempotencyKey: "landed-failure",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitHubRepositoryWritePostEffectError);
    expect(error).toMatchObject({
      code: "repository_write_effect_readback_incomplete",
      result: {
        commitSha: nextCommitSha,
        providerRequestId: "REQ-LANDED-TREE",
        targetRef,
        parentSha,
      },
    });
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });
});

function settlementFetcher(input: {
  operation: "create_file" | "update_file" | "delete_file";
  payload: GitHubRepositoryWritePayload;
  parentMode: "100644" | "100755" | null;
  landedMode: "100644" | "100755" | null;
  requests: Array<{ method: string; url: string }>;
  postBlobSha?: string | null;
  failPostCommit?: boolean;
}): typeof fetch {
  const requestedBlobSha = input.payload.operation === "delete_file"
    ? null
    : gitBlobSha(input.payload.content);
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(request);
    input.requests.push({ method, url });

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
        tree: input.parentMode === null
          ? []
          : [{
              path,
              mode: input.parentMode,
              type: "blob",
              sha: previousBlobSha,
              url: blobUrl(previousBlobSha),
              size: 16,
            }],
        truncated: false,
      });
    }
    if (method === "POST" && url === blobCollectionUrl()) {
      if (!requestedBlobSha) {
        return Response.json({ message: "unexpected blob" }, { status: 500 });
      }
      return Response.json({
        sha: requestedBlobSha,
        url: blobUrl(requestedBlobSha),
      }, { status: 201 });
    }
    if (method === "POST" && url === treeCollectionUrl()) {
      return Response.json({
        sha: nextTreeSha,
        url: treeUrl(nextTreeSha),
        tree: [],
        truncated: false,
      }, { status: 201 });
    }
    if (method === "POST" && url === commitCollectionUrl()) {
      return Response.json({
        sha: nextCommitSha,
        tree: { sha: nextTreeSha, url: treeUrl(nextTreeSha) },
        parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
        url: commitUrl(nextCommitSha),
      }, { status: 201 });
    }
    if (method === "PATCH" && url === updateRefUrl()) {
      return Response.json({
        ref: `refs/heads/${targetRef}`,
        object: {
          type: "commit",
          sha: nextCommitSha,
          url: commitUrl(nextCommitSha),
        },
      }, {
        status: 200,
        headers: { "x-github-request-id": "REQ-LANDED-TREE" },
      });
    }
    if (method === "GET" && url === commitUrl(nextCommitSha)) {
      if (input.failPostCommit) {
        return Response.json({ message: "unavailable" }, { status: 503 });
      }
      return Response.json({
        sha: nextCommitSha,
        tree: { sha: nextTreeSha, url: treeUrl(nextTreeSha) },
        parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
        url: commitUrl(nextCommitSha),
      });
    }
    if (method === "GET" && url === recursiveTreeUrl(nextTreeSha)) {
      const landedBlobSha = input.postBlobSha === undefined
        ? requestedBlobSha
        : input.postBlobSha;
      return Response.json({
        sha: nextTreeSha,
        url: treeUrl(nextTreeSha),
        tree: input.landedMode === null
          ? []
          : [{
              path,
              mode: input.landedMode,
              type: "blob",
              sha: landedBlobSha,
              url: blobUrl(landedBlobSha ?? "0".repeat(40)),
              size: input.payload.operation === "delete_file"
                ? 0
                : Buffer.byteLength(input.payload.content, "utf8"),
            }],
        truncated: false,
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
