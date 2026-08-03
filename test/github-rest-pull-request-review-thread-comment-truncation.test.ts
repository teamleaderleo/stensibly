import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
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
    const adapter = adapterFor(
      tokenProvider,
      commentsConnection({
        totalCount: 21,
        hasNextPage: true,
        endCursor: "comment-cursor-20",
        nodeCount: 20,
      }),
    );

    const receipt = await call(adapter);

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

  test("marks a complete full comment page as not truncated", async () => {
    const adapter = adapterFor(
      new RecordingTokenProvider(),
      commentsConnection({
        totalCount: 20,
        hasNextPage: false,
        endCursor: "comment-cursor-20",
        nodeCount: 20,
      }),
    );

    const receipt = await call(adapter);
    expect(receipt.result).toMatchObject({
      commentCount: 20,
      threads: [{
        commentsTotalCount: 20,
        commentsTruncated: false,
      }],
    });
  });

  test("rejects a truncated comment page without a continuation cursor", async () => {
    const adapter = adapterFor(
      new RecordingTokenProvider(),
      commentsConnection({
        totalCount: 21,
        hasNextPage: true,
        endCursor: null,
        nodeCount: 20,
      }),
    );

    await expect(call(adapter)).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    } satisfies Partial<GitHubProviderRejectedError>);
  });

  test("rejects a provider total larger than retained nodes without truncation", async () => {
    const adapter = adapterFor(
      new RecordingTokenProvider(),
      commentsConnection({
        totalCount: 21,
        hasNextPage: false,
        endCursor: "comment-cursor-20",
        nodeCount: 20,
      }),
    );

    await expect(call(adapter)).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    } satisfies Partial<GitHubProviderRejectedError>);
  });

  test("rejects a short page that claims more comments remain", async () => {
    const adapter = adapterFor(
      new RecordingTokenProvider(),
      commentsConnection({
        totalCount: 21,
        hasNextPage: true,
        endCursor: "comment-cursor-19",
        nodeCount: 19,
      }),
    );

    await expect(call(adapter)).rejects.toMatchObject({
      code: "github_delegated_provider_invalid_response",
    } satisfies Partial<GitHubProviderRejectedError>);
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

function adapterFor(
  tokenProvider: RecordingTokenProvider,
  comments: Record<string, unknown>,
): GitHubRestPullRequestReviewThreadAdapter {
  return new GitHubRestPullRequestReviewThreadAdapter({
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
                comments,
              }],
            },
          },
        },
      },
    })) as unknown as typeof fetch,
  });
}

async function call(
  adapter: GitHubRestPullRequestReviewThreadAdapter,
): Promise<Awaited<ReturnType<GitHubRestPullRequestReviewThreadAdapter["callReadTool"]>>> {
  return adapter.callReadTool({
    tool: "list_pull_request_review_threads",
    arguments: Object.freeze({ pr_number: pullRequestNumber }),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  });
}

function commentsConnection(input: {
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  nodeCount: number;
}): Record<string, unknown> {
  return {
    totalCount: input.totalCount,
    pageInfo: {
      hasNextPage: input.hasNextPage,
      endCursor: input.endCursor,
    },
    nodes: Array.from({ length: input.nodeCount }, (_, index) =>
      reviewComment(index + 1)
    ),
  };
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
