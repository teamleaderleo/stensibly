import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubRestRepositoryFileCompensationAdapter } from "../src/github-rest-repository-file-compensation-adapter.ts";
import type { GitHubRepositoryWriteTokenProvider } from "../src/github-rest-repository-write-adapter.ts";

const apiBaseUrl = "https://api.github.test";
const repository = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOFileCompensation";
const targetRef = "topic/file-compensation";
const path = "fixtures/exact.bin";
const sourceCommitSha = "1".repeat(40);
const sourceTreeSha = "2".repeat(40);
const parentTreeSha = "3".repeat(40);
const compensationCommitSha = "4".repeat(40);
const currentBlobSha = "5".repeat(40);
const oldBytes = Buffer.from([0, 1, 2, 255, 10]);
const oldBlobSha = gitBlobSha(oldBytes);

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

describe("GitHubRestRepositoryFileCompensationAdapter", () => {
  test("fetches one immutable blob transiently and proves Git object/content identity", async () => {
    const instance = new GitHubRestRepositoryFileCompensationAdapter({
      tokenProvider: tokenProvider(),
      apiBaseUrl,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("GET");
        expect(String(input)).toBe(blobUrl(oldBlobSha));
        return Response.json({
          sha: oldBlobSha,
          size: oldBytes.byteLength,
          encoding: "base64",
          content: oldBytes.toString("base64"),
          url: blobUrl(oldBlobSha),
        });
      }) as unknown as typeof fetch,
    });

    const value = await instance.getBlobBytes({
      repositoryFullName: repository,
      blobSha: oldBlobSha,
      maximumBytes: 1024,
    });
    expect(value).toMatchObject({
      repositoryFullName: repository,
      blobSha: oldBlobSha,
      byteLength: oldBytes.byteLength,
      contentSha256: sha256Bytes(oldBytes),
    });
    expect(Buffer.from(value.bytes)).toEqual(oldBytes);
  });

  test("restores immutable parent blob/mode with no blob upload and exact updateRefs CAS", async () => {
    const recorded: Recorded[] = [];
    const instance = adapter(recorded);

    await expect(instance.dispatchRepositoryFileCompensation({
      repositoryFullName: repository,
      path,
      targetRef,
      expectedParentSha: sourceCommitSha,
      expectedCurrent: { kind: "blob", mode: "100755", blobSha: currentBlobSha },
      restored: { kind: "blob", mode: "100755", blobSha: oldBlobSha },
      expectedRestoredTreeSha: parentTreeSha,
      message: "Stensibly repository-file compensation opw_fixture",
      idempotencyKey: "file-compensation-native-1",
    })).resolves.toEqual({
      commitSha: compensationCommitSha,
      targetRef,
      parentSha: sourceCommitSha,
      restoredTreeSha: parentTreeSha,
      providerRequestId: "REQ-FILE-COMP",
    });

    expect(recorded.some((entry) => entry.url === blobCollectionUrl())).toBe(false);
    expect(recorded).toContainEqual({
      method: "POST",
      url: treeCollectionUrl(),
      body: {
        base_tree: sourceTreeSha,
        tree: [{ path, mode: "100755", type: "blob", sha: oldBlobSha }],
      },
    });
    expect(recorded).toContainEqual({
      method: "POST",
      url: commitCollectionUrl(),
      body: {
        message: "Stensibly repository-file compensation opw_fixture",
        tree: parentTreeSha,
        parents: [sourceCommitSha],
      },
    });
    const publication = recorded.at(-1)!;
    expect(publication.method).toBe("POST");
    expect(publication.url).toBe(graphqlUrl());
    expect(publication.body).toEqual(expectedUpdateRefsBody());
  });

  test("create compensation deletes only the exact created path", async () => {
    const recorded: Recorded[] = [];
    const instance = adapter(recorded);
    await instance.dispatchRepositoryFileCompensation({
      repositoryFullName: repository,
      path,
      targetRef,
      expectedParentSha: sourceCommitSha,
      expectedCurrent: { kind: "blob", mode: "100644", blobSha: currentBlobSha },
      restored: { kind: "absent" },
      expectedRestoredTreeSha: parentTreeSha,
      message: "Stensibly repository-file compensation opw_fixture",
      idempotencyKey: "file-compensation-native-delete",
    });
    expect(recorded).toContainEqual({
      method: "POST",
      url: treeCollectionUrl(),
      body: {
        base_tree: sourceTreeSha,
        tree: [{ path, mode: "100644", type: "blob", sha: null }],
      },
    });
  });

  test("current path mismatch aborts before tree/commit/ref mutation", async () => {
    const recorded: Recorded[] = [];
    const instance = adapter(recorded, { observedCurrentBlobSha: "9".repeat(40) });
    await expect(instance.dispatchRepositoryFileCompensation({
      repositoryFullName: repository,
      path,
      targetRef,
      expectedParentSha: sourceCommitSha,
      expectedCurrent: { kind: "blob", mode: "100755", blobSha: currentBlobSha },
      restored: { kind: "blob", mode: "100755", blobSha: oldBlobSha },
      expectedRestoredTreeSha: parentTreeSha,
      message: "Stensibly repository-file compensation opw_fixture",
      idempotencyKey: "file-compensation-native-drift",
    })).rejects.toThrow("source-postimage path drifted");
    expect(recorded.some((entry) => entry.url === treeCollectionUrl())).toBe(false);
    expect(recorded.some((entry) => entry.url === commitCollectionUrl())).toBe(false);
  });

  test("provider-created tree must equal immutable parent tree before commit/ref publication", async () => {
    const recorded: Recorded[] = [];
    const instance = adapter(recorded, { returnedTreeSha: "8".repeat(40) });
    await expect(instance.dispatchRepositoryFileCompensation({
      repositoryFullName: repository,
      path,
      targetRef,
      expectedParentSha: sourceCommitSha,
      expectedCurrent: { kind: "blob", mode: "100755", blobSha: currentBlobSha },
      restored: { kind: "blob", mode: "100755", blobSha: oldBlobSha },
      expectedRestoredTreeSha: parentTreeSha,
      message: "Stensibly repository-file compensation opw_fixture",
      idempotencyKey: "file-compensation-native-tree-drift",
    })).rejects.toThrow("did not equal the immutable parent tree");
    expect(recorded.some((entry) => entry.url === commitCollectionUrl())).toBe(false);
    expect(recorded.filter((entry) => entry.url === graphqlUrl())).toHaveLength(1);
  });
});

function adapter(
  recorded: Recorded[],
  options: { observedCurrentBlobSha?: string; returnedTreeSha?: string } = {},
): GitHubRestRepositoryFileCompensationAdapter {
  return new GitHubRestRepositoryFileCompensationAdapter({
    tokenProvider: tokenProvider(),
    apiBaseUrl,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      recorded.push({ method, url, body });

      if (method === "GET" && url === commitUrl(sourceCommitSha)) {
        return Response.json({
          sha: sourceCommitSha,
          url: commitUrl(sourceCommitSha),
          tree: { sha: sourceTreeSha, url: treeUrl(sourceTreeSha) },
        });
      }
      if (method === "GET" && url === recursiveTreeUrl(sourceTreeSha)) {
        const observed = options.observedCurrentBlobSha ?? currentBlobSha;
        return Response.json({
          sha: sourceTreeSha,
          url: treeUrl(sourceTreeSha),
          truncated: false,
          tree: [{
            path,
            mode: "100755",
            type: "blob",
            sha: observed,
            url: blobUrl(observed),
          }],
        });
      }
      if (method === "POST" && url === graphqlUrl() && isRepositoryNodeQuery(body)) {
        return Response.json({ data: { repository: { id: repositoryId, nameWithOwner: repository } } });
      }
      if (method === "POST" && url === treeCollectionUrl()) {
        const treeSha = options.returnedTreeSha ?? parentTreeSha;
        return Response.json({ sha: treeSha, url: treeUrl(treeSha), truncated: false }, { status: 201 });
      }
      if (method === "POST" && url === commitCollectionUrl()) {
        return Response.json({
          sha: compensationCommitSha,
          url: commitUrl(compensationCommitSha),
          tree: { sha: parentTreeSha, url: treeUrl(parentTreeSha) },
          parents: [{ sha: sourceCommitSha, url: commitUrl(sourceCommitSha) }],
        }, { status: 201 });
      }
      if (method === "POST" && url === graphqlUrl() && isUpdateRefsMutation(body)) {
        expect(body).toEqual(expectedUpdateRefsBody());
        return Response.json({
          data: { updateRefs: { clientMutationId: mutationId(body) } },
        }, { headers: { "x-github-request-id": "REQ-FILE-COMP" } });
      }
      return Response.json({ message: "unexpected compensation request" }, { status: 500 });
    }) as unknown as typeof fetch,
  });
}

function expectedUpdateRefsBody(): unknown {
  return {
    query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    variables: {
      input: {
        repositoryId,
        refUpdates: [{
          name: `refs/heads/${targetRef}`,
          beforeOid: sourceCommitSha,
          afterOid: compensationCommitSha,
          force: false,
        }],
        clientMutationId: expect.stringMatching(/^stensibly-write-[a-f0-9]{64}$/),
      },
    },
  };
}

function mutationId(body: unknown): string {
  const value = (body as { variables?: { input?: { clientMutationId?: unknown } } })
    .variables?.input?.clientMutationId;
  if (typeof value !== "string") throw new Error("missing mutation id");
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
function tokenProvider(): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      return { token: `contents-${input.access}`, expiresAt: "2026-08-15T12:00:00.000Z" };
    },
  };
}
function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8")).update(bytes).digest("hex");
}
function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function root(): string { return `${apiBaseUrl}/repos/${repository}`; }
function graphqlUrl(): string { return `${apiBaseUrl}/graphql`; }
function commitUrl(sha: string): string { return `${root()}/git/commits/${sha}`; }
function commitCollectionUrl(): string { return `${root()}/git/commits`; }
function treeUrl(sha: string): string { return `${root()}/git/trees/${sha}`; }
function recursiveTreeUrl(sha: string): string { return `${treeUrl(sha)}?recursive=1`; }
function treeCollectionUrl(): string { return `${root()}/git/trees`; }
function blobUrl(sha: string): string { return `${root()}/git/blobs/${sha}`; }
function blobCollectionUrl(): string { return `${root()}/git/blobs`; }
