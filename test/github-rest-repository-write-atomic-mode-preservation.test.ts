import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/atomic-mode";
const path = "tool.sh";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const previousBlobSha = "3".repeat(40);
const nextBlobSha = "4".repeat(40);
const nextTreeSha = "5".repeat(40);
const nextCommitSha = "6".repeat(40);
const apiBaseUrl = "https://api.github.test";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

describe("atomic repository file mode preservation", () => {
  test.each([
    {
      operation: "update_file" as const,
      payload: {
        operation: "update_file" as const,
        content: "#!/bin/sh\necho repaired\n",
        contentSha: previousBlobSha,
        message: "Update executable",
      },
      expectedSha: nextBlobSha,
      expectsBlobWrite: true,
    },
    {
      operation: "delete_file" as const,
      payload: {
        operation: "delete_file" as const,
        contentSha: previousBlobSha,
        message: "Delete executable",
      },
      expectedSha: null,
      expectsBlobWrite: false,
    },
  ])("preserves parent mode 100755 for $operation", async ({
    operation,
    payload,
    expectedSha,
    expectsBlobWrite,
  }) => {
    const recorded: RecordedRequest[] = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(),
      apiBaseUrl,
      fetch: atomicModeFetcher({
        recorded,
        parentMode: "100755",
        expectsBlobWrite,
      }),
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation,
      targetRef,
      expectedParentSha: parentSha,
      payload,
      idempotencyKey: `atomic-mode-${operation}`,
    })).resolves.toMatchObject({
      commitSha: nextCommitSha,
      parentSha,
      targetRef,
    });

    expect(recorded).toContainEqual({
      method: "GET",
      url: treeUrl(parentTreeSha),
      body: null,
    });
    expect(recorded).toContainEqual({
      method: "POST",
      url: treeCollectionUrl(),
      body: {
        base_tree: parentTreeSha,
        tree: [{
          path,
          mode: "100755",
          type: "blob",
          sha: expectedSha,
        }],
      },
    });
    expect(recorded.filter((request) =>
      request.method === "POST" && request.url === blobCollectionUrl()
    )).toHaveLength(expectsBlobWrite ? 1 : 0);
  });

  test.each([
    { mode: "120000", type: "blob" },
    { mode: "160000", type: "commit" },
  ])("rejects unsupported parent mode $mode before publication", async ({
    mode,
    type,
  }) => {
    const recorded: RecordedRequest[] = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(),
      apiBaseUrl,
      fetch: atomicModeFetcher({
        recorded,
        parentMode: mode,
        parentType: type,
        expectsBlobWrite: false,
      }),
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "delete_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "delete_file",
        contentSha: previousBlobSha,
        message: "Reject unsupported mode",
      },
      idempotencyKey: `atomic-mode-${mode}`,
    })).rejects.toThrow(
      "GitHub repository write parent file mode is unsupported",
    );

    expect(recorded.some((request) =>
      request.method === "POST" || request.method === "PATCH"
    )).toBe(false);
  });
});

function atomicModeFetcher(input: {
  recorded: RecordedRequest[];
  parentMode: string;
  parentType?: string;
  expectsBlobWrite: boolean;
}): typeof fetch {
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(request);
    const body = init?.body === undefined
      ? null
      : JSON.parse(String(init.body));
    input.recorded.push({ method, url, body });

    if (method === "GET" && url === commitUrl(parentSha)) {
      return Response.json({
        sha: parentSha,
        tree: {
          sha: parentTreeSha,
          url: treeUrl(parentTreeSha),
        },
        parents: [],
        url: commitUrl(parentSha),
      });
    }
    if (method === "GET" && url === treeUrl(parentTreeSha)) {
      return Response.json({
        sha: parentTreeSha,
        url: treeUrl(parentTreeSha),
        tree: [{
          path,
          mode: input.parentMode,
          type: input.parentType ?? "blob",
          sha: previousBlobSha,
          url: blobUrl(previousBlobSha),
          size: 24,
        }],
        truncated: false,
      });
    }
    if (
      input.expectsBlobWrite
      && method === "POST"
      && url === blobCollectionUrl()
    ) {
      return Response.json({
        sha: nextBlobSha,
        url: blobUrl(nextBlobSha),
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
        headers: { "x-github-request-id": "REQ-ATOMIC-MODE" },
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
        expiresAt: "2026-08-05T12:00:00.000Z",
      };
    },
  };
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
