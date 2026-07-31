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

describe("native GitHub review-thread lifecycle admission", () => {
  test("retains resolved state when resolver attribution is unavailable", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const adapter = createAdapter(tokenProvider, resolvedThreadPayload({
      resolvedBy: null,
      reviewState: "COMMENTED",
      submittedAt: "2026-08-01T00:01:30Z",
    }));

    const called = await adapter.callReadTool(callInput());

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
    expect(called.result).toMatchObject({
      repositoryFullName,
      number: pullRequestNumber,
      threadCount: 1,
      threads: [{
        resolved: true,
        resolvedByLogin: null,
      }],
    });
  });

  test("rejects a submitted review state without submission time", async () => {
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      resolvedThreadPayload({
        resolvedBy: { login: "reviewer-one" },
        reviewState: "COMMENTED",
        submittedAt: null,
      }),
    );

    await expect(adapter.callReadTool(callInput())).rejects.toBeInstanceOf(Error);
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

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  payload: unknown,
): GitHubRestPullRequestReviewThreadAdapter {
  return new GitHubRestPullRequestReviewThreadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: (async () => graphqlResponse(payload)) as unknown as typeof fetch,
  });
}

function callInput() {
  return {
    tool: "list_pull_request_review_threads",
    arguments: Object.freeze({ pr_number: pullRequestNumber }),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function resolvedThreadPayload(options: {
  resolvedBy: { login: string } | null;
  reviewState: "COMMENTED";
  submittedAt: string | null;
}) {
  return {
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
              id: "PRRT_lifecycle",
              isResolved: true,
              isOutdated: false,
              path: "src/example.ts",
              line: 5,
              originalLine: 5,
              startLine: null,
              originalStartLine: null,
              diffSide: "RIGHT",
              startDiffSide: null,
              resolvedBy: options.resolvedBy,
              comments: {
                totalCount: 1,
                pageInfo: {
                  hasNextPage: false,
                  endCursor: "comment-cursor",
                },
                nodes: [{
                  id: "PRRC_lifecycle",
                  bodyText: "Preserve the provider-known lifecycle state.",
                  createdAt: "2026-08-01T00:01:00Z",
                  updatedAt: "2026-08-01T00:02:00Z",
                  author: { login: "author-one" },
                  replyTo: null,
                  pullRequestReview: {
                    id: "PRR_lifecycle",
                    state: options.reviewState,
                    submittedAt: options.submittedAt,
                    author: { login: "author-one" },
                  },
                }],
              },
            }],
          },
        },
      },
    },
  };
}

function graphqlResponse(payload: unknown): Response {
  const response = Response.json(payload, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-github-request-id": "LIFECYCLE:1",
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: graphqlUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}
