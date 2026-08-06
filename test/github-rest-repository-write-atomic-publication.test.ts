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
const targetRef = "topic/atomic-publication";
const path = "docs/atomic-publication.md";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const previousBlobSha = "3".repeat(40);
const nextBlobSha = "4".repeat(40);
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
  test("constructs one direct-child commit and publishes it with force false", async () => {
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
        url: `${contentUrl()}?ref=${parentSha}`,
        body: null,
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
        method: "PATCH",
        url: updateRefUrl(),
        body: {
          sha: nextCommitSha,
          force: false,
        },
        authorization: "Bearer contents-write-token",
      },
    ]);
    expect(tokenCalls).toEqual([
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
        sha: nextBlobSha,
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
  ])("binds $operation to the immutable parent file identity", async ({
    operation,
    payload,
    expectedTreeEntry,
    expectsBlobWrite,
  }) => {
    const recorded: RecordedRequest[] = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: atomicFetcher({
        recorded,
        operation,
        payload,
      }),
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

    const preflight = recorded.find((request) =>
      request.method === "GET" && request.url.startsWith(contentUrl())
    );
    expect(preflight?.url).toBe(`${contentUrl()}?ref=${parentSha}`);
    const blobWrites = recorded.filter((request) =>
      request.method === "POST" && request.url === blobCollectionUrl()
    );
    expect(blobWrites).toHaveLength(expectsBlobWrite ? 1 : 0);
    const treeWrite = recorded.find((request) =>
      request.method === "POST" && request.url === treeCollectionUrl()
    );
    expect(treeWrite?.body).toEqual({
      base_tree: parentTreeSha,
      tree: [expectedTreeEntry],
    });
    expect(recorded.at(-1)).toMatchObject({
      method: "PATCH",
      url: updateRefUrl(),
      body: { sha: nextCommitSha, force: false },
    });
  });

  test("keeps the lane for reconciliation when a concurrent ref move rejects publication", async () => {
    const recorded: RecordedRequest[] = [];
    let publicationCalls = 0;
    const fetcher = atomicFetcher({
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
          message: "Reference update failed",
          documentation_url: "https://docs.github.test/rest/git/refs",
        }, { status: 422 });
      },
      includeServiceHeadRead: true,
    });
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: fetcher,
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
    expect(recorded.filter((request) => request.method === "PATCH")).toEqual([
      expect.objectContaining({
        url: updateRefUrl(),
        body: { sha: nextCommitSha, force: false },
      }),
    ]);
    store.close();
  });

  test("rejects update and delete before publication when the parent blob changed", async () => {
    for (const operation of ["update_file", "delete_file"] as const) {
      let publicationCalls = 0;
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
          recorded: [],
          operation,
          payload,
          observedBlobSha: "9".repeat(40),
          publicationResponse() {
            publicationCalls += 1;
            return refResponse();
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
          url: `${treeCollectionUrl()}/${parentTreeSha}`,
        },
        parents: [],
        url: commitUrl(parentSha),
      });
    }
    if (method === "GET" && url === `${contentUrl()}?ref=${parentSha}`) {
      if (input.operation === "create_file") {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({
        type: "file",
        name: "atomic-publication.md",
        path,
        sha: input.observedBlobSha ?? previousBlobSha,
        size: 12,
        url: `${contentUrl()}?ref=${parentSha}`,
        git_url:
          `${apiBaseUrl}/repos/${repositoryFullName}/git/blobs/${input.observedBlobSha ?? previousBlobSha}`,
      });
    }
    if (method === "POST" && url === blobCollectionUrl()) {
      return Response.json({
        sha: nextBlobSha,
        url: `${blobCollectionUrl()}/${nextBlobSha}`,
      }, { status: 201 });
    }
    if (method === "POST" && url === treeCollectionUrl()) {
      return Response.json({
        sha: nextTreeSha,
        url: `${treeCollectionUrl()}/${nextTreeSha}`,
        tree: [],
        truncated: false,
      }, { status: 201 });
    }
    if (method === "POST" && url === commitCollectionUrl()) {
      return Response.json({
        sha: nextCommitSha,
        tree: {
          sha: nextTreeSha,
          url: `${treeCollectionUrl()}/${nextTreeSha}`,
        },
        parents: [{ sha: parentSha, url: commitUrl(parentSha) }],
        url: commitUrl(nextCommitSha),
      }, { status: 201 });
    }
    if (method === "PATCH" && url === updateRefUrl()) {
      return input.publicationResponse?.() ?? refResponse();
    }
    return Response.json({ message: "unexpected atomic request" }, {
      status: 500,
    });
  }) as unknown as typeof fetch;
}

function refResponse(): Response {
  return Response.json({
    ref: `refs/heads/${targetRef}`,
    object: {
      type: "commit",
      sha: nextCommitSha,
      url: commitUrl(nextCommitSha),
    },
  }, {
    status: 200,
    headers: { "x-github-request-id": "REQ-ATOMIC-PUBLISH" },
  });
}

function tokenProvider(calls: Array<"read" | "write">): GitHubRepositoryWriteTokenProvider {
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

function repositoryUrl(): string {
  return `${apiBaseUrl}/repos/${repositoryFullName}`;
}

function readRefUrl(): string {
  return `${repositoryUrl()}/git/ref/heads/${targetRef}`;
}

function updateRefUrl(): string {
  return `${repositoryUrl()}/git/refs/heads/${targetRef}`;
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

function treeCollectionUrl(): string {
  return `${repositoryUrl()}/git/trees`;
}

function contentUrl(): string {
  return `${repositoryUrl()}/contents/${path}`;
}
