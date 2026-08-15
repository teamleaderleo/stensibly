import { describe, expect, test } from "bun:test";
import type { GitHubInstallationTokenProvider } from "../src/github-app-installation-token.js";
import { githubOperationRedirectFetch } from "../src/github-operation-redirect-fetch.js";
import { GitHubRestOperationsAdapter } from "../src/github-rest-operations-adapter.js";

const sha = (digit: string) => digit.repeat(40);
const repository = "teamleaderleo/stensibly";
const apiBaseUrl = "https://api.github.test";

describe("GitHub branch tidy canonical pagination", () => {
  test("rebinds canonical numeric repository Link pages onto the accepted repository route", async () => {
    const requested: string[] = [];
    const adapter = new GitHubRestOperationsAdapter({
      tokenProvider: tokens(),
      apiBaseUrl,
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      fetch: githubOperationRedirectFetch((async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/repos/teamleaderleo/stensibly/branches?per_page=100&page=1")) {
          return json([
            { name: "main", commit: { sha: sha("a") }, protected: true },
          ], {
            link: '<https://api.github.test/repositories/1310091990/branches?per_page=100&page=2>; rel="next"',
          });
        }
        if (url.endsWith("/repos/teamleaderleo/stensibly/branches?per_page=100&page=2")) {
          return json([
            { name: "dogfood/merged", commit: { sha: sha("b") }, protected: false },
          ]);
        }
        if (url.endsWith("/repos/teamleaderleo/stensibly/pulls?state=open&per_page=100&page=1")) {
          return json([]);
        }
        if (url.endsWith(`/repos/teamleaderleo/stensibly/compare/${sha("a")}...${sha("b")}`)) {
          return json({ ahead_by: 0, behind_by: 2 });
        }
        if (url.endsWith(`/repos/teamleaderleo/stensibly/commits/${sha("b")}`)) {
          return json({ commit: { committer: { date: "2026-07-01T00:00:00Z" } } });
        }
        throw new Error(`unexpected request ${url}`);
      }) as typeof fetch),
    });

    const plan = await adapter.planBranchTidy({
      repositoryFullName: repository,
      defaultBranch: "main",
      defaultBranchSha: sha("a"),
      minimumAgeDays: 14,
      maximumBranches: 25,
    });

    expect(plan.eligibleCount).toBe(1);
    expect(requested).toContain(
      "https://api.github.test/repos/teamleaderleo/stensibly/branches?per_page=100&page=2",
    );
    expect(requested.some((url) => url.includes("/repositories/1310091990/"))).toBe(false);
  });

  test("leaves unsafe or unrelated Link drift for the strict pagination validator to reject", async () => {
    const links = [
      '<https://example.test/repositories/1310091990/branches?per_page=100&page=2>; rel="next"',
      '<https://token@api.github.test/repositories/1310091990/branches?per_page=100&page=2>; rel="next"',
      '<https://api.github.test/repositories/1310091990/branches?per_page=100&page=2#frag>; rel="next"',
      '<https://api.github.test/repositories/1310091990/issues?per_page=100&page=2>; rel="next"',
      '<https://api.github.test/repositories/1310091990/branches?per_page=50&page=2>; rel="next"',
      '<https://api.github.test/repositories/1310091990/branches?per_page=100&page=3>; rel="next"',
    ];

    for (const link of links) {
      const adapter = new GitHubRestOperationsAdapter({
        tokenProvider: tokens(),
        apiBaseUrl,
        fetch: githubOperationRedirectFetch((async (input) => {
          const url = String(input);
          if (url.endsWith("/repos/teamleaderleo/stensibly/branches?per_page=100&page=1")) {
            return json([], { link });
          }
          throw new Error(`unexpected request ${url}`);
        }) as typeof fetch),
      });

      await expect(adapter.planBranchTidy({
        repositoryFullName: repository,
        defaultBranch: "main",
        defaultBranchSha: sha("a"),
        minimumAgeDays: 14,
        maximumBranches: 25,
      })).rejects.toThrow(/GitHub operation pagination/);
    }
  });

  test("limits candidate provider reads to one compare-plus-commit pair", async () => {
    let activeCandidateReads = 0;
    let maximumCandidateReads = 0;
    const adapter = new GitHubRestOperationsAdapter({
      tokenProvider: tokens(),
      apiBaseUrl,
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      fetch: githubOperationRedirectFetch((async (input) => {
        const url = String(input);
        if (url.endsWith("/repos/teamleaderleo/stensibly/branches?per_page=100&page=1")) {
          return json([
            { name: "main", commit: { sha: sha("a") }, protected: true },
            { name: "dogfood/one", commit: { sha: sha("b") }, protected: false },
            { name: "dogfood/two", commit: { sha: sha("c") }, protected: false },
            { name: "dogfood/three", commit: { sha: sha("d") }, protected: false },
          ]);
        }
        if (url.endsWith("/repos/teamleaderleo/stensibly/pulls?state=open&per_page=100&page=1")) {
          return json([]);
        }
        if (url.includes("/compare/") || url.includes("/commits/")) {
          activeCandidateReads += 1;
          maximumCandidateReads = Math.max(maximumCandidateReads, activeCandidateReads);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeCandidateReads -= 1;
          return url.includes("/compare/")
            ? json({ ahead_by: 0, behind_by: 1 })
            : json({ commit: { committer: { date: "2026-07-01T00:00:00Z" } } });
        }
        throw new Error(`unexpected request ${url}`);
      }) as typeof fetch),
    });

    const plan = await adapter.planBranchTidy({
      repositoryFullName: repository,
      defaultBranch: "main",
      defaultBranchSha: sha("a"),
      minimumAgeDays: 14,
      maximumBranches: 3,
    });

    expect(plan.candidates).toHaveLength(3);
    expect(maximumCandidateReads).toBe(2);
  });
});

function tokens(): GitHubInstallationTokenProvider {
  return {
    async getInstallationToken() {
      return { token: "test-token", expiresAt: "2026-08-10T01:00:00.000Z" };
    },
  };
}

function json(value: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
