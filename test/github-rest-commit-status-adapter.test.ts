import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubRestCommitStatusAdapter } from "../src/github-rest-commit-status-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "d".repeat(40);
const firstUrl = `https://api.github.test/repos/teamleaderleo/stensibly/commits/${commitSha}/status?per_page=100&page=1`;

describe("native GitHub delegated combined commit status reads", () => {
  test("reads one exact commit with statuses-only authority and bounded public evidence", async () => {
    const tokens = new RecordingTokenProvider();
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const adapter = createAdapter(tokens, async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return jsonResponse(requestUrl, combinedStatus());
    });

    const called = await adapter.callReadTool(callInput(commitSha.toUpperCase()));

    expect(tokens.requests).toEqual([{
      repositoryFullName,
      permission: { name: "statuses", access: "read" },
    }]);
    expect(requestUrl).toBe(firstUrl);
    expect(requestInit?.redirect).toBe("error");
    expect(new Headers(requestInit?.headers).get("authorization"))
      .toBe("Bearer delegated-token");
    expect(called).toEqual({
      providerRequestId: "TRACE:sk-checks",
      result: {
        repositoryFullName,
        commitSha,
        state: "success",
        totalCount: 1,
        statuses: [{
          id: 777,
          state: "success",
          context: "task-sk-review",
          description: "Run sk-checks",
          targetUrlPresent: true,
          creatorLogin: "sk-checks-bot",
          creatorId: 42,
          createdAt: "2026-07-31T19:41:00.000Z",
          updatedAt: "2026-07-31T19:47:00.000Z",
        }],
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
    expect(Object.isFrozen((called.result as { statuses: unknown[] }).statuses)).toBe(true);
  });

  test("separates caller admission, malformed evidence, and identity mismatch", async () => {
    const tokens = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokens, async (input) => {
      providerCalls += 1;
      return jsonResponse(String(input), combinedStatus());
    });

    await expectCode(
      adapter.callReadTool(callInput("malformed")),
      "github_delegated_adapter_invalid_input",
    );
    expect(tokens.requests).toEqual([]);
    expect(providerCalls).toBe(0);

    const malformedSha = createAdapter(new RecordingTokenProvider(), async (input) =>
      jsonResponse(String(input), { ...combinedStatus(), sha: "malformed" }));
    await expectCode(
      malformedSha.callReadTool(callInput(commitSha)),
      "github_delegated_provider_invalid_response",
    );

    const movedSha = createAdapter(new RecordingTokenProvider(), async (input) =>
      jsonResponse(String(input), { ...combinedStatus(), sha: "e".repeat(40) }));
    await expectCode(
      movedSha.callReadTool(callInput(commitSha)),
      "github_delegated_provider_identity_mismatch",
    );

    const movedRepository = createAdapter(new RecordingTokenProvider(), async (input) =>
      jsonResponse(String(input), {
        ...combinedStatus(),
        repository: { full_name: "teamleaderleo/other" },
      }));
    await expectCode(
      movedRepository.callReadTool(callInput(commitSha)),
      "github_delegated_provider_identity_mismatch",
    );
  });

  test("rejects status, final URL, redirect, and media defects before body reads", async () => {
    const cases: Array<{
      status?: number;
      url?: string;
      redirected?: boolean;
      contentType?: string | null;
      code: string;
    }> = [
      { status: 206, code: "github_delegated_provider_http_error" },
      { url: "", code: "github_delegated_provider_invalid_response" },
      {
        url: firstUrl.replace("stensibly", "other"),
        code: "github_delegated_provider_invalid_response",
      },
      {
        url: firstUrl.replace(commitSha, "e".repeat(40)),
        code: "github_delegated_provider_invalid_response",
      },
      {
        url: firstUrl.replace("&page=1", "&page=2"),
        code: "github_delegated_provider_invalid_response",
      },
      { redirected: true, code: "github_delegated_provider_invalid_response" },
      { contentType: null, code: "github_delegated_provider_invalid_response" },
      {
        contentType: "text/plain",
        code: "github_delegated_provider_invalid_response",
      },
    ];

    for (const entry of cases) {
      const counters = { cancel: 0, getReader: 0, read: 0 };
      const adapter = createAdapter(new RecordingTokenProvider(), async () =>
        controlledResponse(counters, {
          status: entry.status ?? 200,
          url: entry.url ?? firstUrl,
          redirected: entry.redirected ?? false,
          contentType: entry.contentType === undefined
            ? "application/json"
            : entry.contentType,
        }));

      await expectCode(adapter.callReadTool(callInput(commitSha)), entry.code);
      expect(counters).toEqual({ cancel: 1, getReader: 0, read: 0 });
    }
  });

  test("rejects declared overflow before reader acquisition", async () => {
    const counters = { cancel: 0, getReader: 0, read: 0 };
    const adapter = createAdapter(new RecordingTokenProvider(), async () =>
      controlledResponse(counters, {
        status: 200,
        url: firstUrl,
        redirected: false,
        contentType: "application/json",
        contentLength: String(256 * 1024 + 1),
      }));

    await expectCode(
      adapter.callReadTool(callInput(commitSha)),
      "github_delegated_provider_result_too_large",
    );
    expect(counters).toEqual({ cancel: 1, getReader: 0, read: 0 });
  });

  test("uses strict JSON admission for duplicate keys and trailing data", async () => {
    const rawCases = [
      `{"state":"success","state":"failure","sha":"${commitSha}","total_count":0,"statuses":[],"repository":{"full_name":"${repositoryFullName}"}}`,
      `{"state":"success","sha":"${commitSha}","total_count":0,"statuses":[],"repository":{"full_name":"${repositoryFullName}","full_name":"teamleaderleo/other"}}`,
      `{"state":"success","sha":"${commitSha}","total_count":1,"statuses":[{"id":777,"state":"success","context":"ci","context":"other","description":null,"target_url":null,"creator":{"login":"bot","id":42},"created_at":"2026-07-31T19:41:00Z","updated_at":"2026-07-31T19:47:00Z"}],"repository":{"full_name":"${repositoryFullName}"}}`,
      `${JSON.stringify(combinedStatus())} trailing`,
    ];

    for (const raw of rawCases) {
      const adapter = createAdapter(new RecordingTokenProvider(), async (input) =>
        rawResponse(String(input), raw));
      await expectCode(
        adapter.callReadTool(callInput(commitSha)),
        "github_delegated_provider_invalid_response",
      );
    }
  });

  test("admits benign sk prose and rejects credential-shaped evidence", async () => {
    const secret = `sk-proj-${"x".repeat(24)}`;
    const payloads = [
      { ...combinedStatus(), statuses: [{ ...status(), context: secret }] },
      { ...combinedStatus(), statuses: [{ ...status(), description: secret }] },
      {
        ...combinedStatus(),
        statuses: [{ ...status(), creator: { login: secret, id: 42 } }],
      },
      {
        ...combinedStatus(),
        statuses: [{ ...status(), target_url: `https://ci.example/${secret}` }],
      },
    ];
    for (const payload of payloads) {
      const adapter = createAdapter(new RecordingTokenProvider(), async (input) =>
        jsonResponse(String(input), payload));
      await expectCode(
        adapter.callReadTool(callInput(commitSha)),
        "github_delegated_provider_invalid_response",
      );
    }

    const requestId = createAdapter(new RecordingTokenProvider(), async (input) =>
      jsonResponse(String(input), combinedStatus(), {
        "x-github-request-id": secret,
      }));
    await expectCode(
      requestId.callReadTool(callInput(commitSha)),
      "github_delegated_provider_invalid_response",
    );

    const pagination = createAdapter(new RecordingTokenProvider(), async (input) =>
      jsonResponse(String(input), combinedStatus(), {
        link: `<${firstUrl}&trace=${secret}>; rel="next"`,
      }));
    await expectCode(
      pagination.callReadTool(callInput(commitSha)),
      "github_delegated_provider_invalid_response",
    );
  });

  test("paginates inside the accepted request and rejects duplicate contexts", async () => {
    const secondUrl = firstUrl.replace("&page=1", "&page=2");
    const calls: string[] = [];
    const adapter = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === firstUrl) {
        return jsonResponse(url, {
          ...combinedStatus(),
          total_count: 2,
          statuses: [status()],
        }, { link: `<${secondUrl}>; rel="next"` });
      }
      return jsonResponse(url, {
        ...combinedStatus(),
        total_count: 2,
        statuses: [{ ...status(), id: 778, context: "security" }],
      });
    });

    const called = await adapter.callReadTool(callInput(commitSha));
    expect(calls).toEqual([firstUrl, secondUrl]);
    expect((called.result as { totalCount: number }).totalCount).toBe(2);

    const duplicate = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      return url === firstUrl
        ? jsonResponse(url, {
            ...combinedStatus(),
            total_count: 2,
            statuses: [status()],
          }, { link: `<${secondUrl}>; rel="next"` })
        : jsonResponse(url, {
            ...combinedStatus(),
            total_count: 2,
            statuses: [{ ...status(), id: 778, context: "TASK-SK-REVIEW" }],
          });
    });
    await expectCode(
      duplicate.callReadTool(callInput(commitSha)),
      "github_delegated_provider_invalid_response",
    );
  });

  test("preserves inherited repository reads", async () => {
    const tokens = new RecordingTokenProvider();
    const adapter = createAdapter(tokens, async (input) =>
      jsonResponse(String(input), {
        id: 123456,
        node_id: "R_kgDOGitHub",
        full_name: "TeamLeaderLeo/Stensibly",
        private: true,
        archived: false,
        disabled: false,
        visibility: "private",
        default_branch: "main",
        updated_at: "2026-07-31T01:02:03Z",
        pushed_at: "2026-07-31T01:01:00Z",
      }, { "x-github-request-id": "TRACE:repo" }));

    const called = await adapter.callReadTool({
      ...callInput(commitSha),
      tool: "get_repo",
      arguments: Object.freeze({}),
    });
    expect((called.result as { repositoryFullName: string }).repositoryFullName)
      .toBe(repositoryFullName);
    const request = tokens.requests[0];
    expect(request && "permission" in request ? request.permission : null)
      .toEqual({ name: "metadata", access: "read" });
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
      expiresAt: "2026-07-31T21:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): GitHubRestCommitStatusAdapter {
  return new GitHubRestCommitStatusAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
  });
}

function callInput(sha: string) {
  return {
    tool: "get_commit_combined_status",
    arguments: Object.freeze({ commit_sha: sha }),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function combinedStatus() {
  return {
    state: "success",
    sha: commitSha,
    total_count: 1,
    statuses: [status()],
    repository: { full_name: "TeamLeaderLeo/Stensibly" },
  };
}

function status() {
  return {
    id: 777,
    state: "success",
    context: "task-sk-review",
    description: "Run sk-checks",
    target_url: "https://ci.example/task-sk-review",
    creator: { login: "sk-checks-bot", id: 42 },
    created_at: "2026-07-31T19:41:00Z",
    updated_at: "2026-07-31T19:47:00Z",
  };
}

function jsonResponse(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return rawResponse(url, JSON.stringify(payload), headers);
}

function rawResponse(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Response {
  const response = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-github-request-id": "TRACE:sk-checks",
      ...headers,
    },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function controlledResponse(
  counters: { cancel: number; getReader: number; read: number },
  options: {
    status: number;
    url: string;
    redirected: boolean;
    contentType: string | null;
    contentLength?: string;
  },
): Response {
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set("content-type", options.contentType);
  }
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  const body = {
    async cancel() {
      counters.cancel += 1;
    },
    getReader() {
      counters.getReader += 1;
      return {
        async read() {
          counters.read += 1;
          return { done: true, value: undefined };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
  };
  return {
    status: options.status,
    ok: options.status >= 200 && options.status < 300,
    redirected: options.redirected,
    url: options.url,
    headers,
    body,
  } as unknown as Response;
}

async function expectCode(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected rejection code ${expectedCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    expect((error as GitHubProviderRejectedError).code).toBe(expectedCode);
  }
}
