import { expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestPullRequestReviewThreadAdapter } from "../src/github-rest-pull-request-review-thread-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const graphqlUrl = "https://api.github.test/graphql";

test("copies admitted review-thread chunks before producer mutation", async () => {
  const payload = JSON.stringify({
    data: {
      repository: {
        nameWithOwner: "TeamLeaderLeo/Stensibly",
        pullRequest: {
          number: 42,
          reviewThreads: {
            totalCount: 0,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  });
  const bytes = new TextEncoder().encode(payload);
  const split = Math.floor(bytes.byteLength / 2);
  const oversizedBacking = new Uint8Array(1024 * 1024);
  const first = oversizedBacking.subarray(0, split);
  first.set(bytes.subarray(0, split));
  const second = bytes.slice(split);

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(first);
    },
  });

  const adapter = new GitHubRestPullRequestReviewThreadAdapter({
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    credentialRef: "secret://github/app-private-key",
    tokenProvider: new StaticTokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: (async () => {
      setTimeout(() => {
        first.fill(0x78);
        streamController!.enqueue(second);
        streamController!.close();
      }, 0);
      const response = new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-github-request-id": "THREADS:BUFFER:1",
        },
      });
      Object.defineProperties(response, {
        url: { configurable: true, value: graphqlUrl },
        redirected: { configurable: true, value: false },
      });
      return response;
    }) as unknown as typeof fetch,
  });

  const called = await adapter.callReadTool({
    tool: "list_pull_request_review_threads",
    arguments: Object.freeze({ pr_number: 42 }),
    repositoryFullName,
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    credentialRef: "secret://github/app-private-key",
    catalogueFingerprint: `sha256:${"a".repeat(64)}`,
  });

  expect(called.result).toMatchObject({
    repositoryFullName,
    number: 42,
    threadCount: 0,
    commentCount: 0,
    pageCount: 1,
  });
});

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
