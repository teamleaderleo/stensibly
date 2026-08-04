import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubRepositoryWriteProviderService,
  type GitHubRepositoryWriteAuthorityProvider,
  type GitHubRepositoryWriteCommand,
} from "../src/github-repository-write-provider-service.ts";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";
import { SqliteGitHubRepositoryWriteStore } from "../src/github-repository-write-store.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "feature/repository-write";
const parentSha = "a".repeat(40);
const commitSha = "b".repeat(40);
const contentSha = "c".repeat(40);
const apiBaseUrl = "https://api.github.test";

type CapturedCall = {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
};

function tokenProvider(calls: Array<{ access: "read" | "write"; repository: string }>): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken(input) {
      calls.push({
        access: input.access,
        repository: input.repositoryFullName,
      });
      return {
        token: `contents-${input.access}-token-secret`,
        expiresAt: "2026-08-03T11:00:00.000Z",
      };
    },
  };
}

function responseJson(
  value: unknown,
  input: { status?: number; requestId?: string } = {},
): Response {
  return Response.json(value, {
    status: input.status ?? 200,
    headers: input.requestId
      ? { "x-github-request-id": input.requestId }
      : undefined,
  });
}

function refPayload(sha: string) {
  return {
    ref: `refs/heads/${targetRef}`,
    object: {
      type: "commit",
      sha,
      url: `${apiBaseUrl}/repos/${repositoryFullName}/git/commits/${sha}`,
    },
  };
}

function commitPayload(sha: string, parents: string[]) {
  return {
    sha,
    url: `${apiBaseUrl}/repos/${repositoryFullName}/git/commits/${sha}`,
    parents: parents.map((parent) => ({ sha: parent })),
  };
}

function writePayload(input: {
  sha?: string;
  content?: unknown;
} = {}) {
  return {
    content: input.content ?? null,
    commit: commitPayload(input.sha ?? commitSha, [parentSha]),
  };
}

function writeContent(path: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  const blobSha = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return {
    name: path.split("/").at(-1),
    path,
    sha: blobSha,
    size: bytes.byteLength,
    url: `${apiBaseUrl}/repos/${repositoryFullName}/contents/${encodedPath}`,
    git_url: `${apiBaseUrl}/repos/${repositoryFullName}/git/blobs/${blobSha}`,
    type: "file",
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
        authorityId: "grant_repository_write_transport",
        authorityGeneration: 1,
        defaultBranchApprovalId: null,
      };
    },
  };
}

function command(): GitHubRepositoryWriteCommand {
  return {
    project: "stensibly",
    actorId: "actor_repository_transport",
    clientId: "mcp_repository_transport",
    idempotencyKey: "repository-transport-create-1",
    intent: {
      version: 1,
      repositoryFullName,
      path: "docs/provider write.json",
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
    },
    payload: {
      operation: "create_file",
      content: "{\"verified\":true}\n",
      message: "Record verified provider write",
    },
  };
}

describe("native GitHub repository file write adapter", () => {
  test("executes one durable create through exact head and parent verification", async () => {
    const calls: CapturedCall[] = [];
    const tokens: Array<{ access: "read" | "write"; repository: string }> = [];
    let head = parentSha;
    let mutationCalls = 0;
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      if (method === "GET" && url.endsWith(`/git/ref/heads/${targetRef}`)) {
        return responseJson(refPayload(head));
      }
      if (
        method === "PUT"
        && url.endsWith("/contents/docs/provider%20write.json")
      ) {
        mutationCalls += 1;
        expect(body).toEqual({
          message: "Record verified provider write",
          content: Buffer.from("{\"verified\":true}\n", "utf8").toString("base64"),
          branch: targetRef,
        });
        head = commitSha;
        return responseJson(writePayload({
          content: writeContent(
            "docs/provider write.json",
            "{\"verified\":true}\n",
          ),
        }), {
          status: 201,
          requestId: "REQ-REPOSITORY-CREATE",
        });
      }
      if (method === "GET" && url.endsWith(`/git/commits/${commitSha}`)) {
        return responseJson(commitPayload(commitSha, [parentSha]));
      }
      return responseJson({ message: "unexpected request" }, { status: 500 });
    };
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(tokens),
      apiBaseUrl,
      fetch: fetcher as unknown as typeof fetch,
    });
    const store = new SqliteGitHubRepositoryWriteStore({ path: ":memory:" });
    let tick = 0;
    const service = new GitHubRepositoryWriteProviderService({
      authority: authorityProvider(),
      adapter,
      store,
      now: () => new Date(Date.UTC(2026, 7, 3, 10, 0, tick++)).toISOString(),
      idFactory: () => "ghrw_native_transport",
    });

    const first = await service.execute(command());
    expect(first).toMatchObject({
      state: "succeeded",
      dispatchCount: 1,
      verified: {
        commitSha,
        nextExpectedParentSha: commitSha,
        providerRequestId: "REQ-REPOSITORY-CREATE",
      },
    });
    expect(mutationCalls).toBe(1);
    expect(tokens).toEqual([
      { access: "read", repository: repositoryFullName },
      { access: "write", repository: repositoryFullName },
      { access: "read", repository: repositoryFullName },
      { access: "read", repository: repositoryFullName },
    ]);
    expect(calls.every((call) =>
      call.authorization === "Bearer contents-read-token-secret"
      || call.authorization === "Bearer contents-write-token-secret"
    )).toBe(true);

    const replay = await service.execute(command());
    expect(replay).toEqual(first);
    expect(mutationCalls).toBe(1);
    expect(tokens).toHaveLength(4);

    const retained = JSON.stringify({ first, calls: calls.map((call) => ({
      url: call.url,
      method: call.method,
      body: call.body,
    })) });
    expect(retained).not.toContain("contents-read-token-secret");
    expect(retained).not.toContain("contents-write-token-secret");
    store.close();
  });

  test("uses exact update and delete payloads on the accepted branch", async () => {
    const calls: CapturedCall[] = [];
    const tokens: Array<{ access: "read" | "write"; repository: string }> = [];
    const responses = [
      responseJson(writePayload({
        content: writeContent(
          "src/example.ts",
          "export const ready = true;\n",
        ),
      }), { requestId: "REQ-UPDATE-FILE" }),
      responseJson(writePayload(), { requestId: "REQ-DELETE-FILE" }),
    ];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(tokens),
      apiBaseUrl,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return responses.shift()!;
      }) as unknown as typeof fetch,
    });

    const updated = await adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path: "src/example.ts",
      operation: "update_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "update_file",
        content: "export const ready = true;\n",
        contentSha,
        message: "Update repository file",
      },
      idempotencyKey: "repository-update-1",
    });
    const deleted = await adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path: "src/example.ts",
      operation: "delete_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "delete_file",
        contentSha,
        message: "Delete repository file",
      },
      idempotencyKey: "repository-delete-1",
    });

    expect(updated).toMatchObject({
      commitSha,
      parentSha,
      targetRef,
      providerRequestId: "REQ-UPDATE-FILE",
    });
    expect(deleted).toMatchObject({
      commitSha,
      parentSha,
      targetRef,
      providerRequestId: "REQ-DELETE-FILE",
    });
    expect(calls).toEqual([
      {
        url: `${apiBaseUrl}/repos/${repositoryFullName}/contents/src/example.ts`,
        method: "PUT",
        authorization: "Bearer contents-write-token-secret",
        body: {
          message: "Update repository file",
          content: Buffer.from("export const ready = true;\n", "utf8").toString("base64"),
          sha: contentSha,
          branch: targetRef,
        },
      },
      {
        url: `${apiBaseUrl}/repos/${repositoryFullName}/contents/src/example.ts`,
        method: "DELETE",
        authorization: "Bearer contents-write-token-secret",
        body: {
          message: "Delete repository file",
          sha: contentSha,
          branch: targetRef,
        },
      },
    ]);
    expect(tokens).toEqual([
      { access: "write", repository: repositoryFullName },
      { access: "write", repository: repositoryFullName },
    ]);
  });

  test("returns null for an absent ref and validates commit parent identity", async () => {
    const tokens: Array<{ access: "read" | "write"; repository: string }> = [];
    let cancelled = false;
    const responses = [
      {
        ok: false,
        status: 404,
        headers: new Headers(),
        body: {
          cancel() {
            cancelled = true;
          },
        },
      } as unknown as Response,
      responseJson(commitPayload(commitSha, [parentSha])),
    ];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider(tokens),
      apiBaseUrl,
      fetch: (async () => responses.shift()!) as unknown as typeof fetch,
    });

    expect(await adapter.getRefHead({ repositoryFullName, targetRef })).toBeNull();
    expect(cancelled).toBe(true);
    expect(await adapter.getCommitParents({
      repositoryFullName,
      commitSha,
    })).toEqual([parentSha]);
    expect(tokens).toEqual([
      { access: "read", repository: repositoryFullName },
      { access: "read", repository: repositoryFullName },
    ]);
  });

  test("drops hostile request IDs and never echoes provider prose or tokens", async () => {
    const installationToken = "contents-write-private-token";
    let cancelled = false;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: {
        async getRepositoryContentsToken() {
          return {
            token: installationToken,
            expiresAt: "2026-08-03T11:00:00.000Z",
          };
        },
      },
      apiBaseUrl,
      fetch: (async () => responseJson(writePayload({
        content: writeContent("docs/safe.md", "safe\n"),
      }), {
        status: 201,
        requestId: `github_pat_${"a".repeat(24)}`,
      })) as unknown as typeof fetch,
    });
    const result = await adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path: "docs/safe.md",
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "create_file",
        content: "safe\n",
        message: "Safe write",
      },
      idempotencyKey: "hostile-request-id",
    });
    expect(result).not.toHaveProperty("providerRequestId");
    expect(JSON.stringify(result)).not.toContain("github_pat_");

    const failing = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: {
        async getRepositoryContentsToken() {
          return {
            token: installationToken,
            expiresAt: "2026-08-03T11:00:00.000Z",
          };
        },
      },
      apiBaseUrl,
      fetch: (async () => ({
        ok: false,
        status: 503,
        headers: new Headers(),
        body: {
          cancel() {
            cancelled = true;
          },
        },
      } as unknown as Response)) as unknown as typeof fetch,
    });
    const action = failing.dispatchRepositoryWrite({
      repositoryFullName,
      path: "docs/safe.md",
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "create_file",
        content: "safe\n",
        message: "Safe write",
      },
      idempotencyKey: "fixed-error",
    });
    await expect(action).rejects.toThrow(
      "GitHub could not create repository file (HTTP 503)",
    );
    try {
      await action;
    } catch (error) {
      expect((error as Error).message).not.toContain(installationToken);
      expect((error as Error).message).not.toContain("provider prose");
    }
    expect(cancelled).toBe(true);
  });

  test("cancels oversized successful responses before retaining body bytes", async () => {
    let cancelled = false;
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: tokenProvider([]),
      apiBaseUrl,
      fetch: (async () => ({
        ok: true,
        status: 201,
        headers: new Headers({
          "content-length": String(512 * 1024 + 1),
          "x-github-request-id": "REQ-OVERSIZED-WRITE",
        }),
        body: {
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        },
      } as unknown as Response)) as unknown as typeof fetch,
    });

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path: "docs/oversized.md",
      operation: "create_file",
      targetRef,
      expectedParentSha: parentSha,
      payload: {
        operation: "create_file",
        content: "safe\n",
        message: "Bound response",
      },
      idempotencyKey: "oversized-response",
    })).rejects.toThrow(
      "GitHub create repository file response exceeded its byte limit",
    );
    expect(cancelled).toBe(true);
  });
});
