import { expect, test } from "bun:test";
import type { GitHubInstallationTokenProvider } from "../src/github-app-installation-token.js";
import { GitHubRestOperationsAdapter } from "../src/github-rest-operations-adapter.js";

const sha = (digit: string) => digit.repeat(40);
const repository = "teamleaderleo/stensibly";

function tokens(): GitHubInstallationTokenProvider {
  return {
    async getInstallationToken() {
      return { token: "test-token", expiresAt: "2026-08-10T02:00:00.000Z" };
    },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("branch tidy candidate order uses literal code-unit ordering", async () => {
  const branchShas = new Map([
    ["Z-branch", sha("b")],
    ["a-branch", sha("c")],
  ]);
  const adapter = new GitHubRestOperationsAdapter({
    tokenProvider: tokens(),
    apiBaseUrl: "https://api.github.test",
    now: () => Date.parse("2026-08-10T01:00:00.000Z"),
    fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith("/branches?per_page=100&page=1")) return json([
        { name: "main", commit: { sha: sha("a") }, protected: true },
        { name: "a-branch", commit: { sha: sha("c") }, protected: false },
        { name: "Z-branch", commit: { sha: sha("b") }, protected: false },
      ]);
      if (url.endsWith("/pulls?state=open&per_page=100&page=1")) return json([]);
      for (const [, branchSha] of branchShas) {
        if (url.endsWith(`/compare/${sha("a")}...${branchSha}`)) {
          return json({ ahead_by: 0, behind_by: 1 });
        }
        if (url.endsWith(`/commits/${branchSha}`)) {
          return json({ commit: { committer: { date: "2026-07-01T00:00:00Z" } } });
        }
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch,
  });

  const plan = await adapter.planBranchTidy({
    repositoryFullName: repository,
    defaultBranch: "main",
    defaultBranchSha: sha("a"),
    minimumAgeDays: 14,
    maximumBranches: 25,
  });

  expect(plan.candidates.map((candidate) => candidate.branch)).toEqual([
    "Z-branch",
    "a-branch",
  ]);
});

test("operation response-stream rejection keeps arbitrary caught value opaque", async () => {
  let prototypeReads = 0;
  const hostile = new Proxy(Object.create(null), {
    getPrototypeOf() {
      prototypeReads += 1;
      throw new Error("provider stream rejection prototype must remain opaque");
    },
  });
  const adapter = new GitHubRestOperationsAdapter({
    tokenProvider: tokens(),
    apiBaseUrl: "https://api.github.test",
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(hostile);
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  });

  let captured: unknown;
  try {
    await adapter.readBranchHead(repository, "main");
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(Error);
  expect(captured).toMatchObject({ message: "GitHub operation response stream failed" });
  expect(prototypeReads).toBe(0);
  expect(String(captured)).not.toContain("provider stream rejection prototype");
});
