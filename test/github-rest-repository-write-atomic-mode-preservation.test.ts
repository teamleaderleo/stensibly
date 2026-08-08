import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicMode";
const targetRef = "topic/atomic-mode";
const path = "tool.sh";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const previousBlobSha = "3".repeat(40);
const nextTreeSha = "5".repeat(40);
const nextCommitSha = "6".repeat(40);
const apiBaseUrl = "https://api.github.test";

interface RequestRecord { method: string; url: string; body: unknown; }

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
      expectedSha: gitBlobSha("#!/bin/sh\necho repaired\n") as string | null,
      blobWrites: 1,
    },
    {
      operation: "delete_file" as const,
      payload: {
        operation: "delete_file" as const,
        contentSha: previousBlobSha,
        message: "Delete executable",
      },
      expectedSha: null as string | null,
      blobWrites: 0,
    },
  ])("preserves parent mode 100755 for $operation", async ({ operation, payload, expectedSha, blobWrites }) => {
    const recorded: RequestRecord[] = [];
    const adapter = instance(recorded, "100755");
    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation,
      targetRef,
      expectedParentSha: parentSha,
      payload,
      idempotencyKey: `atomic-mode-${operation}`,
    })).resolves.toMatchObject({ commitSha: nextCommitSha, parentSha, targetRef });

    expect(recorded.filter((entry) => entry.url === blobCollectionUrl())).toHaveLength(blobWrites);
    expect(recorded).toContainEqual({
      method: "POST",
      url: treeCollectionUrl(),
      body: {
        base_tree: parentTreeSha,
        tree: [{ path, mode: "100755", type: "blob", sha: expectedSha }],
      },
    });
    expect(recorded.at(-1)).toEqual(expect.objectContaining({
      method: "POST",
      url: graphqlUrl(),
      body: expectedMutationBody(),
    }));
    expect(recorded.some((entry) => entry.method === "PATCH")).toBe(false);
  });

  test.each([
    { mode: "120000", type: "blob" },
    { mode: "160000", type: "commit" },
  ])("rejects unsupported parent mode $mode before any POST", async ({ mode, type }) => {
    const recorded: RequestRecord[] = [];
    const adapter = instance(recorded, mode, type);
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
    })).rejects.toThrow("GitHub repository write parent file mode is unsupported");
    expect(recorded.some((entry) => entry.method === "POST" || entry.method === "PATCH")).toBe(false);
  });
});

function instance(recorded: RequestRecord[], parentMode: string, parentType = "blob") {
  const nextBlobSha = gitBlobSha("#!/bin/sh\necho repaired\n");
  return new GitHubRestRepositoryWriteAdapter({
    tokenProvider: tokens(),
    apiBaseUrl,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      recorded.push({ method, url, body });
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
          tree: [{
            path,
            mode: parentMode,
            type: parentType,
            sha: previousBlobSha,
            url: blobUrl(previousBlobSha),
            size: 24,
          }],
          truncated: false,
        });
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
          expect(body).toEqual(expectedMutationBody());
          return Response.json({ data: { updateRefs: { clientMutationId: mutationId(body) } } }, {
            headers: { "x-github-request-id": "REQ-ATOMIC-MODE" },
          });
        }
      }
      if (method === "POST" && url === blobCollectionUrl()) {
        return Response.json({ sha: nextBlobSha, url: blobUrl(nextBlobSha) }, { status: 201 });
      }
      if (method === "POST" && url === treeCollectionUrl()) {
        return Response.json({ sha: nextTreeSha, url: treeUrl(nextTreeSha), tree: [], truncated: false }, { status: 201 });
      }
      if (method === "POST" && url === commitCollectionUrl()) {
        return Response.json({
          sha: nextCommitSha,
          tree: { sha: nextTreeSha, url: treeUrl(nextTreeSha) },
          parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
          url: commitUrl(nextCommitSha),
        }, { status: 201 });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    }) as unknown as typeof fetch,
  });
}

function expectedMutationBody(): unknown {
  return {
    query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    variables: {
      input: {
        repositoryId,
        refUpdates: [{ name: `refs/heads/${targetRef}`, beforeOid: parentSha, afterOid: nextCommitSha, force: false }],
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
function isQuery(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith("query StensiblyRepositoryNodeId");
}
function isMutation(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith("mutation StensiblyUpdateRefs");
}
function tokens(): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
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
