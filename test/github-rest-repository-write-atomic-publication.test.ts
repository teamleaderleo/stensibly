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
const nextBlobSha = gitBlobSha("atomic content\n");
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
  test("constructs one direct-child commit and publishes it with exact old-ref CAS", async () => {
    const recorded: RecordedRequest[] = [];
    const tokenCalls: Array<"read" | "write"> = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(tokenCalls),
      apiBaseUrl,
      fetch: atomicFetcher({
        recorded,
        operation: "create_file",
        payload: {
          operation: "create_file",
          content: "atomic content\n",
          message: "Create atomic file",
        },
      }),
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "create_file",
        content: "atomic content\n",
        message: "Create atomic file",
      },
      idempotencyKey: "atomic-create-1",
    })).resolves.toEqual({
      commitSha: nextCommitSha,
      providerRequestId: "REQ-ATOMIC-PUBLISH",
      targetRef,
      parentSha,
    });

    expect(recorded).toEqual([
      {
        method: "GET",
        url: commitUrl(parentSha),
        body: null,
        authorization: "Bearer contents-read-token",
      },
      {
        method: "GET",
        url: recursiveTreeUrl(parentTreeSha),
        body: null,
        authorization: "Bearer contents-read-token",
      },
      {
        method: "POST",
        url: graphqlUrl(),
        body: repositoryNodeQueryBody(),
        authorization: "Bearer contents-read-token",
      },
      {
        method: "POST",
        url: blobCollectionUrl(),
        body: {
          content: Buffer.from("atomic content\n", "utf8").toString("base64"),
          encoding: "base64",
        },
        authorization: "Bearer contents-write-token",
      },
      {
        method: "POST",
        url: treeCollectionUrl(),
        body: {
          base_tree: parentTreeSha,
          tree: [{
            path,
            mode: "100644",
            type: "blob",
            sha: nextBlobSha,
          }],
        },
        authorization: "Bearer contents-write-token",
      },
      {
        method: "POST",
        url: commitCollectionUrl(),
        body: {
          message: "Create atomic file",
          tree: nextTreeSha,
          parents: [parentSha],
        },
        authorization: "Bearer contents-write-token",
      },
      {
        method: "POST",
        url: graphqlUrl(),
        body: updateRefsBody(),
        authorization: "Bearer contents-write-token",
      },
    ]);
    expect(tokenCalls).toEqual([
      "read",
      "read",
      "read",
      "write",
      "write",
      "write",
      "write",
    ]);
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
      expectedTreeEntry: {
        path,
        mode: "100644",
        type: "blob",
        sha: gitBlobSha("updated atomically\n"),
      },
      expectsBlobWrite: true,
    },
    {
      operation: "delete_file" as const,
      payload: {
        operation: "delete_file" as const,
        contentSha: previousBlobSha,
        message: "Delete atomic file",
      },
      expectedTreeEntry: {
        path,
        mode: "100644",
        type: "blob",
        sha: null,
      },
      expectsBlobWrite: false,
    },
  ])("binds $operation to the immutable parent tree entry", async ({
    operation,
    payload,
    expectedTreeEntry,
    expectsBlobWrite,
  }) => {
    const recorded: RecordedRequest[] = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: atomicFetcher({ recorded, operation, payload }),
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path,
      operation,
      targetRef,
      expectedParentSha: parentSha,
      payload,
      idempotencyKey: `atomic-${operation}`,
    })).resolves.toMatchObject({
      commitSha: nextCommitSha,
      parentSha,
      targetRef,
    });

    expect(recorded).toContainEqual(expect.objectContaining({
      method: "GET",
      url: recursiveTreeUrl(parentTreeSha),
    }));
    expect(recorded).toContainEqual(expect.objectContaining({
      method: "POST",
      url: graphqlUrl(),
      body: repositoryNodeQueryBody(),
    }));
    expect(recorded.filter((request) =>
      request.method === "POST" && request.url === blobCollectionUrl()
    )).toHaveLength(expectsBlobWrite ? 1 : 0);
    expect(recorded).toContainEqual(expect.objectContaining({
      method: "POST",
      url: treeCollectionUrl(),
      body: {
        base_tree: parentTreeSha,
        tree: [expectedTreeEntry],
      },
    }));
    expect(recorded.at(-1)).toMatchObject({
      method: "POST",
      url: graphqlUrl(),
      body: updateRefsBody(),
    });
  });

  test("keeps the lane for reconciliation when exact-CAS publication rejects", async () => {
    const recorded: RecordedRequest[] = [];
    let publicationCalls = 0;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: atomicFetcher({
        recorded,
        operation: "create_file",
        payload: {
          operation: "create_file",
          content: "raced content\n",
          message: "Race atomic file",
        },
        publicationResponse() {
          publicationCalls += 1;
          return Response.json({
            data: { updateRefs: null },
            errors: [{ message: "provider stale ref", type: "STALE_REF" }],
          });
        },
        includeServiceHeadRead: true,
      }),
    });
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: monotonicClock(),
      idFactory: () => "ghrw_atomic_race",
    });

    let firstError: GitHubRepositoryWritePendingReconciliationError | null = null;
    try {
      await service.execute(command("atomic-race-1", "raced content\n"));
    } catch (error) {
      expect(error).toBeInstanceOf(
        GitHubRepositoryWritePendingReconciliationError,
      );
      firstError = error as GitHubRepositoryWritePendingReconciliationError;
    }
    if (!firstError) throw new Error("Expected pending reconciliation");
    expect(firstError.receipt).toMatchObject({
      state: "pending_reconciliation",
      dispatchCount: 1,
      error: {
        code: "repository_write_provider_outcome_ambiguous",
        retry: "reconcile_before_retry",
      },
    });
    expect(publicationCalls).toBe(1);

    await expect(service.execute(command(
      "atomic-race-1",
      "raced content\n",
    ))).rejects.toBeInstanceOf(
      GitHubRepositoryWritePendingReconciliationError,
    );
    expect(publicationCalls).toBe(1);
    expect(publicationRequests(recorded)).toEqual([
      expect.objectContaining({
        url: graphqlUrl(),
        body: updateRefsBody(),
      }),
    ]);
    expect(recorded.filter((request) => request.method === "PATCH")).toEqual([]);
    store.close();
  });

  test("rejects update and delete before repository lookup or publication when the parent blob changed", async () => {
    for (const operation of ["update_file", "delete_file"] as const) {
      let publicationCalls = 0;
      const recorded: RecordedRequest[] = [];
      const payload: GitHubRepositoryWritePayload = operation === "update_file"
        ? {
            operation,
            content: "changed\n",
            contentSha: previousBlobSha,
            message: "Update changed file",
          }
        : {
            operation,
            contentSha: previousBlobSha,
            message: "Delete changed file",
          };
      const adapter = new GitHubRestRepositoryWriteAdapter({
        tokenProvider: tokenProvider([]),
        apiBaseUrl,
        fetch: atomicFetcher({
          recorded,
          operation,
          payload,
          observedBlobSha: "9".repeat(40),
          publicationResponse() {
            publicationCalls += 1;
            return updateRefsResponse();
          },
        }),
      });

      await expect(adapter.dispatchRepositoryWrite({
        repositoryFullName,
        path,
        operation,
        targetRef,
        expectedParentSha: parentSha,
        payload,
        idempotencyKey: `changed-${operation}`,
      })).rejects.toThrow(
        "GitHub repository write parent file precondition failed",
      );
      expect(publicationCalls).toBe(0);
      expect(recorded.some((request) => request.url === graphqlUrl())).toBe(false);
    }
  });
});

function atomicFetcher(input: {
  recorded: RecordedRequest[];
  operation: "create_file" | "update_file" | "delete_file";
  payload: GitHubRepositoryWritePayload;
  observedBlobSha?: string;
  publicationResponse?: () => Response;
  includeServiceHeadRead?: boolean;
}): typeof fetch {
  let serviceHeadRead = input.includeServiceHeadRead ?? false;
  const producedBlobSha = input.payload.operation === "delete_file"
    ? null
    : gitBlobSha(input.payload.content);
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(request);
    const body = init?.body === undefined
      ? null
      : JSON.parse(String(init.body));
    input.recorded.push({
      method,
      url,
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });

    if (serviceHeadRead && method === "GET" && url === readRefUrl()) {
      serviceHeadRead = false;
      return Response.json({
        ref: `refs/heads/${targetRef}`,
        object: {
          type: "commit",
          sha: parentSha,
          url: commitUrl(parentSha),
        },
      });
    }
    if (method === "GET" && url === commitUrl(parentSha)) {
      return Response.json({
        sha: parentSha,
        tree: {
          sha: parentTreeSha,
          url: treeUrl(parentTreeSha),
        },
        parents: [],
        url: commitUrl(parentSha),
      });
    }
    if (method === "GET" && url === recursiveTreeUrl(parentTreeSha)) {
      const observedBlobSha = input.observedBlobSha ?? previousBlobSha;
      return Response.json({
        sha: parentTreeSha,
        url: treeUrl(parentTreeSha),
        tree: input.operation === "create_file"
          ? []
          : [{
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
        return input.publicationResponse?.() ?? updateRefsResponse();
      }
    }
    if (method === "POST" && url === blobCollectionUrl()) {
      if (!producedBlobSha) {
        return Response.json({ message: "unexpected blob write" }, {
          status: 500,
        });
      }
      return Response.json({
        sha: producedBlobSha,
        url: blobUrl(producedBlobSha),
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
        tree: {
          sha: nextTreeSha,
          url: treeUrl(nextTreeSha),
        },
        parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
        url: commitUrl(nextCommitSha),
      }, { status: 201 });
    }
    return Response.json({ message: "unexpected atomic request" }, {
      status: 500,
    });
  }) as unknown as typeof fetch;
}

function isRepositoryNodeQuery(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith(
      "query StensiblyRepositoryNodeId",
    );
}

function isUpdateRefsMutation(body: unknown): boolean {
  return typeof (body as { query?: unknown })?.query === "string"
    && String((body as { query: string }).query).startsWith(
      "mutation StensiblyUpdateRefs",
    );
}

function publicationRequests(recorded: RecordedRequest[]): RecordedRequest[] {
  return recorded.filter((request) =>
    request.method === "POST"
    && request.url === graphqlUrl()
    && isUpdateRefsMutation(request.body)
  );
}

function repositoryNodeQueryBody(): unknown {
  return {
    query: "query StensiblyRepositoryNodeId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }",
    variables: { owner: "teamleaderleo", name: "stensibly" },
  };
}

function updateRefsBody(): unknown {
  return {
    query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    variables: {
      input: {
        repositoryId,
        refUpdates: [{
          name: `refs/heads/${targetRef}`,
          beforeOid: parentSha,
          afterOid: nextCommitSha,
          force: false,
        }],
        clientMutationId: `stensibly-write-${nextCommitSha.slice(0, 16)}`,
      },
    },
  };
}

function updateRefsResponse(): Response {
  return Response.json({
    data: {
      updateRefs: {
        clientMutationId: `stensibly-write-${nextCommitSha.slice(0, 16)}`,
      },
    },
  }, {
    status: 200,
    headers: { "x-github-request-id": "REQ-ATOMIC-PUBLISH" },
  });
}

function tokenProvider(
  calls: Array<"read" | "write">,
): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      calls.push(input.access);
      return {
        token: `contents-${input.access}-token`,
        expiresAt: "2026-08-03T12:00:00.000Z",
      };
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

function command(
  idempotencyKey: string,
  content: string,
): GitHubRepositoryWriteCommand {
  return {
    project: "stensibly",
    actorId: "actor_atomic_publication",
    clientId: "client_atomic_publication",
    idempotencyKey,
    intent: {
      version: 1,
      repositoryFullName,
      path,
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
    },
    payload: {
      operation: "create_file",
      content,
      message: "Race atomic file",
    },
  };
}

function monotonicClock(): () => string {
  let tick = 0;
  return () => new Date(
    Date.UTC(2026, 7, 4, 17, 0, tick++),
  ).toISOString();
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
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

function blobCollectionUrl(): string {
  return `${repositoryUrl()}/git/blobs`;
}

function blobUrl(sha: string): string {
  return `${blobCollectionUrl()}/${sha}`;
}

function treeCollectionUrl(): string {
  return `${repositoryUrl()}/git/trees`;
}

function treeUrl(sha: string): string {
  return `${treeCollectionUrl()}/${sha}`;
}

function recursiveTreeUrl(sha: string): string {
  return `${treeUrl(sha)}?recursive=1`;
}