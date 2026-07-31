import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestCommitStatusAdapter } from "../src/github-rest-commit-status-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "d".repeat(40);

describe("native GitHub delegated combined commit status reads", () => {
  test("reads an exact commit with statuses-only authority and frozen output", async () => {
    const tokens = new RecordingTokenProvider();
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const adapter = createAdapter(tokens, async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json(statusPayload([
        statusPayloadEntry(1, "success", "ci/test"),
        statusPayloadEntry(2, "pending", "review/security"),
      ], "pending"), {
        headers: { "x-github-request-id": "STATUS:1234" },
      });
    });

    const called = await adapter.callReadTool(callInput({
      commit_sha: commitSha.toUpperCase(),
    }));

    expect(tokens.requests).toEqual([{
      repositoryFullName,
      permission: { name: "statuses", access: "read" },
    }]);
    expect(requestUrl).toBe(
      `https://api.github.test/repos/teamleaderleo/stensibly/commits/${commitSha}/status?per_page=100&page=1`,
    );
    expect(requestInit?.redirect).toBe("error");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer delegated-token");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(called).toEqual({
      providerRequestId: "STATUS:1234",
      result: {
        repositoryFullName,
        commitSha,
        state: "pending",
        totalCount: 2,
        statuses: [
          {
            id: 1,
            state: "success",
            context: "ci/test",
            description: "Deterministic status ci/test",
            targetUrlPresent: true,
            creatorLogin: "github-actions",
            creatorId: 41898282,
            createdAt: "2026-07-31T12:00:00.000Z",
            updatedAt: "2026-07-31T12:01:00.000Z",
          },
          {
            id: 2,
            state: "pending",
            context: "review/security",
            description: "Deterministic status review/security",
            targetUrlPresent: true,
            creatorLogin: "github-actions",
            creatorId: 41898282,
            createdAt: "2026-07-31T12:00:00.000Z",
            updatedAt: "2026-07-31T12:01:00.000Z",
          },
        ],
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
    expect(Object.isFrozen((called.result as { statuses: unknown[] }).statuses)).toBe(true);
  });

  test("follows bounded same-origin pagination and preserves first request identity", async () => {
    const requests: string[] = [];
    const adapter = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("page=1")) {
        return Response.json(statusPayload([
          statusPayloadEntry(1, "success", "ci/test"),
        ], "success", 2), {
          headers: {
            link: `<https://api.github.test/repos/teamleaderleo/stensibly/commits/${commitSha}/status?per_page=100&page=2>; rel="next"`,
            "x-github-request-id": "STATUS:FIRST",
          },
        });
      }
      return Response.json(statusPayload([
        statusPayloadEntry(2, "success", "review/security"),
      ], "success", 2), {
        headers: { "x-github-request-id": "STATUS:SECOND" },
      });
    });

    const called = await adapter.callReadTool(callInput({ commit_sha: commitSha }));

    expect(requests).toHaveLength(2);
    expect(called.providerRequestId).toBe("STATUS:FIRST");
    expect((called.result as { totalCount: number }).totalCount).toBe(2);
  });

  test("rejects binding, arguments, and accessors before token or provider activity", async () => {
    const tokens = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokens, async () => {
      providerCalls += 1;
      return Response.json(statusPayload([], "pending"));
    });

    await expect(adapter.callReadTool({
      ...callInput({ commit_sha: commitSha }),
      connectionId: "ghconn_other",
    })).rejects.toThrow("did not match its admitted connection binding");
    await expect(adapter.callReadTool(callInput({ commit_sha: "main" })))
      .rejects.toThrow("exactly 40 hexadecimal characters");
    await expect(adapter.callReadTool(callInput({
      commit_sha: commitSha,
      owner: "other",
    }))).rejects.toThrow("unknown field");

    let getters = 0;
    const hostile = callInput({ commit_sha: commitSha });
    Object.defineProperty(hostile, "tool", {
      enumerable: true,
      get() {
        getters += 1;
        return "get_commit_combined_status";
      },
    });
    await expect(adapter.callReadTool(hostile))
      .rejects.toThrow("enumerable data properties");

    expect(getters).toBe(0);
    expect(tokens.requests).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  test("rejects commit and repository identity mismatches", async () => {
    for (const payload of [
      { ...statusPayload([], "pending"), sha: "e".repeat(40) },
      {
        ...statusPayload([], "pending"),
        repository: { full_name: "teamleaderleo/other" },
      },
    ]) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => Response.json(payload),
      );
      await expect(adapter.callReadTool(callInput({ commit_sha: commitSha })))
        .rejects.toThrow("did not match");
    }
  });

  test("rejects duplicate contexts, inconsistent counts, and reversed timestamps", async () => {
    const fixtures = [
      statusPayload([
        statusPayloadEntry(1, "success", "CI/Test"),
        statusPayloadEntry(2, "success", "ci/test"),
      ], "success"),
      statusPayload([statusPayloadEntry(1, "success", "ci/test")], "success", 2),
      statusPayload([{
        ...statusPayloadEntry(1, "success", "ci/test"),
        created_at: "2026-07-31T12:02:00Z",
        updated_at: "2026-07-31T12:01:00Z",
      }], "success"),
    ];
    for (const fixture of fixtures) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => Response.json(fixture),
      );
      await expect(adapter.callReadTool(callInput({ commit_sha: commitSha })))
        .rejects.toBeInstanceOf(Error);
    }
  });

  test("rejects pagination escape, repeated cursor, redirects, and credential-shaped request IDs", async () => {
    const escaped = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json(statusPayload([], "pending"), {
        headers: {
          link: `<https://evil.example/repos/teamleaderleo/stensibly/commits/${commitSha}/status?per_page=100&page=2>; rel="next"`,
        },
      }),
    );
    await expect(escaped.callReadTool(callInput({ commit_sha: commitSha })))
      .rejects.toThrow("escaped the accepted request");

    const repeatedUrl = `https://api.github.test/repos/teamleaderleo/stensibly/commits/${commitSha}/status?per_page=100&page=1`;
    const repeated = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json(statusPayload([], "pending"), {
        headers: { link: `<${repeatedUrl}>; rel="next"` },
      }),
    );
    await expect(repeated.callReadTool(callInput({ commit_sha: commitSha })))
      .rejects.toThrow("pagination was invalid");

    const redirected = createAdapter(
      new RecordingTokenProvider(),
      async () => redirectedResponse(statusPayload([], "pending")),
    );
    await expect(redirected.callReadTool(callInput({ commit_sha: commitSha })))
      .rejects.toThrow("redirected");

    const secretId = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json(statusPayload([], "pending"), {
        headers: { "x-github-request-id": "trace_github_pat_example" },
      }),
    );
    await expect(secretId.callReadTool(callInput({ commit_sha: commitSha })))
      .rejects.toThrow("request identity was invalid");
  });

  test("bounds declared and streamed responses with fixed failures", async () => {
    const declared = controlledResponse({
      headers: {
        "content-type": "application/json",
        "content-length": String(300_000),
      },
    });
    const declaredAdapter = createAdapter(
      new RecordingTokenProvider(),
      async () => declared.response,
    );
    await expectFixedFailure(
      declaredAdapter.callReadTool(callInput({ commit_sha: commitSha })),
      "exceeds 262144 bytes",
    );
    expect(declared.cancellations()).toBe(1);
    expect(declared.readerCalls()).toBe(0);

    const failedRead = controlledResponse({ readRejects: true });
    const failedReadAdapter = createAdapter(
      new RecordingTokenProvider(),
      async () => failedRead.response,
    );
    await expectFixedFailure(
      failedReadAdapter.callReadTool(callInput({ commit_sha: commitSha })),
      "could not be read",
    );
  });

  test("delegates the landed repository read unchanged", async () => {
    const tokens = new RecordingTokenProvider();
    const adapter = createAdapter(tokens, async () => Response.json({
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
    }));

    const called = await adapter.callReadTool({
      ...callInput({}),
      tool: "get_repo",
    });

    const firstRequest = tokens.requests[0] as {
      permission?: { name: string; access: string };
    } | undefined;
    expect(firstRequest?.permission).toEqual({ name: "metadata", access: "read" });
    expect((called.result as { repositoryFullName: string }).repositoryFullName)
      .toBe(repositoryFullName);
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
      expiresAt: "2026-07-31T13:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
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

function callInput(argumentsValue: Record<string, unknown>) {
  return {
    tool: "get_commit_combined_status",
    arguments: Object.freeze(argumentsValue),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function statusPayload(
  statuses: Record<string, unknown>[],
  state: "error" | "failure" | "pending" | "success",
  totalCount = statuses.length,
): Record<string, unknown> {
  return {
    state,
    sha: commitSha,
    total_count: totalCount,
    repository: { full_name: "TeamLeaderLeo/Stensibly" },
    statuses,
  };
}

function statusPayloadEntry(
  id: number,
  state: "error" | "failure" | "pending" | "success",
  context: string,
): Record<string, unknown> {
  return {
    id,
    state,
    context,
    description: `Deterministic status ${context}`,
    target_url: `https://ci.example.test/status/${id}`,
    creator: { login: "github-actions", id: 41898282 },
    created_at: "2026-07-31T12:00:00Z",
    updated_at: "2026-07-31T12:01:00Z",
  };
}

function redirectedResponse(payload: unknown): Response {
  const response = Response.json(payload);
  Object.defineProperty(response, "redirected", { value: true });
  return response;
}

function controlledResponse(options: {
  status?: number;
  headers?: Record<string, string>;
  readRejects?: boolean;
}) {
  let cancellations = 0;
  let readerCalls = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      readerCalls += 1;
      if (options.readRejects) {
        controller.error(new Error("provider-private-read-cause"));
        return;
      }
      controller.enqueue(encoder.encode(JSON.stringify(statusPayload([], "pending"))));
      controller.close();
    },
    cancel() {
      cancellations += 1;
    },
  });
  const response = new Response(body, {
    status: options.status ?? 200,
    headers: options.headers ?? { "content-type": "application/json" },
  });
  return {
    response,
    cancellations: () => cancellations,
    readerCalls: () => readerCalls,
  };
}

async function expectFixedFailure(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected delegated read failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;
    expect(text).toContain(message);
    expect(text).not.toContain("delegated-token");
    expect(text).not.toContain("provider-private-read-cause");
  }
}
