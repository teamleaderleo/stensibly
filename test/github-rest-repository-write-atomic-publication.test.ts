import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWritePendingReconciliationError,
  GitHubRepositoryWriteProviderService,
  type GitHubRepositoryWriteAuthorityProvider,
  type GitHubRepositoryWriteCommand,
  type GitHubRepositoryWritePayload,
} from "../src/github-repository-write-provider-service.ts";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";
import { SqliteGitHubRepositoryWriteStore } from "../src/github-repository-write-store.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicPublication";
const targetRef = "topic/atomic-publication";
const path = "docs/atomic-publication.md";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const previousBlobSha = "3".repeat(40);
const nextTreeSha = "5".repeat(40);
const nextCommitSha = "6".repeat(40);
const apiBaseUrl = "https://api.github.test";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

describe("atomic native repository write publication", () => {
  test("constructs one direct-child commit and publishes exact old-ref CAS", async () => {
    const recorded: RecordedRequest[] = [];
    const tokenCalls: Array<"read" | "write"> = [];
    const content = "atomic content\n";
    const blobSha = gitBlobSha(content);
    const adapter = adapter(recorded, tokenCalls, "create_file", {
      operation: "create_file",
      content,
      message: "Create atomic file",
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: { operation: "create_file", content, message: "Create atomic file" },
      idempotencyKey: "atomic-create-1",
    })).resolves.toEqual({
      commitSha: nextCommitSha,
      providerRequestId: "REQ-ATOMIC-PUBLISH",
      targetRef,
      parentSha,
    });

    expect(recorded).toEqual([
      request("GET", commitUrl(parentSha), null, "read"),
      request("GET", recursiveTreeUrl(parentTreeSha), null, "read"),
      request("POST", graphqlUrl(), repositoryNodeQueryBody(), "read"),
      request("POST", blobCollectionUrl(), {
        content: Buffer.from(content, "utf8").toString("base64"),
        encoding: "base64",
      }, "write"),
      request("POST", treeCollectionUrl(), {
        base_tree: parentTreeSha,
        tree: [{ path, mode: "100644", type: "blob", sha: blobSha }],
      }, "write"),
      request("POST", commitCollectionUrl(), {
        message: "Create atomic file",
        tree: nextTreeSha,
        parents: [parentSha],
      }, "write"),
      request("POST", graphqlUrl(), expectedUpdateRefsBody(), "write"),
    ]);
    expect(tokenCalls).toEqual(["read", "read", "read", "write", "write", "write", "write"]);
  });

  test.each([
    {
      operation: "update_file" as const,
      payload: {
        operation: "update_file" as const,
        content: "updated atomically\n",
        contentSha: previousBlobSha,
        message: "Update atomic file",
      },
      expectedSha: gitBlobSha("updated atomically\n") as string | null,
      blobWrites: 1,
    },
    {
      operation: "delete_file" as const,
      payload: {
        operation: "delete_file" as const,
        contentSha: previousBlobSha,
        message: "Delete atomic file",
      },
      expectedSha: null as string | null,
      blobWrites: 0,
    },
  ])("binds $operation to immutable parent state", async ({ operation, payload, expectedSha, blobWrites }) => {
    const recorded: RecordedRequest[] = [];
    const instance = adapter(recorded, [], operation, payload);
    await expect(instance.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation,
      targetRef,
      expectedParentSha: parentSha,
      payload,
      idempotencyKey: `atomic-${operation}`,
    })).resolves.toMatchObject({ commitSha: nextCommitSha, parentSha, targetRef });

    expect(recorded.filter((entry) => entry.url === blobCollectionUrl())).toHaveLength(blobWrites);
    expect(recorded).toContainEqual(expect.objectContaining({
      method: "POST",
      url: treeCollectionUrl(),
      body: {
        base_tree: parentTreeSha,
        tree: [{ path, mode: "100644", type: "blob", sha: expectedSha }],
      },
    }));
    expect(recorded.at(-1)).toEqual(request("POST", graphqlUrl(), expectedUpdateRefsBody(), "write"));
  });

  test("keeps one dispatch for reconciliation after a GraphQL publication error", async () => {
    const recorded: RecordedRequest[] = [];
    let mutationCalls = 0;
    const instance = adapter(
      recorded,
      [],
      "create_file",
      { operation: "create_file", content: "raced content\n", message: "Race atomic file" },
      () => {
        mutationCalls += 1;
        return Response.json({
          data: { updateRefs: null },
          errors: [{ message: "reference changed", type: "STALE_REF" }],
        });
      },
      true,
    );
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter: instance,
      store,
      now: monotonicClock(),
      idFactory: () => "ghrw_atomic_race",
    });

    await expect(service.execute(command("atomic-race-1", "raced content\n")))
      .rejects.toBeInstanceOf(GitHubRepositoryWritePendingReconciliationError);
    await expect(service.execute(command("atomic-race-1", "raced content\n")))
      .rejects.toBeInstanceOf(GitHubRepositoryWritePendingReconciliationError);
    expect(mutationCalls).toBe(1);
    expect(recorded.filter((entry) => entry.method === "PATCH")).toEqual([]);
    store.close();
  });

  test("rejects changed parent blob before repository lookup or publication", async () => {
    const recorded: RecordedRequest[] = [];
    const payload = {
      operation: "update_file" as const,
      content: "changed\n",
      contentSha: previousBlobSha,
      message: "Update changed file",
    };
    const instance = adapter(recorded, [], "update_file", payload, undefined, false, "9".repeat(40));
    await expect(instance.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "update_file",
      targetRef,
      expectedParentSha: parentSha,
      payload,
      idempotencyKey: "changed-update",
    })).rejects.toThrow("GitHub repository write parent file precondition failed");
    expect(recorded.some((entry) => entry.url === graphqlUrl())).toBe(false);
  });
});

function adapter(
  recorded: RecordedRequest[],
  tokenCalls: Array<"read" | "write">,
  operation: "create_file" | "update_file" | "delete_file",
  payload: GitHubRepositoryWritePayload,
  mutationResponse?: (body: unknown) => Response,
  serviceHeadRead = false,
  observedBlobSha = previousBlobSha,
): GitHubRestRepositoryWriteAdapter {
  let headRead = serviceHeadRead;
  const producedBlobSha = payload.operation === "delete_file" ? null : gitBlobSha(payload.content);
  return new GitHubRestRepositoryWriteAdapter({
    tokenProvider: tokenProvider(tokenCalls),
    apiBaseUrl,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      recorded.push({ method, url, body, authorization: new Headers(init?.headers).get("authorization") });

      if (headRead && method === "GET" && url === readRefUrl()) {
        headRead = false;
        return Response.json({
          ref: `refs/heads/${targetRef}`,
          object: { type: "commit", sha: parentSha, url: commitUrl(parentSha) },
        });
      }
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
          tree: operation === "create_file" ? [] : [{
            path,
            mode: "100644",
            type: "blob",
            sha: observedBlobSha,
            url: blobUrl(observedBlobSha),
            size: 12,
          }],
          truncated: false,
        });
      }
      if (method === "POST" && url === graphqlUrl()) {
        if (isRepositoryNodeQuery(body)) {
          return Response.json({ data: { repository: { id: repositoryId } } });
        }
        if (isUpdateRefsMutation(body)) {
          expect(body).toEqual(expectedUpdateRefsBody());
          if (mutationResponse) return mutationResponse(body);
          const clientMutationId = mutationId(body);
          return Response.json({ data: { updateRefs: { clientMutationId } } }, {
            headers: { "x-github-request-id": "REQ-ATOMIC-PUBLISH" },
          });
        }
      }
      if (method === "POST" && url === blobCollectionUrl() && producedBlobSha) {
        return Response.json({ sha: producedBlobSha, url: blobUrl(producedBlobSha) }, { status: 201 });
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
      return Response.json({ message: "unexpected atomic request" }, { status: 500 });
    }) as unknown as typeof fetch,
  });
}

function expectedUpdateRefsBody(): unknown {
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
  const value = (body as { variables?: { input?: { clientMutationId?: unknown } } })
    .variables?.input?.clientMutationId;
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
function repositoryNodeQueryBody(): unknown {
  return {
    query: "query StensiblyRepositoryNodeId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }",
    variables: { owner: "teamleaderleo", name: "stensibly" },
  };
}
function request(method: string, url: string, body: unknown, access: "read" | "write"): RecordedRequest {
  return { method, url, body, authorization: `Bearer contents-${access}-token` };
}
function tokenProvider(calls: Array<"read" | "write">): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      calls.push(input.access);
      return { token: `contents-${input.access}-token`, expiresAt: "2026-08-08T12:00:00.000Z" };
    },
  };
}
function authorityProvider(): GitHubRepositoryWriteAuthorityProvider {
  return {
    async getRepositoryWriteAuthority() {
      return {
        version: 1,
        repositoryFullName,
        targetRef,
        defaultBranch: "main",
        authorityId: "authority_atomic_publication",
        authorityGeneration: 1,
        defaultBranchApprovalId: null,
      };
    },
  };
}
function command(idempotencyKey: string, content: string): GitHubRepositoryWriteCommand {
  return {
    project: "stensibly",
    actorId: "actor_atomic_publication",
    clientId: "client_atomic_publication",
    idempotencyKey,
    intent: { version: 1, repositoryFullName, path, operation: "create_file", targetRef, expectedParentSha: parentSha },
    payload: { operation: "create_file", content, message: "Race atomic file" },
  };
}
function monotonicClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 8, 0, 0, tick++)).toISOString();
}
function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
}
function root(): string { return `${apiBaseUrl}/repos/${repositoryFullName}`; }
function graphqlUrl(): string { return `${apiBaseUrl}/graphql`; }
function readRefUrl(): string { return `${root()}/git/ref/heads/${targetRef}`; }
function commitUrl(sha: string): string { return `${root()}/git/commits/${sha}`; }
function commitCollectionUrl(): string { return `${root()}/git/commits`; }
function blobCollectionUrl(): string { return `${root()}/git/blobs`; }
function blobUrl(sha: string): string { return `${root()}/git/blobs/${sha}`; }
function treeCollectionUrl(): string { return `${root()}/git/trees`; }
function treeUrl(sha: string): string { return `${root()}/git/trees/${sha}`; }
function recursiveTreeUrl(sha: string): string { return `${treeUrl(sha)}?recursive=1`; }