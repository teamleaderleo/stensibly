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
const pullRequestUrl =
  "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42";

describe("native GitHub pull request review-thread reads", () => {
  test("paginates exact threads and returns bounded attributable discussion", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const requests: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    let page = 0;
    const adapter = createAdapter(tokenProvider, async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      page += 1;
      return graphqlResponse(
        page === 1 ? firstPage() : secondPage(),
        `THREADS:PAGE:${page}`,
      );
    });

    const called = await adapter.callReadTool(callInput(
      "list_pull_request_review_threads",
      { pr_number: pullRequestNumber },
    ));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual([
      graphqlUrl,
      graphqlUrl,
    ]);
    expect(requests[0]?.headers.get("authorization"))
      .toBe("Bearer delegated-token");
    expect(requests[0]?.headers.get("accept"))
      .toBe("application/vnd.github+json");
    expect(requests[0]?.headers.get("content-type"))
      .toBe("application/json");
    expect(requests[0]?.headers.get("x-github-api-version"))
      .toBe("2022-11-28");
    expect(requests[0]?.body.operationName).toBe("PullRequestReviewThreads");
    expect(requests[0]?.body.query).toContain("reviewThreads");
    expect(requests[0]?.body.variables).toEqual({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: pullRequestNumber,
      threadFirst: 25,
      threadAfter: null,
      commentFirst: 20,
    });
    expect(requests[1]?.body.variables).toEqual({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: pullRequestNumber,
      threadFirst: 25,
      threadAfter: "cursor-page-1",
      commentFirst: 20,
    });

    expect(called.providerRequestId).toBe("THREADS:PAGE:1");
    expect(called.result).toMatchObject({
      repositoryFullName,
      number: pullRequestNumber,
      threadCount: 2,
      commentCount: 3,
      pageCount: 2,
      providerRequestIds: ["THREADS:PAGE:1", "THREADS:PAGE:2"],
      threads: [
        {
          id: "PRRT_first",
          resolved: true,
          outdated: false,
          path: "src/first.ts",
          line: 20,
          originalLine: 18,
          startLine: 19,
          originalStartLine: 17,
          side: "RIGHT",
          startSide: "RIGHT",
          resolvedByLogin: "reviewer-one",
          comments: [{
            id: "PRRC_first",
            authorLogin: "author-one",
            body: "Please bind this to the exact repository.",
            bodyWasMinimized: false,
            createdAt: "2026-08-01T00:01:00.000Z",
            updatedAt: "2026-08-01T00:02:00.000Z",
            replyToId: null,
            review: {
              id: "PRR_first",
              state: "COMMENTED",
              submittedAt: "2026-08-01T00:01:30.000Z",
              authorLogin: "author-one",
            },
          }],
        },
        {
          id: "PRRT_second",
          resolved: false,
          outdated: true,
          path: "src/second.ts",
          line: null,
          originalLine: 44,
          startLine: null,
          originalStartLine: null,
          side: "RIGHT",
          startSide: null,
          resolvedByLogin: null,
          comments: [
            {
              id: "PRRC_second",
              authorLogin: "author-two",
              body: "See [url omitted] for provider details.",
              bodyWasMinimized: true,
              replyToId: null,
              review: {
                id: "PRR_second",
                state: "CHANGES_REQUESTED",
                authorLogin: "author-two",
              },
            },
            {
              id: "PRRC_reply",
              authorLogin: "reply-bot",
              body: "Applied the bounded repair.",
              bodyWasMinimized: false,
              replyToId: "PRRC_second",
              review: null,
            },
          ],
        },
      ],
    });
    const result = called.result as {
      providerRequestIds: unknown;
      threads: Array<{ comments: unknown }>;
    };
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
    expect(Object.isFrozen(result.providerRequestIds)).toBe(true);
    expect(Object.isFrozen(result.threads)).toBe(true);
    expect(Object.isFrozen(result.threads[0]?.comments)).toBe(true);
    expect(JSON.stringify(called)).not.toContain("https://docs.github.test");
    expect(JSON.stringify(called)).not.toContain("cursor-page-1");
    expect(JSON.stringify(called)).not.toContain("delegated-token");
  });

  test("delegates the landed pull request diff path unchanged", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const adapter = createAdapter(tokenProvider, async (input, init) => {
      expect(String(input)).toBe(pullRequestUrl);
      expect(new Headers(init?.headers).get("accept"))
        .toBe("application/vnd.github.v3.diff");
      return rawResponse("diff --git a/a.ts b/a.ts\n+thread chain\n");
    });

    const called = await adapter.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
      format: "diff",
    }));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
    expect(called.result).toMatchObject({
      repositoryFullName,
      number: pullRequestNumber,
      format: "diff",
      content: "diff --git a/a.ts b/a.ts\n+thread chain\n",
    });
  });

  test("rejects caller-controlled scope drift before token or provider activity", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokenProvider, async () => {
      providerCalls += 1;
      return graphqlResponse(firstPage(), "UNEXPECTED");
    });

    await expect(adapter.callReadTool({
      ...callInput("list_pull_request_review_threads", {
        pr_number: pullRequestNumber,
      }),
      connectionId: "ghconn_other",
    })).rejects.toThrow("did not match its admitted connection binding");
    await expect(adapter.callReadTool(callInput(
      "list_pull_request_review_threads",
      { pr_number: pullRequestNumber, repository: "other/repo" },
    ))).rejects.toThrow("arguments were invalid");
    await expect(adapter.callReadTool(callInput(
      "get_commit_combined_status",
      { commit_sha: "b".repeat(40) },
    ))).rejects.toThrow("outside the enabled native subset");

    expect(tokenProvider.requests).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  test("rejects repository, PR, and pagination identity drift", async () => {
    const cases: unknown[][] = [
      [pagePayload([threadOne()], 1, false, null, {
        repositoryFullName: "teamleaderleo/other",
      })],
      [pagePayload([threadOne()], 1, false, null, {
        pullRequestNumber: 43,
      })],
      [
        firstPage(),
        pagePayload([threadTwo()], 2, true, "cursor-page-1"),
      ],
    ];

    for (const payloads of cases) {
      let index = 0;
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => graphqlResponse(
          payloads[Math.min(index++, payloads.length - 1)]!,
          `IDENTITY:${index}`,
        ),
      );
      await expect(adapter.callReadTool(callInput(
        "list_pull_request_review_threads",
        { pr_number: pullRequestNumber },
      ))).rejects.toBeInstanceOf(Error);
    }
  });

  test("rejects nested pagination, duplicate identities, and unsafe bodies", async () => {
    const cases = [
      pagePayload([{
        ...threadOne(),
        comments: {
          ...commentsConnection([comment("PRRC_first", "first")]),
          pageInfo: { hasNextPage: true, endCursor: "nested-cursor" },
        },
      }], 1, false, null),
      pagePayload([threadOne(), { ...threadOne() }], 2, false, null),
      pagePayload([
        threadOne(),
        {
          ...threadTwo(),
          comments: commentsConnection([
            comment("PRRC_first", "duplicate comment"),
          ]),
        },
      ], 2, false, null),
      pagePayload([{
        ...threadOne(),
        comments: commentsConnection([
          comment("PRRC_secret", "Use secret://github/app-private-key"),
        ]),
      }], 1, false, null),
      pagePayload([{
        ...threadOne(),
        comments: commentsConnection([
          comment("PRRC_control", "unsafe\u0000body"),
        ]),
      }], 1, false, null),
    ];

    for (const payload of cases) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => graphqlResponse(payload, "REJECT:1"),
      );
      await expect(adapter.callReadTool(callInput(
        "list_pull_request_review_threads",
        { pr_number: pullRequestNumber },
      ))).rejects.toBeInstanceOf(Error);
    }
  });

  test("requires strict JSON, exact status, endpoint, media, and response bound", async () => {
    const responses = [
      textResponse(
        '{"data":{"repository":null},"data":{"repository":null}}',
        "STRICT:1",
      ),
      graphqlResponse(firstPage(), "STATUS:206", { status: 206 }),
      graphqlResponse(firstPage(), "REDIRECT:1", { redirected: true }),
      graphqlResponse(firstPage(), "WRONG:URL", {
        url: "https://api.github.test/other/graphql",
      }),
      graphqlResponse(firstPage(), "MEDIA:1", { contentType: "text/plain" }),
      textResponse("{}", "LENGTH:1", { contentLength: String(300_000) }),
    ];

    for (const response of responses) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => response,
      );
      await expect(adapter.callReadTool(callInput(
        "list_pull_request_review_threads",
        { pr_number: pullRequestNumber },
      ))).rejects.toBeInstanceOf(Error);
    }
  });

  test("replaces GraphQL error prose with a fixed provider rejection", async () => {
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => graphqlResponse({
        errors: [{ message: "provider-private-prose" }],
        data: null,
      }, "ERRORS:1"),
    );
    try {
      await adapter.callReadTool(callInput(
        "list_pull_request_review_threads",
        { pr_number: pullRequestNumber },
      ));
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).toContain("GraphQL request was rejected");
      expect(String(error)).not.toContain("provider-private-prose");
    }
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
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestPullRequestReviewThreadAdapter {
  return new GitHubRestPullRequestReviewThreadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as unknown as typeof fetch,
  });
}

function callInput(tool: string, argumentsValue: Record<string, unknown>) {
  return {
    tool,
    arguments: Object.freeze(argumentsValue),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function firstPage() {
  return pagePayload([threadOne()], 2, true, "cursor-page-1");
}

function secondPage() {
  return pagePayload([threadTwo()], 2, false, "cursor-page-2");
}

function pagePayload(
  threads: Record<string, unknown>[],
  totalCount: number,
  hasNextPage: boolean,
  endCursor: string | null,
  overrides: {
    repositoryFullName?: string;
    pullRequestNumber?: number;
  } = {},
) {
  return {
    data: {
      repository: {
        nameWithOwner: overrides.repositoryFullName ?? "TeamLeaderLeo/Stensibly",
        pullRequest: {
          number: overrides.pullRequestNumber ?? pullRequestNumber,
          reviewThreads: {
            totalCount,
            pageInfo: { hasNextPage, endCursor },
            nodes: threads,
          },
        },
      },
    },
  };
}

function threadOne(): Record<string, unknown> {
  return {
    id: "PRRT_first",
    isResolved: true,
    isOutdated: false,
    path: "src/first.ts",
    line: 20,
    originalLine: 18,
    startLine: 19,
    originalStartLine: 17,
    diffSide: "RIGHT",
    startDiffSide: "RIGHT",
    resolvedBy: { login: "reviewer-one" },
    comments: commentsConnection([
      comment("PRRC_first", "Please bind this to the exact repository.", {
        review: {
          id: "PRR_first",
          state: "COMMENTED",
          submittedAt: "2026-08-01T00:01:30Z",
          author: { login: "author-one" },
        },
      }),
    ]),
  };
}

function threadTwo(): Record<string, unknown> {
  return {
    id: "PRRT_second",
    isResolved: false,
    isOutdated: true,
    path: "src/second.ts",
    line: null,
    originalLine: 44,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    startDiffSide: null,
    resolvedBy: null,
    comments: commentsConnection([
      comment(
        "PRRC_second",
        "See https://docs.github.test/private for provider details.",
        {
          review: {
            id: "PRR_second",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-08-01T00:03:30Z",
            author: { login: "author-two" },
          },
        },
      ),
      comment("PRRC_reply", "Applied the bounded repair.", {
        author: { login: "reply-bot" },
        replyTo: { id: "PRRC_second" },
        review: null,
      }),
    ]),
  };
}

function commentsConnection(comments: Record<string, unknown>[]) {
  return {
    totalCount: comments.length,
    pageInfo: {
      hasNextPage: false,
      endCursor: comments.length > 0 ? "comment-cursor" : null,
    },
    nodes: comments,
  };
}

function comment(
  id: string,
  bodyText: string,
  overrides: {
    author?: Record<string, unknown> | null;
    replyTo?: Record<string, unknown> | null;
    review?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  return {
    id,
    bodyText,
    createdAt: "2026-08-01T00:01:00Z",
    updatedAt: "2026-08-01T00:02:00Z",
    author: overrides.author === undefined
      ? { login: id.includes("second") ? "author-two" : "author-one" }
      : overrides.author,
    replyTo: overrides.replyTo ?? null,
    pullRequestReview: overrides.review === undefined
      ? {
        id: `PRR_${id}`,
        state: "COMMENTED",
        submittedAt: "2026-08-01T00:01:30Z",
        author: { login: "author-one" },
      }
      : overrides.review,
  };
}

function graphqlResponse(
  payload: unknown,
  requestId: string,
  options: {
    status?: number;
    url?: string;
    redirected?: boolean;
    contentType?: string;
  } = {},
): Response {
  const response = Response.json(payload, {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json; charset=utf-8",
      "x-github-request-id": requestId,
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: options.url ?? graphqlUrl },
    redirected: { configurable: true, value: options.redirected ?? false },
  });
  return response;
}

function textResponse(
  body: string,
  requestId: string,
  options: { contentLength?: string } = {},
): Response {
  const response = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-github-request-id": requestId,
      ...(options.contentLength
        ? { "content-length": options.contentLength }
        : {}),
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: graphqlUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}

function rawResponse(content: string): Response {
  const response = new Response(content, {
    status: 200,
    headers: {
      "content-type": "application/vnd.github.v3.diff; charset=utf-8",
      "x-github-request-id": "DIFF:CHAIN:1",
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: pullRequestUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}
