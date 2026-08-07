import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const apiBaseUrl = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/ancestor-regression";
const path = "docs/ancestor-regression.md";
const ancestorSha = "1".repeat(40);
const expectedParentSha = "2".repeat(40);
const parentTreeSha = "3".repeat(40);
const nextTreeSha = "4".repeat(40);
const nextCommitSha = "5".repeat(40);
const content = "exact-parent publication\n";
const nextBlobSha = gitBlobSha(content);

describe("atomic repository publication ancestor regression", () => {
  test("does not accept a provider fast-forward after the observed branch regresses to an ancestor", async () => {
    let providerCurrentHead = expectedParentSha;
    let patchCalls = 0;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(),
      apiBaseUrl,
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(request);

        if (method === "GET" && url === readRefUrl()) {
          return refResponse(providerCurrentHead);
        }
        if (method === "GET" && url === commitUrl(expectedParentSha)) {
          return Response.json({
            sha: expectedParentSha,
            url: commitUrl(expectedParentSha),
            tree: {
              sha: parentTreeSha,
              url: treeUrl(parentTreeSha),
            },
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
            url: commitUrl(nextCommitSha),
            tree: {
              sha: nextTreeSha,
              url: treeUrl(nextTreeSha),
            },
            parents: [{
              sha: expectedParentSha,
              url: commitUrl(expectedParentSha),
            }],
          }, { status: 201 });
        }
        if (method === "PATCH" && url === updateRefUrl()) {
          patchCalls += 1;
          const body = JSON.parse(String(init?.body)) as {
            sha?: unknown;
            force?: unknown;
          };
          expect(body).toEqual({ sha: nextCommitSha, force: false });

          // Provider-accurate fast-forward semantics: after an external force
          // regression to ancestorSha, nextCommitSha is still a descendant of
          // the current ref through expectedParentSha, so force:false permits
          // this update even though the ref changed after observation.
          if (providerCurrentHead === ancestorSha) {
            providerCurrentHead = nextCommitSha;
            return refResponse(nextCommitSha, 200);
          }
          return Response.json({ message: "Reference update failed" }, {
            status: 422,
          });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as unknown as typeof fetch,
    });

    // This is the exact service-side observation made before dispatch.
    await expect(adapter.getRefHead({
      repositoryFullName,
      targetRef,
    })).resolves.toBe(expectedParentSha);

    // A concurrent actor force-regresses the branch after that observation.
    providerCurrentHead = ancestorSha;

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha,
      payload: {
        operation: "create_file",
        content,
        message: "Prove exact-parent publication",
      },
      idempotencyKey: "ancestor-regression-1",
    })).rejects.toThrow();

    expect(patchCalls).toBeLessThanOrEqual(1);
    expect(providerCurrentHead).toBe(ancestorSha);
  });
});

function tokenProvider(): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      return {
        token: `contents-${input.access}-token`,
        expiresAt: "2026-08-08T00:00:00.000Z",
      };
    },
  };
}

function refResponse(sha: string, status = 200): Response {
  return Response.json({
    ref: `refs/heads/${targetRef}`,
    object: {
      type: "commit",
      sha,
      url: commitUrl(sha),
    },
  }, { status });
}

function gitBlobSha(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function repositoryUrl(): string {
  return `${apiBaseUrl}/repos/${repositoryFullName}`;
}

function readRefUrl(): string {
  return `${repositoryUrl()}/git/ref/heads/${targetRef}`;
}

function updateRefUrl(): string {
  return `${repositoryUrl()}/git/refs/heads/${targetRef}`;
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
