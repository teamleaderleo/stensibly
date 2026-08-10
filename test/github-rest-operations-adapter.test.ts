import { describe, expect, test } from "bun:test";
import type { GitHubInstallationTokenProvider } from "../src/github-app-installation-token.js";
import { GitHubRestOperationsAdapter } from "../src/github-rest-operations-adapter.js";

const sha = (digit: string) => digit.repeat(40);

describe("GitHub REST operations adapter", () => {
  test("builds a plan from immutable comparison SHAs and retains recovery identity", async () => {
    const requested: string[] = [];
    const adapter = new GitHubRestOperationsAdapter({
      tokenProvider: tokens(),
      apiBaseUrl: "https://api.github.test",
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      fetch: (async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/branches?per_page=100&page=1")) return json([
          { name: "main", commit: { sha: sha("a") }, protected: true },
          { name: "dogfood/merged", commit: { sha: sha("b") }, protected: false },
        ]);
        if (url.endsWith("/pulls?state=open&per_page=100&page=1")) return json([]);
        if (url.endsWith(`/compare/${sha("a")}...${sha("b")}`)) {
          return json({ ahead_by: 0, behind_by: 2 });
        }
        if (url.endsWith(`/commits/${sha("b")}`)) {
          return json({ commit: { committer: { date: "2026-07-01T00:00:00Z" } } });
        }
        throw new Error(`unexpected request ${url}`);
      }) as typeof fetch,
    });
    const plan = await adapter.planBranchTidy({
      repositoryFullName: "teamleaderleo/stensibly",
      defaultBranch: "main",
      defaultBranchSha: sha("a"),
      minimumAgeDays: 14,
      maximumBranches: 25,
    });
    expect(plan.eligibleCount).toBe(1);
    expect(plan.candidates[0]).toMatchObject({
      branch: "dogfood/merged",
      expectedSha: sha("b"),
      eligible: true,
      recovery: { commitSha: sha("b") },
    });
    expect(requested.some((url) => url.includes("compare/main"))).toBe(false);
    expect(requested).toContain(
      `https://api.github.test/repos/teamleaderleo/stensibly/compare/${sha("a")}...${sha("b")}`,
    );
  });

  test("sends the exact expected head SHA when merging and admits only a bound readback", async () => {
    const bodies: string[] = [];
    const adapter = new GitHubRestOperationsAdapter({
      tokenProvider: tokens(),
      apiBaseUrl: "https://api.github.test",
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/42/merge")) {
          bodies.push(String(init?.body));
          return json({ merged: true, sha: sha("c"), message: "merged" }, {
            "x-github-request-id": "REQ-42",
          });
        }
        if (url.endsWith("/pulls/42")) return json({
          number: 42,
          state: "closed",
          draft: false,
          merged: true,
          head: { ref: "codex/change", sha: sha("b") },
          base: {
            ref: "main", sha: sha("a"),
            repo: { full_name: "teamleaderleo/stensibly" },
          },
          mergeable: null,
          mergeable_state: "unknown",
          merge_commit_sha: sha("c"),
        });
        if (url.endsWith(`/git/commits/${sha("c")}`)) return json({
          sha: sha("c"), parents: [{ sha: sha("a") }],
        });
        throw new Error(`unexpected request ${url}`);
      }) as typeof fetch,
    });
    const merged = await adapter.mergePullRequest({
      repositoryFullName: "teamleaderleo/stensibly",
      number: 42,
      expectedHeadSha: sha("b"),
      method: "squash",
    });
    expect(merged).toEqual({ mergeCommitSha: sha("c"), providerRequestId: "REQ-42" });
    expect(JSON.parse(bodies[0]!)).toEqual({ sha: sha("b"), merge_method: "squash" });
    expect(await adapter.inspectPullRequest("teamleaderleo/stensibly", 42)).toMatchObject({
      number: 42, merged: true, headSha: sha("b"), baseSha: sha("a"), mergeCommitSha: sha("c"),
    });
    expect(await adapter.readMergeCommit("teamleaderleo/stensibly", sha("c"))).toEqual({
      commitSha: sha("c"), parentShas: [sha("a")],
    });
  });

  test("cancels oversized bodies before buffering and rejects pagination endpoint drift", async () => {
    let cancelled = false;
    const oversized = new GitHubRestOperationsAdapter({
      tokenProvider: tokens(),
      apiBaseUrl: "https://api.github.test",
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array([123])); },
        cancel() { cancelled = true; },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "600000" },
      })) as unknown as typeof fetch,
    });
    await expect(oversized.readBranchHead("teamleaderleo/stensibly", "main"))
      .rejects.toThrow("exceeded its byte bound");
    expect(cancelled).toBe(true);

    const drifted = new GitHubRestOperationsAdapter({
      tokenProvider: tokens(),
      apiBaseUrl: "https://api.github.test",
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith("/branches?per_page=100&page=1")) {
          return json([], {
            link: '<https://api.github.test/repos/teamleaderleo/other/branches?per_page=100&page=2>; rel="next"',
          });
        }
        throw new Error(`unexpected request ${url}`);
      }) as typeof fetch,
    });
    await expect(drifted.planBranchTidy({
      repositoryFullName: "teamleaderleo/stensibly",
      defaultBranch: "main",
      defaultBranchSha: sha("a"),
      minimumAgeDays: 14,
      maximumBranches: 25,
    })).rejects.toThrow("changed the accepted request");
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
