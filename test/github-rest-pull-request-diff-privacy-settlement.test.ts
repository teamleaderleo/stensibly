import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubRestPullRequestDiffAdapter } from "../src/github-rest-pull-request-diff-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const pullRequestNumber = 42;
const pullRequestUrl =
  "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42";

class RecordingTokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "delegated-token",
      expiresAt: "2026-08-01T03:00:00.000Z",
    };
  }
}

describe("native GitHub pull request diff privacy and settlement", () => {
  test("rejects credential-shaped retained text with fixed diagnostics", async () => {
    const credentials = [
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"b".repeat(32)}`,
      `stn.tok_${"c".repeat(32)}`,
      `sk-${"d".repeat(32)}`,
      `sk-proj-${"e".repeat(32)}`,
      `xoxb-${"f".repeat(32)}`,
      `eyJ${"g".repeat(12)}.eyJ${"h".repeat(12)}.${"i".repeat(16)}`,
    ];

    for (const [index, credential] of credentials.entries()) {
      const prefix = index === 1 ? "-" : "+";
      const content = diffWithLine(
        `${prefix}const credential = ${JSON.stringify(credential)};`,
      );
      const adapter = createAdapter(async () => rawResponse(content));

      const error = await capturedError(() => adapter.callReadTool(callInput()));
      expect(error.code).toBe("github_delegated_provider_invalid_response");
      expect(error.message).toBe(
        "GitHub delegated diff response contained credential-shaped content",
      );
      expect(error.message).not.toContain(credential);
    }
  });

  test("preserves benign labels, locators, hashes, and base64-like source text", async () => {
    const content = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1,6 @@",
      "+const label = 'sk-review';",
      "+const envRef = 'env://OPENAI_API_KEY';",
      "+const secretRef = 'secret://github/app-private-key';",
      `+const sha = '${"a".repeat(40)}';`,
      "+const encoded = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==';",
      "+const jwtLike = 'eyJshort.eyJshort.short';",
      "",
    ].join("\n");
    const adapter = createAdapter(async () => rawResponse(content));

    const called = await adapter.callReadTool(callInput());
    expect((called.result as Record<string, unknown>).content).toBe(content);
  });

  test("cancels an invalid non-byte stream chunk before releasing it", async () => {
    const secret = "Bearer provider-private-invalid-chunk";
    const fixture = controlledStreamResponse({
      read: async () => ({
        done: false,
        value: { privateCause: secret },
      }),
    });
    const adapter = createAdapter(async () => fixture.response);

    const error = await capturedError(() => adapter.callReadTool(callInput()));
    expect(error.code).toBe("github_delegated_provider_invalid_response");
    expect(error.message).toBe(
      "GitHub delegated diff response body was invalid",
    );
    expect(error.message).not.toContain(secret);
    expect(fixture.cancellations()).toBe(1);
    expect(fixture.releases()).toBe(1);
  });

  test("preserves the read failure when cancellation and release also fail", async () => {
    const secret = "Bearer provider-private-read-cause";
    const fixture = controlledStreamResponse({
      read: async () => {
        throw new Error(secret);
      },
      cancelRejects: true,
      releaseRejects: true,
    });
    const adapter = createAdapter(async () => fixture.response);

    const error = await capturedError(() => adapter.callReadTool(callInput()));
    expect(error.code).toBe("github_delegated_provider_response_failed");
    expect(error.message).toBe(
      "GitHub delegated provider response could not be read",
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("cancel-private-cause");
    expect(error.message).not.toContain("release-private-cause");
    expect(fixture.cancellations()).toBe(1);
    expect(fixture.releases()).toBe(1);
  });
});

function createAdapter(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestPullRequestDiffAdapter {
  return new GitHubRestPullRequestDiffAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider: new RecordingTokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as unknown as typeof fetch,
  });
}

function callInput() {
  return {
    tool: "get_pr_diff",
    arguments: Object.freeze({ pr_number: pullRequestNumber }),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function diffWithLine(line: string): string {
  return [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    line,
    "",
  ].join("\n");
}

function rawResponse(content: string): Response {
  const response = new Response(content, {
    status: 200,
    headers: {
      "content-type": "application/vnd.github.v3.diff; charset=utf-8",
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: pullRequestUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}

function controlledStreamResponse(options: {
  read: () => Promise<unknown>;
  cancelRejects?: boolean;
  releaseRejects?: boolean;
}) {
  let cancellationCount = 0;
  let releaseCount = 0;
  const reader = {
    read: options.read,
    async cancel() {
      cancellationCount += 1;
      if (options.cancelRejects) {
        throw new Error("cancel-private-cause");
      }
    },
    releaseLock() {
      releaseCount += 1;
      if (options.releaseRejects) {
        throw new Error("release-private-cause");
      }
    },
  };
  const response = {
    ok: true,
    status: 200,
    url: pullRequestUrl,
    redirected: false,
    headers: new Headers({
      "content-type": "application/vnd.github.v3.diff; charset=utf-8",
    }),
    body: {
      getReader() {
        return reader;
      },
    },
  } as unknown as Response;
  return {
    response,
    cancellations: () => cancellationCount,
    releases: () => releaseCount,
  };
}

async function capturedError(
  run: () => Promise<unknown>,
): Promise<GitHubProviderRejectedError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    return error as GitHubProviderRejectedError;
  }
  throw new Error("Expected GitHub delegated pull request diff read to reject");
}
