import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const api = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAncestorRegression";
const targetRef = "topic/ancestor-regression";
const path = "docs/ancestor-regression.md";
const ancestor = "1".repeat(40);
const parent = "2".repeat(40);
const parentTree = "3".repeat(40);
const nextTree = "4".repeat(40);
const nextCommit = "5".repeat(40);
const content = "exact-parent publication\n";
const nextBlob = gitBlobSha(content);

test("exact-old-ref CAS does not publish after ancestor regression", async () => {
  let currentHead = parent;
  let updateRefsCalls = 0;
  let patchCalls = 0;
  const adapter = new GitHubRestRepositoryWriteAdapter({
    tokenProvider: tokens(),
    apiBaseUrl: api,
    fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(request);
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));

      if (method === "GET" && url === refUrl()) return refResponse(currentHead);
      if (method === "GET" && url === commitUrl(parent)) {
        return Response.json({
          sha: parent,
          url: commitUrl(parent),
          tree: { sha: parentTree, url: treeUrl(parentTree) },
        });
      }
      if (method === "GET" && url === recursiveTreeUrl(parentTree)) {
        return Response.json({
          sha: parentTree,
          url: treeUrl(parentTree),
          tree: [],
          truncated: false,
        });
      }
      if (method === "POST" && url === graphqlUrl()) {
        const query = (body as { query?: unknown })?.query;
        if (typeof query === "string" && query.startsWith("query StensiblyRepositoryNodeId")) {
          return Response.json({ data: { repository: { id: repositoryId } } });
        }
        if (typeof query === "string" && query.startsWith("mutation StensiblyUpdateRefs")) {
          updateRefsCalls += 1;
          const input = (body as {
            variables?: { input?: Record<string, unknown> };
          }).variables?.input;
          expect(input).toEqual({
            repositoryId,
            refUpdates: [{
              name: `refs/heads/${targetRef}`,
              beforeOid: parent,
              afterOid: nextCommit,
              force: false,
            }],
            clientMutationId: expect.stringMatching(/^stensibly-write-[a-f0-9]{64}$/),
          });
          if (currentHead !== parent) {
            return Response.json({
              data: { updateRefs: null },
              errors: [{ message: "reference changed", type: "STALE_REF" }],
            });
          }
          currentHead = nextCommit;
          return Response.json({
            data: { updateRefs: { clientMutationId: input?.clientMutationId } },
          });
        }
      }
      if (method === "POST" && url === blobCollectionUrl()) {
        return Response.json({ sha: nextBlob, url: blobUrl(nextBlob) }, { status: 201 });
      }
      if (method === "POST" && url === treeCollectionUrl()) {
        return Response.json({
          sha: nextTree,
          url: treeUrl(nextTree),
          tree: [],
          truncated: false,
        }, { status: 201 });
      }
      if (method === "POST" && url === commitCollectionUrl()) {
        return Response.json({
          sha: nextCommit,
          url: commitUrl(nextCommit),
          tree: { sha: nextTree, url: treeUrl(nextTree) },
          parents: [{ sha: parent, url: commitUrl(parent) }],
        }, { status: 201 });
      }
      if (method === "PATCH") {
        patchCalls += 1;
        return Response.json({ message: "unexpected REST publication" }, { status: 500 });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    }) as unknown as typeof fetch,
  });

  await expect(adapter.getRefHead({ repositoryFullName, targetRef })).resolves.toBe(parent);
  currentHead = ancestor;

  await expect(adapter.dispatchRepositoryWrite({
    repositoryFullName,
    path,
    operation: "create_file",
    targetRef,
    expectedParentSha: parent,
    payload: {
      operation: "create_file",
      content,
      message: "Prove exact-parent publication",
    },
    idempotencyKey: "ancestor-regression-1",
  })).rejects.toThrow("GitHub could not publish repository ref");

  expect(updateRefsCalls).toBe(1);
  expect(patchCalls).toBe(0);
  expect(currentHead).toBe(ancestor);
});

function tokens(): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      return {
        token: `contents-${input.access}-token`,
        expiresAt: "2026-08-08T00:00:00.000Z",
      };
    },
  };
}

function gitBlobSha(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function root(): string { return `${api}/repos/${repositoryFullName}`; }
function graphqlUrl(): string { return `${api}/graphql`; }
function refUrl(): string { return `${root()}/git/ref/heads/${targetRef}`; }
function commitUrl(sha: string): string { return `${root()}/git/commits/${sha}`; }
function commitCollectionUrl(): string { return `${root()}/git/commits`; }
function treeUrl(sha: string): string { return `${root()}/git/trees/${sha}`; }
function recursiveTreeUrl(sha: string): string { return `${treeUrl(sha)}?recursive=1`; }
function treeCollectionUrl(): string { return `${root()}/git/trees`; }
function blobUrl(sha: string): string { return `${root()}/git/blobs/${sha}`; }
function blobCollectionUrl(): string { return `${root()}/git/blobs`; }
function refResponse(sha: string): Response {
  return Response.json({
    ref: `refs/heads/${targetRef}`,
    object: { type: "commit", sha, url: commitUrl(sha) },
  });
}