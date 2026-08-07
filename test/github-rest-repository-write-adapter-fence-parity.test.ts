import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubRestRepositoryWriteAdapter } from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOSha256Parity";
const sha40 = "a".repeat(40);
const parent64 = "b".repeat(64);
const commit64 = "c".repeat(64);
const parentTree64 = "d".repeat(64);
const nextTree64 = "e".repeat(64);
const createContent = "bounded content";
const blob64 = gitBlobSha256(createContent);

describe("GitHub repository-write adapter fence parity", () => {
  test.each([
    "TeamLeaderLeo/Stensibly",
    "git@github.com:teamleaderleo/stensibly.git",
    " https://github.com/teamleaderleo/stensibly ",
  ])("rejects repository alias %s before provider access", async (repository) => {
    const observed = mustNotReachProvider();
    await expect(observed.adapter.getRefHead({ repositoryFullName: repository, targetRef: "main" }))
      .rejects.toThrow("GitHub repository identity is invalid");
    expect(observed.tokenCalls()).toBe(0);
    expect(observed.fetchCalls()).toBe(0);
  });

  test.each(["HEAD", "refs/heads/main", "-topic", ".hidden/main", "topic.lock"])
    ("rejects branch alias %s before provider access", async (targetRef) => {
      const observed = mustNotReachProvider();
      await expect(observed.adapter.getRefHead({ repositoryFullName, targetRef }))
        .rejects.toThrow("GitHub target branch is invalid");
      expect(observed.tokenCalls()).toBe(0);
      expect(observed.fetchCalls()).toBe(0);
    });

  test.each([
    "docs/café.md",
    "docs/line\nbreak.md",
    `docs/repositoryxgithub_pat_${"a".repeat(20)}.md`,
  ])("rejects path %s before provider access", async (path) => {
    const observed = mustNotReachProvider();
    await expect(observed.adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef: "topic/review",
      expectedParentSha: sha40,
      payload: { operation: "create_file", content: createContent, message: "Create bounded file" },
      idempotencyKey: "fence-path-parity",
    })).rejects.toThrow("GitHub repository path is invalid");
    expect(observed.tokenCalls()).toBe(0);
    expect(observed.fetchCalls()).toBe(0);
  });

  test("preserves coherent SHA-256 identities through exact CAS", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: {
        async getRepositoryContentsToken() {
          return { token: "installation-token", expiresAt: "2026-08-08T12:00:00.000Z" };
        },
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown;
        requests.push({ method, url });

        if (method === "GET" && url === commitUrl(commit64)) {
          return Response.json({ sha: commit64, url: commitUrl(commit64), parents: [{ sha: parent64, url: commitUrl(parent64) }] });
        }
        if (method === "GET" && url === commitUrl(parent64)) {
          return Response.json({
            sha: parent64,
            tree: { sha: parentTree64, url: treeUrl(parentTree64) },
            parents: [],
            url: commitUrl(parent64),
          });
        }
        if (method === "GET" && url === recursiveTreeUrl(parentTree64)) {
          return Response.json({ sha: parentTree64, url: treeUrl(parentTree64), tree: [], truncated: false });
        }
        if (method === "POST" && url === graphqlUrl()) {
          if (isQuery(body)) return Response.json({ data: { repository: { id: repositoryId } } });
          if (isMutation(body)) {
            expect(body).toEqual({
              query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
              variables: {
                input: {
                  repositoryId,
                  refUpdates: [{ name: "refs/heads/topic/review", beforeOid: parent64, afterOid: commit64, force: false }],
                  clientMutationId: expect.stringMatching(/^stensibly-write-[a-f0-9]{64}$/),
                },
              },
            });
            return Response.json({ data: { updateRefs: { clientMutationId: mutationId(body) } } }, {
              headers: { "x-github-request-id": "REQ-SHA256-WRITE" },
            });
          }
        }
        if (method === "POST" && url === blobCollectionUrl()) {
          return Response.json({ sha: blob64, url: blobUrl(blob64) }, { status: 201 });
        }
        if (method === "POST" && url === treeCollectionUrl()) {
          return Response.json({ sha: nextTree64, url: treeUrl(nextTree64), tree: [], truncated: false }, { status: 201 });
        }
        if (method === "POST" && url === commitCollectionUrl()) {
          return Response.json({
            sha: commit64,
            tree: { sha: nextTree64, url: treeUrl(nextTree64) },
            parents: [{ sha: parent64, url: commitUrl(parent64) }],
            url: commitUrl(commit64),
          }, { status: 201 });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as unknown as typeof fetch,
    });

    await expect(adapter.getCommitParents({ repositoryFullName, commitSha: commit64 })).resolves.toEqual([parent64]);
    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path: "docs/review.md",
      operation: "create_file",
      targetRef: "topic/review",
      expectedParentSha: parent64,
      payload: { operation: "create_file", content: createContent, message: "Create bounded file" },
      idempotencyKey: "sha256-write-parity",
    })).resolves.toEqual({
      commitSha: commit64,
      providerRequestId: "REQ-SHA256-WRITE",
      targetRef: "topic/review",
      parentSha: parent64,
    });

    expect(requests.at(-1)).toEqual({ method: "POST", url: graphqlUrl() });
    expect(requests.some((entry) => entry.method === "PATCH")).toBe(false);
  });
});

function mutationId(body: unknown): string {
  const value = (body as { variables?: { input?: { clientMutationId?: unknown } } }).variables?.input?.clientMutationId;
  if (typeof value !== "string") throw new Error("Missing mutation identity in test fixture");
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
function root(): string { return `https://api.github.com/repos/${repositoryFullName}`; }
function graphqlUrl(): string { return "https://api.github.com/graphql"; }
function commitUrl(sha: string): string { return `${root()}/git/commits/${sha}`; }
function commitCollectionUrl(): string { return `${root()}/git/commits`; }
function blobCollectionUrl(): string { return `${root()}/git/blobs`; }
function blobUrl(sha: string): string { return `${blobCollectionUrl()}/${sha}`; }
function treeCollectionUrl(): string { return `${root()}/git/trees`; }
function treeUrl(sha: string): string { return `${treeCollectionUrl()}/${sha}`; }
function recursiveTreeUrl(sha: string): string { return `${treeUrl(sha)}?recursive=1`; }
function gitBlobSha256(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha256").update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
}
function mustNotReachProvider() {
  let tokens = 0;
  let fetches = 0;
  const adapter = new GitHubRestRepositoryWriteAdapter({
    tokenProvider: {
      async getRepositoryContentsToken() {
        tokens += 1;
        return { token: "must-not-mint", expiresAt: "2026-08-08T12:00:00.000Z" };
      },
    },
    fetch: (async () => {
      fetches += 1;
      return Response.json({ message: "must not fetch" }, { status: 500 });
    }) as unknown as typeof fetch,
  });
  return { adapter, tokenCalls: () => tokens, fetchCalls: () => fetches };
}