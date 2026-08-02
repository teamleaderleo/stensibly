import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestPullRequestReviewThreadAdapter } from "../src/github-rest-pull-request-review-thread-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const pullRequestNumber = 42;
const graphqlUrl = "https://api.github.test/graphql";

describe("bounded GitHub review-thread comment truncation", () => {
  test("retains the first comment page with explicit provider total and truncation evidence", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const comments = Array.from({ length: 20 }, (_, index) =>
      reviewComment(index + 1)
    );
    const adapter = new GitHubRestPullRequestReviewThreadAdapter({
      connectionId,
      installationId,
      credentialRef,
      tokenProvider,
      apiBaseUrl: "https://api.github.test",
      fetch: (async () => graphqlResponse({
        data: {
          repository: {
            nameWithOwner: "TeamLeaderLeo/Stensibly",
            pullRequest: {
              number: pullRequestNumber,
              reviewThreads: {
                totalCount: 1,
                pageInfo: {
                  hasNextPage: false,
                  endCursor: "thread-cursor",
                },
                nodes: [{
                  id: "PRRT_long_discussion",
                  isResolved: false,
                  isOutdated: false,
                  path: "src/long-discussion.ts",
                  line: 20,
                  originalLine: 20,
                  startLine: null,
                  originalStartLine: null,
                  diffSide: "RIGHT",
                  startDiffSide: null,
                  resolvedBy: null,
                  comments: {
                    totalCount: 21,
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "comment-cursor-20",
                    },
                    nodes: comments,
                  },
                }],
              },
            },
          },
        },
      })) as typeof fetch,
    });

    const receipt = await adapter.callReadTool({
      tool: "list_pull_request_review_threads",
      arguments: Object.freeze({ pr_number: pullRequestNumber }),
      repositoryFullName,
      connectionId,
      installationId,
      credentialRef,
      catalogueFingerprint,
    });

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
    expect(receipt.result).toMatchObject({
      repositoryFullName,
      number: pullRequestNumber,
      threadCount: 1,
      commentCount: 20,
      threads: [{
        id: "PRRT_long_discussion",
        commentsTotalCount: 21,
        commentsTruncated: true,
      }],
    });
    const result = receipt.result as {
      threads: Array<{
        comments: unknown[];
        commentsTotalCount: number;
        commentsTruncated: boolean;
      }>;
    };
    expect(result.threads[0]?.comments).toHaveLength(20);
    expect(result.threads[0]?.commentsTotalCount).toBe(21);
    expect(result.threads[0]?.commentsTruncated).toBe(true);
    expect(Object.isFrozen(result.threads[0])).toBe(true);
    expect(Object.isFrozen(result.threads[0]?.comments)).toBe(true);
  });
});

class RecordingTokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "delegated-token",
      expiresAt: "2026-08-01T01:00:00.000Z",
    };
  }
}

function reviewComment(index: number): Record<string, unknown> {
  return {
    id: `PRRC_long_${index}`,
    bodyText: `Bounded review comment ${index}.`,
    createdAt: "2026-08-01T00:01:00Z",
    updatedAt: "2026-08-01T00:02:00Z",
    author: { login: "review-author" },
    replyTo: null,
    pullRequestReview: {
      id: `PRR_long_${index}`,
      state: "COMMENTED",
      submittedAt: "2026-08-01T00:01:30Z",
      author: { login: "review-author" },
    },
  };
}

function graphqlResponse(payload: unknown): Response {
  const response = Response.json(payload, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-github-request-id": "THREADS:TRUNCATION:1",
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: graphqlUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}
