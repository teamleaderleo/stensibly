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

describe("merged GitHub review-thread provider boundaries", () => {
  test("attaches one bounded abort signal to every GraphQL request", async () => {
    let observedSignal: AbortSignal | null | undefined;
    const adapter = createAdapter(async (_input, init) => {
      observedSignal = init?.signal;
      return graphqlResponse(validPage());
    });

    await adapter.callReadTool(callInput());

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
  });

  test("classifies GraphQL errors before requiring a data field", async () => {
    const adapter = createAdapter(async () => graphqlResponse({
      errors: [{ message: "provider-private-prose" }],
    }));

    try {
      await adapter.callReadTool(callInput());
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as { code?: string }).code)
        .toBe("github_delegated_provider_rejected");
      expect(String(error)).toContain("GraphQL request was rejected");
      expect(String(error)).not.toContain("provider-private-prose");
    }
  });

  test("accepts an empty rendered review body", async () => {
    const adapter = createAdapter(async () => graphqlResponse(validPage({
      bodyText: "",
    })));

    const called = await adapter.callReadTool(callInput());

    expect(called.result).toMatchObject({
      threads: [{
        comments: [{
          body: "",
          bodyCharacterCount: 0,
          bodyWasMinimized: false,
        }],
      }],
    });
  });

  test("rejects date-only and offset timestamp aliases", async () => {
    for (const createdAt of [
      "2026-08-01",
      "2026-08-01T00:01:00+00:00",
    ]) {
      const adapter = createAdapter(async () => graphqlResponse(validPage({
        createdAt,
      })));

      try {
        await adapter.callReadTool(callInput());
        throw new Error("expected rejection");
      } catch (error) {
        expect((error as { code?: string }).code)
          .toBe("github_delegated_provider_invalid_response");
      }
    }
  });
});

class TokenProvider implements GitHubInstallationTokenProvider {
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
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestPullRequestReviewThreadAdapter {
  return new GitHubRestPullRequestReviewThreadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider: new TokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as unknown as typeof fetch,
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

function validPage(overrides: {
  bodyText?: string;
  createdAt?: string;
} = {}) {
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
              id: "PRRT_boundary",
              isResolved: false,
              isOutdated: false,
              path: "src/boundary.ts",
              line: 10,
              originalLine: 10,
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
                  id: "PRRC_boundary",
                  bodyText: overrides.bodyText ?? "Review boundary.",
                  createdAt: overrides.createdAt
                    ?? "2026-08-01T00:01:00Z",
                  updatedAt: "2026-08-01T00:02:00Z",
                  author: { login: "reviewer" },
                  replyTo: null,
                  pullRequestReview: {
                    id: "PRR_boundary",
                    state: "COMMENTED",
                    submittedAt: "2026-08-01T00:01:30Z",
                    author: { login: "reviewer" },
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
      "x-github-request-id": "POSTMERGE:BOUNDARY:1",
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: graphqlUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}
