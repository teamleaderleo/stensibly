import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const apiBaseUrl = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAncestorRegression";
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
  test("rejects publication when the observed branch regresses to an ancestor", async () => {
    let providerCurrentHead = expectedParentSha;
    let patchCalls = 0;
    let updateRefsCalls = 0;
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
        if (method === "POST" && url === graphqlUrl()) {
          const body = JSON.parse(String(init?.body)) as {
            query?: unknown;
            variables?: {
              input?: {
                repositoryId?: unknown;
                refUpdates?: Array<{
                  name?: unknown;
                  beforeOid?: unknown;
                  afterOid?: unknown;
                  force?: unknown;
                }>;
                clientMutationId?: unknown;
              };
            };
          };
          if (
            typeof body.query === "string"
            && body.query.startsWith("query StensiblyRepositoryNodeId")
          ) {
            return Response.json({ data: { repository: { id: repositoryId } } });
          }
          if (
            typeof body.query === "string"
            && body.query.startsWith("mutation StensiblyUpdateRefs")
          ) {
            updateRefsCalls += 1;
            expect(body.variables?.input).toEqual({
              repositoryId,
              refUpdates: [{
                name: `refs/heads/${targetRef}`,
                beforeOid: expectedParentSha,
                afterOid: nextCommitSha,
                force: false,
              }],
              clientMutationId: `stensibly-write-${nextCommitSha.slice(0, 16)}`,
            });
            if (providerCurrentHead !== expectedParentSha) {
              return Response.json({
                data: { updateRefs: null },
                errors: [{
                  message: "provider stale ref detail",
                  type: "STALE_REF",
                }],
              });
            }
            providerCurrentHead = nextCommitSha;
            return Response.json({
              data: {
                updateRefs: {
                  clientMutationId: `stensibly-write-${nextCommitSha.slice(0, 16)}`,
                },
              },
            });
          }
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
        if (method === "PATCH") {
          patchCalls += 1;
          return Response.json({ message: "REST ref PATCH is forbidden" }, {
            status: 500,
          });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as unknown as typeof fetch,
    });

    await expect(adapter.getRefHead({
      repositoryFullName,
      targetRef,
    })).resolves.toBe(expectedParentSha);

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
    })).rejects.toThrow(
      "GitHub repository write exact old ref changed before publication",
    );

    expect(updateRefsCalls).toBe(1);
    expect(patchCalls).toBe(0);
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

function graphqlUrl(): string {
  return `${apiBaseUrl}/graphql`;
}

function readRefUrl(): string {
  return `${repositoryUrl()}/git/ref/heads/${targetRef}`;
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