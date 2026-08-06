import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "feature/repository-write";
const path = "docs/provider-write.md";
const parentSha = "a".repeat(40);
const parentTreeSha = "b".repeat(40);
const blobSha = gitBlobSha("safe\n");
const treeSha = "d".repeat(40);
const commitSha = "e".repeat(40);
const apiBaseUrl = "https://api.github.test";

describe("native GitHub repository file write adapter", () => {
  test("returns null for an absent ref and validates commit parent identity", async () => {
    const tokens: Array<"read" | "write"> = [];
    let cancelled = false;
    const responses = [
      {
        ok: false,
        status: 404,
        headers: new Headers(),
        body: {
          cancel() {
            cancelled = true;
          },
        },
      } as unknown as Response,
      Response.json({
        sha: commitSha,
        url: commitUrl(commitSha),
        parents: [{ sha: parentSha }],
      }),
    ];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(tokens),
      apiBaseUrl,
      fetch: (async () => responses.shift()!) as unknown as typeof fetch,
    });

    expect(await adapter.getRefHead({ repositoryFullName, targetRef })).toBeNull();
    expect(cancelled).toBe(true);
    expect(await adapter.getCommitParents({
      repositoryFullName,
      commitSha,
    })).toEqual([parentSha]);
    expect(tokens).toEqual(["read", "read"]);
  });

  test("drops a credential-shaped request ID after atomic publication", async () => {
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: atomicFetcher({
        requestId: `github_pat_${"x".repeat(24)}`,
      }),
    });

    const result = await adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "create_file",
        content: "safe\n",
        message: "Create safe file",
      },
      idempotencyKey: "atomic-hostile-request-id",
    });

    expect(result).toEqual({
      commitSha,
      targetRef,
      parentSha,
    });
    expect(JSON.stringify(result)).not.toContain("github_pat_");
  });

  test("cancels an oversized expected-parent response before retaining bytes", async () => {
    let cancelled = false;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: (async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-length": String(512 * 1024 + 1),
        }),
        body: {
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        },
      } as unknown as Response)) as unknown as typeof fetch,
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "create_file",
        content: "safe\n",
        message: "Create bounded file",
      },
      idempotencyKey: "atomic-oversized-parent",
    })).rejects.toThrow(
      "GitHub read expected parent commit response exceeded its byte limit",
    );
    expect(cancelled).toBe(true);
  });

  test("keeps the fixed HTTP failure when non-forced publication is rejected", async () => {
    let cancelled = false;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: atomicFetcher({
        publicationResponse: () => ({
          ok: false,
          status: 422,
          headers: new Headers(),
          body: {
            cancel() {
              cancelled = true;
              return new Promise<void>(() => {});
            },
          },
        } as unknown as Response),
      }),
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "create_file",
        content: "safe\n",
        message: "Create raced file",
      },
      idempotencyKey: "atomic-ref-race",
    })).rejects.toThrow(
      "GitHub could not publish repository ref (HTTP 422)",
    );
    expect(cancelled).toBe(true);
  });
});

function atomicFetcher(input: {
  requestId?: string;
  publicationResponse?: () => Response;
}): typeof fetch {
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(request);
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
      return Response.json({
        sha: blobSha,
        url: blobUrl(blobSha),
      }, { status: 201 });
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
      return input.publicationResponse?.() ?? Response.json({
        ref: `refs/heads/${targetRef}`,
        object: {
          type: "commit",
          sha: commitSha,
          url: commitUrl(commitSha),
        },
      }, {
        status: 200,
        headers: input.requestId
          ? { "x-github-request-id": input.requestId }
          : undefined,
      });
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  }) as unknown as typeof fetch;
}

function tokenProvider(
  calls: Array<"read" | "write">,
): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      calls.push(input.access);
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
