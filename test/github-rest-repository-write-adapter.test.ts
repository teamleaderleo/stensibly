import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDORepositoryWrite";
const targetRef = "feature/repository-write";
const path = "docs/provider-write.md";
const parentSha = "a".repeat(40);
const parentTreeSha = "b".repeat(40);
const blobSha = gitBlobSha("safe\n");
const treeSha = "d".repeat(40);
const commitSha = "e".repeat(40);
const apiBaseUrl = "https://api.github.test";

describe("native GitHub repository file write adapter", () => {
  test("invokes a stored native-style fetch without rebinding its receiver", async () => {
    const tokens: Array<"read" | "write"> = [];
    const requests: string[] = [];
    const receiverSensitiveFetch = (function (
      this: unknown,
      input: RequestInfo | URL,
    ) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      requests.push(String(input));
      return Promise.resolve(Response.json({
        ref: `refs/heads/${targetRef}`,
        object: {
          type: "commit",
          sha: parentSha,
          url: commitUrl(parentSha),
        },
      }));
    }) as typeof fetch;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(tokens),
      apiBaseUrl,
      fetch: receiverSensitiveFetch,
    });

    await expect(adapter.getRefHead({ repositoryFullName, targetRef }))
      .resolves.toBe(parentSha);
    expect(tokens).toEqual(["read"]);
    expect(requests).toEqual([`${root()}/git/ref/heads/feature/repository-write`]);
  });

  test("returns null for an absent ref and validates commit parent identity", async () => {
    const tokens: Array<"read" | "write"> = [];
    let cancelled = false;
    const responses = [
      {
        ok: false,
        status: 404,
        headers: new Headers(),
        body: { cancel() { cancelled = true; } },
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
    expect(await adapter.getCommitParents({ repositoryFullName, commitSha })).toEqual([parentSha]);
    expect(tokens).toEqual(["read", "read"]);
  });

  test("returns one bounded complete commit-tree snapshot for canonical readback", async () => {
    const tokens: Array<"read" | "write"> = [];
    const requests: string[] = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(tokens),
      apiBaseUrl,
      fetch: (async (request: RequestInfo | URL) => {
        const url = String(request);
        requests.push(url);
        if (url === commitUrl(commitSha)) {
          return Response.json({
            sha: commitSha,
            url: commitUrl(commitSha),
            message: "Exact candidate message\n\nwith detail",
            tree: { sha: treeSha, url: treeUrl(treeSha) },
            parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
          });
        }
        if (url === recursiveTreeUrl(treeSha)) {
          return Response.json({
            sha: treeSha,
            url: treeUrl(treeSha),
            truncated: false,
            tree: [
              { path: "docs", mode: "040000", type: "tree", sha: parentTreeSha, url: treeUrl(parentTreeSha) },
              { path, mode: "100644", type: "blob", sha: blobSha, url: blobUrl(blobSha) },
            ],
          });
        }
        throw new Error("unexpected request");
      }) as typeof fetch,
    });

    const result = await adapter.getCommitTreeSnapshot({
      repositoryFullName,
      commitSha,
    });

    expect(result).toEqual({
      version: 1,
      repositoryFullName,
      commitSha,
      parentShas: [parentSha],
      messageSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      treeSha,
      entries: [{ path, mode: "100644", type: "blob", sha: blobSha }],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(tokens).toEqual(["read", "read"]);
    expect(requests).toEqual([commitUrl(commitSha), recursiveTreeUrl(treeSha)]);
  });

  test("refuses a truncated recursive tree instead of proving a partial diff", async () => {
    const responses = [
      Response.json({
        sha: commitSha,
        message: "Exact candidate message",
        tree: { sha: treeSha },
        parents: [{ sha: parentSha }],
      }),
      Response.json({ sha: treeSha, truncated: true, tree: [] }),
    ];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: (async () => responses.shift()!) as unknown as typeof fetch,
    });

    await expect(adapter.getCommitTreeSnapshot({ repositoryFullName, commitSha }))
      .rejects.toThrow("GitHub complete tree response was incomplete");
  });

  test("drops a credential-shaped request ID after exact-CAS publication", async () => {
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: atomicFetcher({ requestId: `github_pat_${"x".repeat(24)}` }),
    });

    const result = await adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: { operation: "create_file", content: "safe\n", message: "Create safe file" },
      idempotencyKey: "atomic-hostile-request-id",
    });

    expect(result).toEqual({ commitSha, targetRef, parentSha });
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
        headers: new Headers({ "content-length": String(512 * 1024 + 1) }),
        body: { cancel() { cancelled = true; return new Promise<void>(() => {}); } },
      } as unknown as Response)) as unknown as typeof fetch,
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: { operation: "create_file", content: "safe\n", message: "Create bounded file" },
      idempotencyKey: "atomic-oversized-parent",
    })).rejects.toThrow("GitHub read expected parent commit response exceeded its byte limit");
    expect(cancelled).toBe(true);
  });

  test("keeps the fixed HTTP failure when exact-CAS publication is rejected", async () => {
    let cancelled = false;
    let patchCalls = 0;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: atomicFetcher({
        onPatch() { patchCalls += 1; },
        publicationResponse: () => ({
          ok: false,
          status: 422,
          headers: new Headers(),
          body: { cancel() { cancelled = true; return new Promise<void>(() => {}); } },
        } as unknown as Response),
      }),
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: { operation: "create_file", content: "safe\n", message: "Create raced file" },
      idempotencyKey: "atomic-ref-race",
    })).rejects.toThrow("GitHub could not publish repository ref (HTTP 422)");
    expect(cancelled).toBe(true);
    expect(patchCalls).toBe(0);
  });
});

function atomicFetcher(input: {
  requestId?: string;
  publicationResponse?: () => Response;
  onPatch?: () => void;
}): typeof fetch {
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(request);
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
      if (isRepositoryNodeQuery(body)) {
        return Response.json({
          data: {
            repository: { id: repositoryId, nameWithOwner: repositoryFullName },
          },
        });
      }
      if (isUpdateRefsMutation(body)) {
        expect(body).toEqual(updateRefsBody());
        return input.publicationResponse?.() ?? Response.json({
          data: { updateRefs: { clientMutationId: mutationId(body) } },
        }, {
          headers: input.requestId ? { "x-github-request-id": input.requestId } : undefined,
        });
      }
    }
    if (method === "POST" && url === blobCollectionUrl()) {
      return Response.json({ sha: blobSha, url: blobUrl(blobSha) }, { status: 201 });
    }
    if (method === "POST" && url === treeCollectionUrl()) {
      return Response.json({ sha: treeSha, url: treeUrl(treeSha), tree: [], truncated: false }, { status: 201 });
    }
    if (method === "POST" && url === commitCollectionUrl()) {
      return Response.json({
        sha: commitSha,
        tree: { sha: treeSha, url: treeUrl(treeSha) },
        parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
        url: commitUrl(commitSha),
      }, { status: 201 });
    }
    if (method === "PATCH") {
      input.onPatch?.();
      return Response.json({ message: "unexpected REST publication" }, { status: 500 });
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  }) as unknown as typeof fetch;
}

function updateRefsBody(): unknown {
  return {
    query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    variables: {
      input: {
        repositoryId,
        refUpdates: [{ name: `refs/heads/${targetRef}`, beforeOid: parentSha, afterOid: commitSha, force: false }],
        clientMutationId: expect.stringMatching(/^stensibly-write-[a-f0-9]{64}$/),
      },
    },
  };
}
function mutationId(body: unknown): string {
  const value = (body as { variables?: { input?: { clientMutationId?: unknown } } }).variables?.input?.clientMutationId;
  if (typeof value !== "string") throw new Error("Missing mutation identity in test fixture");
  return value;
}
function isRepositoryNodeQuery(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith("query StensiblyRepositoryNodeId");
}
function isUpdateRefsMutation(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith("mutation StensiblyUpdateRefs");
}
function tokenProvider(calls: Array<"read" | "write">): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      calls.push(input.access);
      return { token: `contents-${input.access}-token`, expiresAt: "2026-08-08T12:00:00.000Z" };
    },
  };
}
function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
}
function root(): string { return `${apiBaseUrl}/repos/${repositoryFullName}`; }
function graphqlUrl(): string { return `${apiBaseUrl}/graphql`; }
function commitUrl(sha: string): string { return `${root()}/git/commits/${sha}`; }
function commitCollectionUrl(): string { return `${root()}/git/commits`; }
function treeUrl(sha: string): string { return `${root()}/git/trees/${sha}`; }
function recursiveTreeUrl(sha: string): string { return `${treeUrl(sha)}?recursive=1`; }
function treeCollectionUrl(): string { return `${root()}/git/trees`; }
function blobUrl(sha: string): string { return `${root()}/git/blobs/${sha}`; }
function blobCollectionUrl(): string { return `${root()}/git/blobs`; }
