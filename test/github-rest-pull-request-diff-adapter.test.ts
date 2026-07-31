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
const maximumBytes = 128 * 1024;
const headSha = "d".repeat(40);
const baseSha = "e".repeat(40);
const pullRequestUrl = "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42";

const diffText = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1 +1 @@",
  "-export const state = 'before';",
  "+export const state = 'after';",
  "",
].join("\n");

const patchText = [
  "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
  "Subject: [PATCH] Update example",
  "---",
  " src/example.ts | 2 +-",
  " 1 file changed, 1 insertion(+), 1 deletion(-)",
  "",
  diffText,
].join("\n");

describe("native GitHub delegated pull request diff reads", () => {
  test("gets a bounded diff with pull-request-only authority and official media type", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const adapter = createAdapter(tokenProvider, async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return rawResponse(diffText, "diff", {
        "x-github-request-id": "PRDIFF:1234",
      });
    });

    const called = await adapter.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
    }));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
    expect(requestUrl).toBe(
      "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42",
    );
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer delegated-token");
    expect(headers.get("accept")).toBe("application/vnd.github.v3.diff");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(requestInit?.redirect).toBe("error");
    expect(called).toEqual({
      providerRequestId: "PRDIFF:1234",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        format: "diff",
        byteLength: Buffer.byteLength(diffText, "utf8"),
        content: diffText,
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
  });

  test("preserves the explicit patch contract with the patch media type", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let accept = "";
    const adapter = createAdapter(tokenProvider, async (_input, init) => {
      accept = new Headers(init?.headers).get("accept") ?? "";
      return rawResponse(patchText, "patch");
    });

    const called = await adapter.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
      format: "patch",
    }));

    expect(accept).toBe("application/vnd.github.v3.patch");
    expect(called.result).toEqual({
      repositoryFullName,
      number: pullRequestNumber,
      format: "patch",
      byteLength: Buffer.byteLength(patchText, "utf8"),
      content: patchText,
    });
    expect(tokenProvider.requests).toHaveLength(1);
  });

  test("delegates the landed pull request metadata and repository reads unchanged", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const adapter = createAdapter(tokenProvider, async (_input, init) => {
      const accept = new Headers(init?.headers).get("accept");
      if (accept === "application/vnd.github+json") {
        return Response.json(pullRequestPayload());
      }
      throw new Error("unexpected raw request");
    });

    const called = await adapter.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }));

    expect((called.result as Record<string, unknown>).number)
      .toBe(pullRequestNumber);
    expect((called.result as Record<string, unknown>).repositoryFullName)
      .toBe(repositoryFullName);
    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
  });

  test("stops binding, argument, accessor, and unsupported-tool failures before activity", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokenProvider, async () => {
      providerCalls += 1;
      return rawResponse(diffText, "diff");
    });

    await expect(adapter.callReadTool({
      ...callInput("get_pr_diff", { pr_number: pullRequestNumber }),
      connectionId: "ghconn_other",
    })).rejects.toThrow("did not match its admitted connection binding");
    await expect(adapter.callReadTool(callInput("get_pr_diff", {
      pr_number: 0,
    }))).rejects.toThrow("arguments were invalid");
    await expect(adapter.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
      format: "raw",
    }))).rejects.toThrow("arguments were invalid");
    await expect(adapter.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
      owner: "other",
    }))).rejects.toThrow("arguments were invalid");
    await expect(adapter.callReadTool(callInput(
      "list_pull_request_review_threads",
      { pr_number: pullRequestNumber },
    ))).rejects.toThrow("outside the enabled native subset");

    let getterCalls = 0;
    const hostile = callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
    });
    Object.defineProperty(hostile, "tool", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "get_pr_diff";
      },
    });
    await expect(adapter.callReadTool(hostile))
      .rejects.toThrow("fields must be enumerable data properties");

    expect(getterCalls).toBe(0);
    expect(tokenProvider.requests).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  test("accepts the exact raw byte ceiling and rejects one byte beyond it", async () => {
    const acceptedContent = "a".repeat(maximumBytes);
    const accepted = createAdapter(
      new RecordingTokenProvider(),
      async () => rawResponse(acceptedContent, "diff"),
    );
    const called = await accepted.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
      format: "diff",
    }));
    expect((called.result as Record<string, unknown>).byteLength)
      .toBe(maximumBytes);

    const rejectedAdapter = createAdapter(
      new RecordingTokenProvider(),
      async () => providerResponse(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(maximumBytes));
          controller.enqueue(new Uint8Array([97]));
          controller.close();
        },
      }), {
        headers: {
          "content-type": "application/vnd.github.v3.diff; charset=utf-8",
        },
      })),
    );
    await expect(rejectedAdapter.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
    }))).rejects.toThrow(`exceeds ${maximumBytes} bytes`);
  });

  test("rejects declared overflow, malformed length, and wrong media type before reading", async () => {
    for (const fixture of [
      controlledResponse({
        headers: {
          "content-type": "application/vnd.github.v3.diff; charset=utf-8",
          "content-length": String(maximumBytes + 1),
        },
      }),
      controlledResponse({
        headers: {
          "content-type": "application/vnd.github.v3.diff",
          "content-length": "12x",
        },
      }),
      controlledResponse({
        headers: { "content-type": "application/json" },
      }),
    ]) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => fixture.response,
      );
      await expect(adapter.callReadTool(callInput("get_pr_diff", {
        pr_number: pullRequestNumber,
      }))).rejects.toBeInstanceOf(Error);
      expect(fixture.cancellations()).toBe(1);
      expect(fixture.readerCalls()).toBe(0);
    }
  });

  test("maps unreadable bodies to fixed prose without provider or bearer leakage", async () => {
    const secret = "Bearer delegated-token provider-private-cause";
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => providerResponse(new Response(new ReadableStream<Uint8Array>({
        pull() {
          throw new Error(secret);
        },
      }), {
        headers: {
          "content-type": "application/vnd.github.v3.diff",
        },
      })),
    );

    const error = await capturedError(() => adapter.callReadTool(callInput(
      "get_pr_diff",
      { pr_number: pullRequestNumber },
    )));
    expect(error.code).toBe("github_delegated_provider_response_failed");
    expect(error.message).toBe(
      "GitHub delegated provider response could not be read",
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("delegated-token");
  });

  test("rejects invalid UTF-8 and unsafe control text", async () => {
    const fixtures = [
      new Uint8Array([0xff]),
      new TextEncoder().encode("diff --git a/a b/a\n\u001b[31munsafe"),
    ];
    for (const bytes of fixtures) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => providerResponse(new Response(bytes.slice(), {
          headers: {
            "content-type": "application/vnd.github.v3.diff",
          },
        })),
      );
      await expect(adapter.callReadTool(callInput("get_pr_diff", {
        pr_number: pullRequestNumber,
      }))).rejects.toBeInstanceOf(GitHubProviderRejectedError);
    }
  });

  test("rejects partial content before reading a valid-media body", async () => {
    const fixture = controlledResponse({
      status: 206,
      headers: {
        "content-type": "application/vnd.github.v3.diff; charset=utf-8",
      },
    });
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => fixture.response,
    );

    const error = await capturedError(() => adapter.callReadTool(callInput(
      "get_pr_diff",
      { pr_number: pullRequestNumber },
    )));
    expect(error.code).toBe("github_delegated_provider_invalid_response");
    expect(error.message).toBe(
      "GitHub delegated provider did not return an exact complete response",
    );
    expect(fixture.cancellations()).toBe(1);
    expect(fixture.readerCalls()).toBe(0);
  });

  test("binds raw responses to the exact non-redirected repository and pull request URL", async () => {
    for (const options of [
      {
        url: "https://api.github.test/repos/other/stensibly/pulls/42",
      },
      {
        url: "https://api.github.test/repos/teamleaderleo/stensibly/pulls/43",
      },
      {
        redirected: true,
      },
    ]) {
      const fixture = controlledResponse({
        headers: {
          "content-type": "application/vnd.github.v3.diff; charset=utf-8",
        },
        ...options,
      });
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => fixture.response,
      );

      const error = await capturedError(() => adapter.callReadTool(callInput(
        "get_pr_diff",
        { pr_number: pullRequestNumber },
      )));
      expect(error.code).toBe("github_delegated_provider_identity_mismatch");
      expect(error.message).toBe(
        "GitHub delegated provider response did not match the requested pull request",
      );
      expect(fixture.cancellations()).toBe(1);
      expect(fixture.readerCalls()).toBe(0);
    }
  });

  test("maps HTTP failures after body disposal and keeps the status authoritative", async () => {
    const fixture = controlledResponse({
      status: 403,
      cancelRejects: true,
    });
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => fixture.response,
    );

    const error = await capturedError(() => adapter.callReadTool(callInput(
      "get_pr_diff",
      { pr_number: pullRequestNumber },
    )));
    expect(error.code).toBe("github_delegated_permission_denied");
    expect(error.message).toBe(
      "GitHub delegated provider request failed (HTTP 403)",
    );
    expect(error.message).not.toContain("cancel-private-cause");
    expect(fixture.cancellations()).toBe(1);
    expect(fixture.readerCalls()).toBe(0);
  });

  test("keeps benign sk labels and rejects realistic credential-shaped request identities", async () => {
    const accepted = createAdapter(
      new RecordingTokenProvider(),
      async () => rawResponse(diffText, "diff", {
        "x-github-request-id": "trace-sk-review",
      }),
    );
    const acceptedCall = await accepted.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
    }));
    expect(acceptedCall.providerRequestId).toBe("trace-sk-review");

    for (const providerRequestId of [
      "trace_github_pat_example",
      `trace_sk-${"a".repeat(32)}`,
      `trace_sk-proj-${"b".repeat(32)}`,
    ]) {
      const fixture = controlledResponse({
        headers: {
          "content-type": "application/vnd.github.v3.diff",
          "x-github-request-id": providerRequestId,
        },
      });
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => fixture.response,
      );

      await expect(adapter.callReadTool(callInput("get_pr_diff", {
        pr_number: pullRequestNumber,
      }))).rejects.toThrow("provider request identity was invalid");
      expect(fixture.cancellations()).toBe(1);
      expect(fixture.readerCalls()).toBe(0);
    }
  });

  test("replaces redirect and transport causes with fixed request prose", async () => {
    const secret = "https://private.example/path Bearer delegated-token";
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => {
        throw new Error(secret);
      },
    );

    const error = await capturedError(() => adapter.callReadTool(callInput(
      "get_pr_diff",
      { pr_number: pullRequestNumber },
    )));
    expect(error.code).toBe("github_delegated_provider_request_failed");
    expect(error.message).toBe(
      "GitHub delegated provider request failed before a response was available",
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("delegated-token");
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
      expiresAt: "2026-08-01T03:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestPullRequestDiffAdapter {
  return new GitHubRestPullRequestDiffAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
  });
}

function callInput(
  tool: string,
  argumentsValue: Record<string, unknown>,
) {
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

function rawResponse(
  content: string,
  format: "diff" | "patch",
  headers: HeadersInit = {},
): Response {
  return providerResponse(new Response(content, {
    status: 200,
    headers: {
      "content-type": `application/vnd.github.v3.${format}; charset=utf-8`,
      ...headers,
    },
  }));
}

function providerResponse(
  response: Response,
  options: { url?: string; redirected?: boolean } = {},
): Response {
  Object.defineProperties(response, {
    url: {
      configurable: true,
      value: options.url ?? pullRequestUrl,
    },
    redirected: {
      configurable: true,
      value: options.redirected ?? false,
    },
  });
  return response;
}

function pullRequestPayload(): Record<string, unknown> {
  return {
    id: 987654,
    node_id: "PR_kwDOGitHub",
    number: pullRequestNumber,
    state: "open",
    locked: false,
    title: "Add one guarded pull request diff read",
    user: { login: "teamleaderleo" },
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: {
      ref: "oriole/697-native-pr-diff",
      sha: headSha,
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    base: {
      ref: "main",
      sha: baseSha,
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    url: "https://api.github.test/repos/TeamLeaderLeo/Stensibly/pulls/42",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:05:00Z",
    closed_at: null,
    merged_at: null,
    additions: 120,
    deletions: 12,
    changed_files: 2,
    commits: 1,
    review_comments: 3,
    comments: 4,
  };
}

function controlledResponse(options: {
  status?: number;
  headers?: HeadersInit;
  cancelRejects?: boolean;
  url?: string;
  redirected?: boolean;
}) {
  let cancellationCount = 0;
  let readerCallCount = 0;
  const status = options.status ?? 200;
  const response = {
    ok: status >= 200 && status < 300,
    status,
    url: options.url ?? pullRequestUrl,
    redirected: options.redirected ?? false,
    headers: new Headers(options.headers),
    body: {
      async cancel() {
        cancellationCount += 1;
        if (options.cancelRejects) {
          throw new Error("cancel-private-cause");
        }
      },
      getReader() {
        readerCallCount += 1;
        throw new Error("provider body reader must stay unused");
      },
    },
  } as unknown as Response;
  return {
    response,
    cancellations: () => cancellationCount,
    readerCalls: () => readerCallCount,
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