import { expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const apiBaseUrl = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/repository-provenance";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);

test("rejects substituted repository node provenance before Git object writes", async () => {
  let writeObjectCalls = 0;
  const adapter = new GitHubRestRepositoryWriteAdapter({
    tokenProvider: tokens(),
    apiBaseUrl,
    fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(request);
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));

      if (method === "GET" && url === commitUrl(parentSha)) {
        return Response.json({
          sha: parentSha,
          url: commitUrl(parentSha),
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
          truncated: false,
          tree: [],
        });
      }
      if (method === "POST" && url === graphqlUrl()) {
        const query = (body as { query?: unknown })?.query;
        if (
          typeof query === "string"
          && query.startsWith("query StensiblyRepositoryNodeId")
        ) {
          return Response.json({
            data: {
              repository: {
                id: "R_kgDOSubstitutedRepository",
                nameWithOwner: "teamleaderleo/other-repository",
              },
            },
          });
        }
      }
      if (
        method === "POST"
        && (
          url === blobCollectionUrl()
          || url === treeCollectionUrl()
          || url === commitCollectionUrl()
        )
      ) {
        writeObjectCalls += 1;
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    }) as unknown as typeof fetch,
  });

  await expect(adapter.dispatchRepositoryWrite({
    repositoryFullName,
    path: "docs/repository-provenance.md",
    operation: "create_file",
    targetRef,
    expectedParentSha: parentSha,
    payload: {
      operation: "create_file",
      content: "provider-bound repository\n",
      message: "Prove repository provenance",
    },
    idempotencyKey: "repository-provenance-1",
  })).rejects.toThrow("GitHub updateRefs GraphQL response is invalid");

  expect(writeObjectCalls).toBe(0);
});

function tokens(): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      return {
        token: `contents-${input.access}-token`,
        expiresAt: "2026-08-08T12:00:00.000Z",
      };
    },
  };
}

function root(): string { return `${apiBaseUrl}/repos/${repositoryFullName}`; }
function graphqlUrl(): string { return `${apiBaseUrl}/graphql`; }
function commitUrl(sha: string): string { return `${root()}/git/commits/${sha}`; }
function commitCollectionUrl(): string { return `${root()}/git/commits`; }
function treeUrl(sha: string): string { return `${root()}/git/trees/${sha}`; }
function recursiveTreeUrl(sha: string): string { return `${treeUrl(sha)}?recursive=1`; }
function treeCollectionUrl(): string { return `${root()}/git/trees`; }
function blobCollectionUrl(): string { return `${root()}/git/blobs`; }