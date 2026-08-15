import { describe, expect, test } from "bun:test";
import type { GitHubInstallationTokenRequest } from "../src/github-app-installation-token.ts";
import { GitHubPullRequestCompensationProviderRejectedError } from "../src/github-pull-request-compensation-contracts.ts";
import { GitHubRestPullRequestCompensationAdapter } from "../src/github-rest-pull-request-compensation-adapter.ts";

const repository = "teamleaderleo/stensibly";
const headSha = "b".repeat(40);
const baseSha = "a".repeat(40);

describe("GitHub REST pull-request compensation adapter", () => {
  test("reads and closes one exact PR with pull-request-only permissions", async () => {
    const permissions: GitHubInstallationTokenRequest[] = [];
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    let state: "open" | "closed" = "open";
    const adapter = new GitHubRestPullRequestCompensationAdapter({
      tokenProvider: {
        getInstallationToken: async (input) => {
          permissions.push(structuredClone(input));
          return {
            token: "installation-pr-close-token-secret",
            expiresAt: "2026-08-16T00:00:00.000Z",
          };
        },
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({
          method,
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (method === "PATCH") state = "closed";
        return Response.json(apiPullRequest(state), {
          headers: method === "PATCH" ? { "x-github-request-id": "PR:CLOSE:42" } : {},
        });
      }) as typeof fetch,
    });

    expect(await adapter.getPullRequestForCompensation({
      repositoryFullName: repository,
      pullRequestNumber: 42,
    })).toMatchObject({
      number: 42,
      providerNodeId: "PR_kwDO_close_fixture",
      state: "open",
      head: "sol/pr-close-fixture",
      headSha,
      base: "main",
      baseSha,
      containsBody: false,
    });
    expect(await adapter.closePullRequest({
      repositoryFullName: repository,
      pullRequestNumber: 42,
      idempotencyKey: "close:42:exact",
    })).toMatchObject({
      providerRequestId: "PR:CLOSE:42",
      pullRequest: { number: 42, state: "closed", containsBody: false },
    });
    expect(calls).toEqual([
      {
        method: "GET",
        url: "https://api.github.com/repos/teamleaderleo/stensibly/pulls/42",
        body: null,
      },
      {
        method: "PATCH",
        url: "https://api.github.com/repos/teamleaderleo/stensibly/pulls/42",
        body: { state: "closed" },
      },
    ]);
    expect(permissions).toEqual([
      { repositoryFullName: repository, permission: { name: "pull_requests", access: "read" } },
      { repositoryFullName: repository, permission: { name: "pull_requests", access: "write" } },
    ]);
  });

  test("keeps close transport and retryable provider failures ambiguous", async () => {
    const tokenProvider = {
      getInstallationToken: async () => ({
        token: "installation-pr-close-token-secret",
        expiresAt: "2026-08-16T00:00:00.000Z",
      }),
    };
    const transport = new GitHubRestPullRequestCompensationAdapter({
      tokenProvider,
      fetch: (async () => {
        throw new Error("connection reset");
      }) as typeof fetch,
    });
    await expect(transport.closePullRequest({
      repositoryFullName: repository,
      pullRequestNumber: 42,
      idempotencyKey: "close:transport",
    })).rejects.toThrow("outcome is ambiguous");

    const unavailable = new GitHubRestPullRequestCompensationAdapter({
      tokenProvider,
      fetch: (async () => Response.json({ message: "retry later" }, { status: 503 })) as typeof fetch,
    });
    await expect(unavailable.closePullRequest({
      repositoryFullName: repository,
      pullRequestNumber: 42,
      idempotencyKey: "close:503",
    })).rejects.toThrow("outcome is ambiguous");
  });

  test("classifies definite close rejection separately from ambiguous mutation outcomes", async () => {
    const adapter = new GitHubRestPullRequestCompensationAdapter({
      tokenProvider: {
        getInstallationToken: async () => ({
          token: "installation-pr-close-token-secret",
          expiresAt: "2026-08-16T00:00:00.000Z",
        }),
      },
      fetch: (async () => Response.json({ message: "forbidden" }, { status: 403 })) as typeof fetch,
    });
    await expect(adapter.closePullRequest({
      repositoryFullName: repository,
      pullRequestNumber: 42,
      idempotencyKey: "close:forbidden",
    })).rejects.toBeInstanceOf(GitHubPullRequestCompensationProviderRejectedError);
  });

  test("rejects changed repository identity and oversized provider responses", async () => {
    const tokenProvider = {
      getInstallationToken: async () => ({
        token: "installation-pr-close-token-secret",
        expiresAt: "2026-08-16T00:00:00.000Z",
      }),
    };
    const drift = new GitHubRestPullRequestCompensationAdapter({
      tokenProvider,
      fetch: (async () => Response.json({
        ...apiPullRequest("open"),
        head: {
          ...apiPullRequest("open").head,
          repo: { full_name: "teamleaderleo/other" },
        },
      })) as typeof fetch,
    });
    await expect(drift.getPullRequestForCompensation({
      repositoryFullName: repository,
      pullRequestNumber: 42,
    })).rejects.toThrow("outside the bound repository");

    let cancelled = false;
    const oversized = new GitHubRestPullRequestCompensationAdapter({
      tokenProvider,
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(128 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200 })) as typeof fetch,
    });
    await expect(oversized.getPullRequestForCompensation({
      repositoryFullName: repository,
      pullRequestNumber: 42,
    })).rejects.toThrow("exceeded the byte limit");
    expect(cancelled).toBe(true);
  });
});

function apiPullRequest(state: "open" | "closed") {
  return {
    number: 42,
    node_id: "PR_kwDO_close_fixture",
    title: "PR close fixture",
    body: "Exact retained body",
    state,
    draft: true,
    head: {
      ref: "sol/pr-close-fixture",
      sha: headSha,
      repo: { full_name: repository },
    },
    base: {
      ref: "main",
      sha: baseSha,
      repo: { full_name: repository },
    },
    created_at: "2026-08-15T08:00:05Z",
    updated_at: state === "closed"
      ? "2026-08-15T08:10:00Z"
      : "2026-08-15T08:00:06Z",
  };
}
