import { expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubRestPullRequestReviewThreadAdapter } from "../src/github-rest-pull-request-review-thread-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const graphqlUrl = "https://api.github.test/graphql";

test("classifies GraphQL errors before requiring data", async () => {
  const adapter = createAdapter(async () => response({
    errors: [{ message: "request rejected" }],
  }));

  await expectCode(
    adapter.callReadTool(callInput()),
    "github_delegated_provider_rejected",
  );
});

test("admits an empty rendered review comment body", async () => {
  const adapter = createAdapter(async () => response(pagePayload("")));

  const called = await adapter.callReadTool(callInput());
  const result = called.result as {
    threads: Array<{
      comments: Array<{ body: string; bodyCharacterCount: number }>;
    }>;
  };
  expect(result.threads[0]?.comments[0]?.body).toBe("");
  expect(result.threads[0]?.comments[0]?.bodyCharacterCount).toBe(0);
});

test("rejects non-canonical provider timestamps", async () => {
  const adapter = createAdapter(async () => response(
    pagePayload("review", "2026-08-01"),
  ));

  await expectCode(
    adapter.callReadTool(callInput()),
    "github_delegated_provider_invalid_response",
  );
});

function createAdapter(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestPullRequestReviewThreadAdapter {
  return new GitHubRestPullRequestReviewThreadAdapter({
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    credentialRef: "secret://github/app-private-key",
    tokenProvider: new StaticTokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as unknown as typeof fetch,
  });
}

function callInput() {
  return {
    tool: "list_pull_request_review_threads",
    arguments: Object.freeze({ pr_number: 42 }),
    repositoryFullName,
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    credentialRef: "secret://github/app-private-key",
    catalogueFingerprint: `sha256:${"a".repeat(64)}`,
  };
}

function response(payload: unknown): Response {
  const result = Response.json(payload, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-github-request-id": "THREADS:ADMISSION:1",
    },
  });
  Object.defineProperties(result, {
    url: { configurable: true, value: graphqlUrl },
    redirected: { configurable: true, value: false },
  });
  return result;
}

function pagePayload(
  bodyText: string,
  createdAt = "2026-08-01T00:01:00Z",
): Record<string, unknown> {
  return {
    data: {
      repository: {
        nameWithOwner: "TeamLeaderLeo/Stensibly",
        pullRequest: {
          number: 42,
          reviewThreads: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              id: "PRRT_admission",
              isResolved: false,
              isOutdated: false,
              path: "src/example.ts",
              line: 1,
              originalLine: 1,
              startLine: null,
              originalStartLine: null,
              diffSide: "RIGHT",
              startDiffSide: null,
              resolvedBy: null,
              comments: {
                totalCount: 1,
                pageInfo: {
                  hasNextPage: false,
                  endCursor: "comment-cursor",
                },
                nodes: [{
                  id: "PRRC_admission",
                  bodyText,
                  createdAt,
                  updatedAt: "2026-08-01T00:02:00Z",
                  author: { login: "reviewer" },
                  replyTo: null,
                  pullRequestReview: null,
                }],
              },
            }],
          },
        },
      },
    },
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    expect((error as GitHubProviderRejectedError).code).toBe(code);
  }
}

class StaticTokenProvider implements GitHubInstallationTokenProvider {
  async getInstallationToken(
    _input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    return {
      token: "delegated-token",
      expiresAt: "2026-08-01T01:00:00.000Z",
    };
  }
}
