import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const sha40 = "a".repeat(40);
const parent64 = "b".repeat(64);
const commit64 = "c".repeat(64);

describe("GitHub repository-write adapter fence parity", () => {
  test("rejects non-canonical repository aliases before token access", async () => {
    const cases = [
      "TeamLeaderLeo/Stensibly",
      "git@github.com:teamleaderleo/stensibly.git",
      " https://github.com/teamleaderleo/stensibly ",
    ];

    for (const repository of cases) {
      const observed = adapterThatMustNotReachProvider();
      await expect(observed.adapter.getRefHead({
        repositoryFullName: repository,
        targetRef: "main",
      })).rejects.toThrow("GitHub repository identity is invalid");
      expect(observed.tokenCalls()).toBe(0);
      expect(observed.fetchCalls()).toBe(0);
    }
  });

  test("rejects every branch alias forbidden by the durable fence before token access", async () => {
    const cases = [
      "HEAD",
      "refs/heads/main",
      "-topic",
      ".hidden/main",
      "topic.lock",
    ];

    for (const targetRef of cases) {
      const observed = adapterThatMustNotReachProvider();
      await expect(observed.adapter.getRefHead({
        repositoryFullName,
        targetRef,
      })).rejects.toThrow("GitHub target branch is invalid");
      expect(observed.tokenCalls()).toBe(0);
      expect(observed.fetchCalls()).toBe(0);
    }
  });

  test("rejects non-ASCII, control, and credential-shaped paths before token access", async () => {
    const cases = [
      "docs/café.md",
      "docs/line\nbreak.md",
      `docs/repositoryxgithub_pat_${"a".repeat(20)}.md`,
    ];

    for (const path of cases) {
      const observed = adapterThatMustNotReachProvider();
      await expect(observed.adapter.dispatchRepositoryWrite({
        repositoryFullName,
        path,
        operation: "create_file",
        targetRef: "topic/review",
        expectedParentSha: sha40,
        payload: {
          operation: "create_file",
          content: "bounded content",
          message: "Create bounded file",
        },
        idempotencyKey: "fence-path-parity",
      })).rejects.toThrow("GitHub repository path is invalid");
      expect(observed.tokenCalls()).toBe(0);
      expect(observed.fetchCalls()).toBe(0);
    }
  });

  test("admits exact 64-hex commit identities for canonical reads and writes", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const adapter = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: {
        async getRepositoryContentsToken() {
          return {
            token: "installation-token",
            expiresAt: "2026-08-03T12:00:00.000Z",
          };
        },
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        requests.push({ method, url });
        if (method === "GET" && url.endsWith(`/git/commits/${commit64}`)) {
          return Response.json({
            sha: commit64,
            parents: [{ sha: parent64 }],
          });
        }
        if (method === "PUT" && url.endsWith("/contents/docs/review.md")) {
          return Response.json({
            content: {
              path: "docs/review.md",
              type: "file",
            },
            commit: {
              sha: commit64,
              parents: [{ sha: parent64 }],
            },
          }, {
            headers: { "x-github-request-id": "REQ-SHA256-WRITE" },
          });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as typeof fetch,
    });

    await expect(adapter.getCommitParents({
      repositoryFullName,
      commitSha: commit64,
    })).resolves.toEqual([parent64]);

    await expect(adapter.dispatchRepositoryWrite({
      repositoryFullName,
      path: "docs/review.md",
      operation: "create_file",
      targetRef: "topic/review",
      expectedParentSha: parent64,
      payload: {
        operation: "create_file",
        content: "bounded content",
        message: "Create bounded file",
      },
      idempotencyKey: "sha256-write-parity",
    })).resolves.toEqual({
      commitSha: commit64,
      providerRequestId: "REQ-SHA256-WRITE",
      targetRef: "topic/review",
      parentSha: parent64,
    });

    expect(requests).toEqual([
      {
        method: "GET",
        url: `https://api.github.com/repos/teamleaderleo/stensibly/git/commits/${commit64}`,
      },
      {
        method: "PUT",
        url: "https://api.github.com/repos/teamleaderleo/stensibly/contents/docs/review.md",
      },
    ]);
  });
});

function adapterThatMustNotReachProvider() {
  let tokens = 0;
  let fetches = 0;
  const adapter = new GitHubRestRepositoryWriteAdapter({
    tokenProvider: {
      async getRepositoryContentsToken() {
        tokens += 1;
        return {
          token: "must-not-mint",
          expiresAt: "2026-08-03T12:00:00.000Z",
        };
      },
    },
    fetch: (async () => {
      fetches += 1;
      return Response.json({ message: "must not fetch" }, { status: 500 });
    }) as typeof fetch,
  });
  return {
    adapter,
    tokenCalls: () => tokens,
    fetchCalls: () => fetches,
  };
}
