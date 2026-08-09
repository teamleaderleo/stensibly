import { describe, expect, test } from "bun:test";
import { GitHubRestRepositoryWriteAdapter } from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOProviderUrlSpelling";
const targetRef = "main";
const parentSha = "1".repeat(40);
const commitSha = "2".repeat(40);
const parentTreeSha = "3".repeat(40);
const nextTreeSha = "4".repeat(40);
const blobSha = "6603f5fe188ed53cb293e5a4b6697765e9a6f6e9";
const canonicalCommitUrl = commitUrl(commitSha);
const canonicalParentUrl = commitUrl(parentSha);

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("GitHub repository-write provider state URL spelling", () => {
  test("admits canonical optional ref, commit, and write URLs", async () => {
    await expect(refHead(canonicalCommitUrl)).resolves.toBe(commitSha);
    await expect(commitParents(canonicalCommitUrl)).resolves.toEqual([parentSha]);
    await expect(writeResult(canonicalCommitUrl)).resolves.toMatchObject({ commitSha, parentSha, targetRef });
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
    ))).rejects.toThrow("GitHub repository commit URL was invalid");
  });
});

async function refHead(providerCommitUrl: string) {
  return await adapterFor(async () => Response.json({
    ref: `refs/heads/${targetRef}`,
    object: { type: "commit", sha: commitSha, url: providerCommitUrl },
  })).getRefHead({ repositoryFullName, targetRef });
}

async function commitParents(providerCommitUrl: string) {
  return await adapterFor(async () => Response.json({
    sha: commitSha,
    url: providerCommitUrl,
    parents: [{ sha: parentSha, url: canonicalParentUrl }],
  })).getCommitParents({ repositoryFullName, commitSha });
}

async function writeResult(providerCommitUrl: string) {
  const adapter = adapterFor(async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown;
    if (method === "GET" && url === commitUrl(parentSha)) {
      return Response.json({
        sha: parentSha,
        tree: { sha: parentTreeSha, url: treeUrl(parentTreeSha) },
        parents: [],
        url: commitUrl(parentSha),
      });
    }
    if (method === "GET" && url === recursiveTreeUrl(parentTreeSha)) {
      return Response.json({ sha: parentTreeSha, url: treeUrl(parentTreeSha), tree: [], truncated: false });
    }
    if (method === "POST" && url === graphqlUrl()) {
      if (isQuery(body)) {
        return Response.json({
          data: {
            repository: { id: repositoryId, nameWithOwner: repositoryFullName },
          },
        });
      }
      if (isMutation(body)) {
        return Response.json({ data: { updateRefs: { clientMutationId: mutationId(body) } } }, {
          headers: { "x-github-request-id": "REQ-PROVIDER-URL" },
        });
      }
    }
    if (method === "POST" && url === blobCollectionUrl()) {
      return Response.json({ sha: blobSha, url: blobUrl(blobSha) }, { status: 201 });
    }
    if (method === "POST" && url === treeCollectionUrl()) {
      return Response.json({ sha: nextTreeSha, url: treeUrl(nextTreeSha), tree: [], truncated: false }, { status: 201 });
    }
    if (method === "POST" && url === commitCollectionUrl()) {
      return Response.json({
        sha: commitSha,
        tree: { sha: nextTreeSha, url: treeUrl(nextTreeSha) },
        parents: [{ sha: parentSha, url: canonicalParentUrl }],
        url: providerCommitUrl,
      }, { status: 201 });
    }
    return Response.json({ message: "unexpected atomic request" }, { status: 500 });
  });
  return await adapter.dispatchRepositoryWrite({
    repositoryFullName,
    path: "docs/provider-state.md",
    operation: "create_file",
    targetRef,
    expectedParentSha: parentSha,
    payload: { operation: "create_file", content: "provider state\n", message: "Create provider state fixture" },
    idempotencyKey: "provider-state-url-spelling",
  });
}

function mutationId(body: unknown): string {
  const value = (body as { variables?: { input?: { clientMutationId?: unknown } } }).variables?.input?.clientMutationId;
  if (typeof value !== "string" || !/^stensibly-write-[a-f0-9]{64}$/.test(value)) {
    throw new Error("Missing mutation identity in test fixture");
  }
  return value;
}
function isQuery(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith("query StensiblyRepositoryNodeId");
}
function isMutation(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith("mutation StensiblyUpdateRefs");
}
function adapterFor(fetchImplementation: FetchImplementation): GitHubRestRepositoryWriteAdapter {
  return new GitHubRestRepositoryWriteAdapter({
    tokenProvider: {
      async getRepositoryContentsToken() {
        return { token: "installation-token", expiresAt: "2026-08-08T12:00:00.000Z" };
      },
    },
    fetch: fetchImplementation as unknown as typeof fetch,
  });
}
function root(): string { return `https://api.github.com/repos/${repositoryFullName}`; }
function graphqlUrl(): string { return "https://api.github.com/graphql"; }
function commitUrl(sha: string): string { return `${root()}/git/commits/${sha}`; }
function commitCollectionUrl(): string { return `${root()}/git/commits`; }
function blobCollectionUrl(): string { return `${root()}/git/blobs`; }
function blobUrl(sha: string): string { return `${blobCollectionUrl()}/${sha}`; }
function treeCollectionUrl(): string { return `${root()}/git/trees`; }
function treeUrl(sha: string): string { return `${treeCollectionUrl()}/${sha}`; }
function recursiveTreeUrl(sha: string): string { return `${treeUrl(sha)}?recursive=1`; }
