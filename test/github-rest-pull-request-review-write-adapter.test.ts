import { describe, expect, test } from "bun:test";
import { GitHubRestPullRequestReviewWriteAdapter } from "../src/github-rest-pull-request-review-write-adapter.ts";

const repo = "teamleaderleo/stensibly";
const head = "1111111111111111111111111111111111111111";

function prPayload() {
  return {
    number: 777,
    url: `https://api.github.com/repos/${repo}/pulls/777`,
    state: "open",
    draft: true,
    updated_at: "2026-08-15T06:45:00Z",
    head: { sha: head },
    base: { repo: { full_name: repo } },
  };
}

function reviewPayload(body: string, id = 9876) {
  return {
    id,
    url: `https://api.github.com/repos/${repo}/pulls/777/reviews/${id}`,
    commit_id: head,
    state: "COMMENTED",
    body,
    user: { login: "teamleaderleo" },
    submitted_at: "2026-08-15T06:46:00Z",
  };
}

describe("GitHubRestPullRequestReviewWriteAdapter", () => {
  test("uses pull_requests read/write permissions and sends exact typed review fields", async () => {
    const permissions: unknown[] = [];
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const providerBody = "Formal review body.\n\n<!-- stensibly-review-effect:stn-gh-review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
    const adapter = new GitHubRestPullRequestReviewWriteAdapter({
      tokenProvider: {
        async getInstallationToken(input) {
          permissions.push(input);
          return { token: "provider-token", expiresAt: "2026-08-15T07:45:00.000Z" };
        },
      },
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        requests.push({ url: String(url), method, body: rawBody });
        if (method === "GET" && String(url).endsWith("/pulls/777")) {
          return json(prPayload());
        }
        if (method === "POST" && String(url).endsWith("/pulls/777/reviews")) {
          return json(reviewPayload(providerBody), "request-create-review");
        }
        if (method === "GET" && String(url).endsWith("/pulls/777/reviews/9876")) {
          return json(reviewPayload(providerBody));
        }
        if (method === "GET" && String(url).includes("/pulls/777/reviews?")) {
          return json([reviewPayload(providerBody)]);
        }
        throw new Error(`unexpected ${method} ${String(url)}`);
      },
    });

    const target = await adapter.getPullRequest({
      repositoryFullName: repo,
      pullRequestNumber: 777,
    });
    expect(target.headSha).toBe(head);
    expect(target.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);

    const created = await adapter.createReview({
      repositoryFullName: repo,
      pullRequestNumber: 777,
      commitSha: head,
      action: "COMMENT",
      body: providerBody,
    });
    expect(created.review.id).toBe("9876");
    expect(created.providerRequestId).toBe("request-create-review");
    expect(requests.find((entry) => entry.method === "POST")?.body).toEqual({
      commit_id: head,
      event: "COMMENT",
      body: providerBody,
    });

    const readback = await adapter.getReview({
      repositoryFullName: repo,
      pullRequestNumber: 777,
      reviewId: "9876",
    });
    expect(readback.state).toBe("commented");
    expect(readback.body).toBe(providerBody);

    const listed = await adapter.listReviews({
      repositoryFullName: repo,
      pullRequestNumber: 777,
    });
    expect(listed).toHaveLength(1);
    expect(permissions).toContainEqual({
      repositoryFullName: repo,
      permission: { name: "pull_requests", access: "write" },
    });
    expect(permissions).toContainEqual({
      repositoryFullName: repo,
      permission: { name: "pull_requests", access: "read" },
    });
  });
});

function json(value: unknown, requestId?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(requestId ? { "x-github-request-id": requestId } : {}),
    },
  });
}
