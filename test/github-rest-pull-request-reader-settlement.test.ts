import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubRestPullRequestReadAdapter } from "../src/github-rest-pull-request-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const pullRequestNumber = 42;
const responseMaximumBytes = 128 * 1024;
const responseFailedCode = "github_delegated_provider_response_failed";
const responseFailedMessage =
  "GitHub delegated provider response could not be read";
const invalidResponseCode = "github_delegated_provider_invalid_response";
const invalidChunkMessage =
  "GitHub delegated provider returned a non-byte response chunk";
const tooLargeCode = "github_delegated_provider_result_too_large";
const tooLargeMessage =
  `GitHub delegated provider response exceeds ${responseMaximumBytes} bytes`;

interface ReaderDouble {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

class RecordingTokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "delegated-token",
      expiresAt: "2026-07-31T19:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: () => Promise<Response>,
): GitHubRestPullRequestReadAdapter {
  return new GitHubRestPullRequestReadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as unknown as typeof fetch,
  });
}

function callInput() {
  return {
    tool: "get_pr_info",
    arguments: Object.freeze({ pr_number: pullRequestNumber }),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function readerResponse(getReader: () => ReaderDouble): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: { getReader },
  } as unknown as Response;
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function pullRequestPayload(): Record<string, unknown> {
  return {
    id: 987654,
    node_id: "PR_kwDOGitHub",
    number: pullRequestNumber,
    state: "open",
    locked: false,
    title: "Fence response reader settlement",
    user: { login: "teamleaderleo" },
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: {
      ref: "repair/790-pr-response-reader-settlement",
      sha: "d".repeat(40),
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    base: {
      ref: "main",
      sha: "e".repeat(40),
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    url: "https://api.github.test/repos/TeamLeaderLeo/Stensibly/pulls/42",
    created_at: "2026-07-31T18:00:00Z",
    updated_at: "2026-07-31T18:05:00Z",
    closed_at: null,
    merged_at: null,
    additions: 20,
    deletions: 4,
    changed_files: 2,
    commits: 2,
    review_comments: 0,
    comments: 0,
  };
}

async function expectFixedFailure(
  promise: Promise<unknown>,
  code: string,
  message: string,
  forbidden: readonly string[],
): Promise<void> {
  try {
    await promise;
    throw new Error("expected GitHub provider rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    const rejected = error as GitHubProviderRejectedError;
    expect(rejected.code).toBe(code);
    expect(rejected.message).toBe(message);
    for (const value of forbidden) {
      expect(rejected.message).not.toContain(value);
      expect(JSON.stringify(rejected)).not.toContain(value);
    }
  }
}

describe("pull request response reader settlement", () => {
  test("maps synchronous getReader failure to fixed response failure", async () => {
    const secret = "getReader-private-ghp_secret";
    let providerCalls = 0;
    const adapter = createAdapter(new RecordingTokenProvider(), async () => {
      providerCalls += 1;
      return readerResponse(() => {
        throw new Error(secret);
      });
    });

    await expectFixedFailure(
      adapter.callReadTool(callInput()),
      responseFailedCode,
      responseFailedMessage,
      [secret, "delegated-token"],
    );
    expect(providerCalls).toBe(1);
  });

  test("rejects non-byte chunks without retaining custom value identity", async () => {
    const secret = "non-byte-private-stn.tok_secret";
    const hostile = Object.freeze({ secret, byteLength: 1 });
    let releases = 0;
    let cancellations = 0;
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => readerResponse(() => {
        let readCalls = 0;
        return {
          async read() {
            readCalls += 1;
            return readCalls === 1
              ? { done: false, value: hostile as unknown as Uint8Array }
              : { done: true, value: undefined };
          },
          async cancel() {
            cancellations += 1;
          },
          releaseLock() {
            releases += 1;
          },
        };
      }),
    );

    await expectFixedFailure(
      adapter.callReadTool(callInput()),
      invalidResponseCode,
      invalidChunkMessage,
      [secret],
    );
    expect(cancellations).toBe(1);
    expect(releases).toBe(1);
  });

  test("preserves too-large result when reader cancellation throws", async () => {
    const secret = "cancel-private-github_pat_secret";
    let releases = 0;
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => readerResponse(() => ({
        async read() {
          return {
            done: false,
            value: new Uint8Array(responseMaximumBytes + 1),
          };
        },
        async cancel() {
          throw new Error(secret);
        },
        releaseLock() {
          releases += 1;
        },
      })),
    );

    await expectFixedFailure(
      adapter.callReadTool(callInput()),
      tooLargeCode,
      tooLargeMessage,
      [secret],
    );
    expect(releases).toBe(1);
  });

  test("maps release failure after a successful bounded read", async () => {
    const secret = "release-private-xoxb-secret";
    const payload = bytes(pullRequestPayload());
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => readerResponse(() => {
        let readCalls = 0;
        return {
          async read() {
            readCalls += 1;
            return readCalls === 1
              ? { done: false, value: payload }
              : { done: true, value: undefined };
          },
          async cancel() {},
          releaseLock() {
            throw new Error(secret);
          },
        };
      }),
    );

    await expectFixedFailure(
      adapter.callReadTool(callInput()),
      responseFailedCode,
      responseFailedMessage,
      [secret],
    );
  });

  test("preserves read-stage fixed failure when release also throws", async () => {
    const readSecret = "read-private-sk-secret";
    const releaseSecret = "release-private-eyJsecret.eyJsecret.";
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => readerResponse(() => ({
        async read() {
          throw new Error(readSecret);
        },
        async cancel() {},
        releaseLock() {
          throw new Error(releaseSecret);
        },
      })),
    );

    await expectFixedFailure(
      adapter.callReadTool(callInput()),
      responseFailedCode,
      responseFailedMessage,
      [readSecret, releaseSecret],
    );
  });

  test("rejections do not cache or reuse provider activity", async () => {
    const secret = "fresh-provider-private-gho_secret";
    const tokenProvider = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokenProvider, async () => {
      providerCalls += 1;
      return readerResponse(() => {
        throw new Error(secret);
      });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectFixedFailure(
        adapter.callReadTool(callInput()),
        responseFailedCode,
        responseFailedMessage,
        [secret],
      );
    }

    expect(providerCalls).toBe(2);
    expect(tokenProvider.requests).toHaveLength(2);
    expect(tokenProvider.requests).toEqual([
      {
        repositoryFullName,
        permission: { name: "pull_requests", access: "read" },
      },
      {
        repositoryFullName,
        permission: { name: "pull_requests", access: "read" },
      },
    ]);
  });
});
