import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestPublicationWriteAdapter } from "../src/github-rest-publication-write-adapter.ts";

const repository = "teamleaderleo/stensibly";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

describe("GitHub REST publication write adapter", () => {
  test("uses exact contents and pull-request permissions with strict canonical readback", async () => {
    const permissions: GitHubInstallationTokenRequest[] = [];
    const calls: Array<{
      method: string;
      url: string;
      authorization: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : null;
      calls.push({
        method,
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      if (url.endsWith("/git/ref/heads/codex%2Fpublication")) {
        return Response.json(apiBranch("codex/publication", headSha));
      }
      if (url.endsWith("/git/refs") && method === "POST") {
        return Response.json(apiBranch("codex/publication", headSha), {
          status: 201,
          headers: { "x-github-request-id": "BRANCH:WRITE" },
        });
      }
      if (url.endsWith("/pulls/42")) {
        return Response.json(apiPullRequest());
      }
      if (url.endsWith("/pulls") && method === "POST") {
        return Response.json(apiPullRequest(), {
          status: 201,
          headers: { "x-github-request-id": "PR:WRITE" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };
    const adapter = new GitHubRestPublicationWriteAdapter({
      tokenProvider: {
        getInstallationToken: async (input) => {
          permissions.push(structuredClone(input));
          return {
            token: "installation-publication-token-secret",
            expiresAt: "2026-08-09T01:00:00.000Z",
          };
        },
      },
      fetch: fetcher as typeof fetch,
    });

    expect(await adapter.getBranch({
      repositoryFullName: repository,
      branch: "codex/publication",
    })).toMatchObject({
      kind: "branch",
      name: "codex/publication",
      commitSha: headSha,
    });
    expect(await adapter.createBranch({
      repositoryFullName: repository,
      branch: "codex/publication",
      fromCommitSha: headSha,
      idempotencyKey: "branch-1",
    })).toMatchObject({
      providerRequestId: "BRANCH:WRITE",
      branch: { commitSha: headSha },
    });
    expect(await adapter.getPullRequest({
      repositoryFullName: repository,
      pullRequestNumber: 42,
    })).toMatchObject({
      kind: "pull_request",
      number: 42,
      head: "codex/publication",
      headSha,
      base: "main",
      baseSha,
      containsBody: false,
    });
    expect(await adapter.createPullRequest({
      repositoryFullName: repository,
      title: "Guarded publication",
      body: "Bounded PR body",
      head: "codex/publication",
      base: "main",
      draft: true,
      idempotencyKey: "pr-1",
    })).toMatchObject({
      providerRequestId: "PR:WRITE",
      pullRequest: { number: 42, containsBody: false },
    });

    expect(permissions).toEqual([
      { repositoryFullName: repository, permission: { name: "contents", access: "read" } },
      { repositoryFullName: repository, permission: { name: "contents", access: "write" } },
      { repositoryFullName: repository, permission: { name: "pull_requests", access: "read" } },
      { repositoryFullName: repository, permission: { name: "pull_requests", access: "write" } },
    ]);
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer installation-publication-token-secret",
      "Bearer installation-publication-token-secret",
      "Bearer installation-publication-token-secret",
      "Bearer installation-publication-token-secret",
    ]);
    expect(calls[1]?.body).toEqual({
      ref: "refs/heads/codex/publication",
      sha: headSha,
    });
    expect(calls[3]?.body).toEqual({
      title: "Guarded publication",
      body: "Bounded PR body",
      head: "codex/publication",
      base: "main",
      draft: true,
    });
  });

  test("returns null only for an exact branch 404 and keeps mutation uncertainty ambiguous", async () => {
    const tokenProvider = {
      getInstallationToken: async () => ({
        token: "installation-publication-token-secret",
        expiresAt: "2026-08-09T01:00:00.000Z",
      }),
    };
    const missing = new GitHubRestPublicationWriteAdapter({
      tokenProvider,
      fetch: (async () =>
        Response.json({ message: "not found" }, { status: 404 })) as unknown as typeof fetch,
    });
    expect(await missing.getBranch({
      repositoryFullName: repository,
      branch: "codex/missing",
    })).toBeNull();

    const failed = new GitHubRestPublicationWriteAdapter({
      tokenProvider,
      fetch: (async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch,
    });
    await expect(failed.createBranch({
      repositoryFullName: repository,
      branch: "codex/ambiguous",
      fromCommitSha: headSha,
      idempotencyKey: "branch-ambiguous",
    })).rejects.toThrow("outcome is ambiguous");
  });

  test("cancels an undeclared response as soon as it crosses 512 KiB", async () => {
    let produced = 0;
    let cancelled = false;
    const oversized = new GitHubRestPublicationWriteAdapter({
      tokenProvider: {
        getInstallationToken: async () => ({
          token: "installation-publication-token-secret",
          expiresAt: "2026-08-09T01:00:00.000Z",
        }),
      },
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          produced += 1;
          controller.enqueue(new Uint8Array(128 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200 })) as unknown as typeof fetch,
    });

    await expect(oversized.getBranch({
      repositoryFullName: repository,
      branch: "codex/oversized",
    })).rejects.toThrow("exceeded the byte limit");
    expect(produced).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
  });
});

function apiBranch(branch: string, sha: string) {
  return {
    ref: `refs/heads/${branch}`,
    object: {
      type: "commit",
      sha,
      url: `https://api.github.com/repos/${repository}/git/commits/${sha}`,
    },
  };
}

function apiPullRequest() {
  return {
    number: 42,
    node_id: "PR_kwDO_publication",
    title: "Guarded publication",
    body: "Bounded PR body",
    state: "open",
    draft: true,
    head: {
      ref: "codex/publication",
      sha: headSha,
      repo: { full_name: repository },
    },
    base: {
      ref: "main",
      sha: baseSha,
      repo: { full_name: repository },
    },
    created_at: "2026-08-09T00:00:00Z",
    updated_at: "2026-08-09T00:00:00Z",
  };
}
