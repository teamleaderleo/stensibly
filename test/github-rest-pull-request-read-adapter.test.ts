import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestPullRequestReadAdapter } from "../src/github-rest-pull-request-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const pullRequestNumber = 42;
const headSha = "d".repeat(40);
const baseSha = "e".repeat(40);
const mergeCommitSha = "f".repeat(40);

describe("native GitHub delegated pull request reads", () => {
  test("gets exact pull request metadata with pull-request-only authority", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let requestUrl = "";
    const requestHeaders: Headers[] = [];
    const adapter = createAdapter(tokenProvider, async (input, init) => {
      requestUrl = String(input);
      requestHeaders.push(new Headers(init?.headers));
      return Response.json(pullRequestPayload(), {
        headers: { "x-github-request-id": "PRINFO:1234" },
      });
    });

    const called = await adapter.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
    expect(requestUrl).toBe(
      "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42",
    );
    expect(requestHeaders[0]?.get("authorization")).toBe(
      "Bearer delegated-token",
    );
    expect(requestHeaders[0]?.get("accept")).toBe(
      "application/vnd.github+json",
    );
    expect(requestHeaders[0]?.get("x-github-api-version")).toBe(
      "2022-11-28",
    );
    expect(called).toEqual({
      providerRequestId: "PRINFO:1234",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        id: 987654,
        nodeId: "PR_kwDOGitHub",
        state: "open",
        draft: false,
        locked: false,
        merged: false,
        title: "Add one guarded pull request read",
        authorLogin: "teamleaderleo",
        headRepositoryFullName: repositoryFullName,
        headSha,
        headRef: "sable/697-pr-info-native-read",
        baseSha,
        baseRef: "main",
        mergeCommitSha: null,
        createdAt: "2026-07-31T02:00:00.000Z",
        updatedAt: "2026-07-31T02:05:00.000Z",
        closedAt: null,
        mergedAt: null,
        additions: 120,
        deletions: 12,
        changedFiles: 2,
        commits: 1,
        reviewComments: 3,
        comments: 4,
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
  });

  test("preserves same-repository, fork, and deleted head repository identity", async () => {
    const fork = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json({
        ...pullRequestPayload(),
        head: {
          ...(pullRequestPayload().head as Record<string, unknown>),
          repo: { full_name: "Contributor/Stensibly-Fork" },
        },
      }),
    );
    const forkResult = await fork.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }));
    expect((forkResult.result as Record<string, unknown>).headRepositoryFullName)
      .toBe("contributor/stensibly-fork");

    const deleted = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json({
        ...pullRequestPayload(),
        head: {
          ...(pullRequestPayload().head as Record<string, unknown>),
          repo: null,
        },
      }),
    );
    const deletedResult = await deleted.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }));
    expect((deletedResult.result as Record<string, unknown>).headRepositoryFullName)
      .toBeNull();
  });

  test("delegates the landed repository reads unchanged", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const adapter = createAdapter(tokenProvider, async () => Response.json({
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

    const called = await adapter.callReadTool(callInput("get_repo", {}));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "metadata", access: "read" },
    }]);
    expect(called.result).toEqual({
      repositoryFullName,
      id: 123456,
      nodeId: "R_kgDOGitHub",
      private: true,
      archived: false,
      disabled: false,
      visibility: "private",
      defaultBranch: "main",
      updatedAt: "2026-07-31T01:02:03.000Z",
      pushedAt: "2026-07-31T01:01:00.000Z",
    });
  });

  test("rejects pull request and base repository identity mismatches", async () => {
    const numberMismatch = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json({
        ...pullRequestPayload(),
        number: pullRequestNumber + 1,
      }),
    );
    await expect(numberMismatch.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }))).rejects.toThrow("did not match the requested pull request");

    const baseMismatch = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json({
        ...pullRequestPayload(),
        base: {
          ...(pullRequestPayload().base as Record<string, unknown>),
          repo: { full_name: "teamleaderleo/other" },
        },
      }),
    );
    await expect(baseMismatch.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }))).rejects.toThrow("did not match the accepted repository");
  });

  test("requires an exact credential-free provider API URL", async () => {
    for (const url of [
      "https://user:pass@api.github.test/repos/teamleaderleo/stensibly/pulls/42",
      "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42?page=1",
      "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42#fragment",
      "https://api.github.test/repos/teamleaderleo/other/pulls/42",
    ]) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => Response.json({
          ...pullRequestPayload(),
          url,
        }),
      );
      await expect(adapter.callReadTool(callInput("get_pr_info", {
        pr_number: pullRequestNumber,
      }))).rejects.toThrow("did not match the accepted repository");
    }
  });

  test("stops binding, argument, accessor, and unsupported-tool failures before activity", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokenProvider, async () => {
      providerCalls += 1;
      return Response.json(pullRequestPayload());
    });

    await expect(adapter.callReadTool({
      ...callInput("get_pr_info", { pr_number: pullRequestNumber }),
      connectionId: "ghconn_other",
    })).rejects.toThrow("did not match its admitted connection binding");
    await expect(adapter.callReadTool(callInput("get_pr_info", {
      pr_number: 0,
    }))).rejects.toThrow("must be a positive integer");
    await expect(adapter.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
      owner: "other",
    }))).rejects.toThrow("has an unknown field");
    await expect(adapter.callReadTool(callInput("get_pr_diff", {
      pr_number: pullRequestNumber,
      format: "diff",
    }))).rejects.toThrow("outside the enabled native subset");

    let getterCalls = 0;
    const hostile = callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    });
    Object.defineProperty(hostile, "tool", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "get_pr_info";
      },
    });
    await expect(adapter.callReadTool(hostile))
      .rejects.toThrow("fields must be enumerable data properties");

    expect(getterCalls).toBe(0);
    expect(tokenProvider.requests).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  test("bounds declared responses and disposes bodies without reading", async () => {
    for (const fixture of [
      controlledResponse({
        headers: {
          "content-type": "application/json",
          "content-length": String(200_000),
        },
      }),
      controlledResponse({
        headers: {
          "content-type": "application/json",
          "content-length": "12x",
        },
      }),
      controlledResponse({
        headers: { "content-type": "text/plain" },
      }),
    ]) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => fixture.response,
      );
      await expect(adapter.callReadTool(callInput("get_pr_info", {
        pr_number: pullRequestNumber,
      }))).rejects.toBeInstanceOf(Error);
      expect(fixture.cancellations()).toBe(1);
      expect(fixture.readerCalls()).toBe(0);
    }
  });

  test("rejects merged-null-SHA and reversed lifecycle timestamps", async () => {
    for (const payload of [
      {
        ...pullRequestPayload(),
        state: "closed",
        closed_at: "2026-07-31T02:06:00Z",
        updated_at: "2026-07-31T02:07:00Z",
        merged: true,
        merged_at: "2026-07-31T02:06:00Z",
        merge_commit_sha: null,
      },
      {
        ...pullRequestPayload(),
        updated_at: "2026-07-31T01:59:59Z",
      },
      {
        ...pullRequestPayload(),
        state: "closed",
        closed_at: "2026-07-31T01:59:59Z",
      },
    ]) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => Response.json(payload),
      );
      await expect(adapter.callReadTool(callInput("get_pr_info", {
        pr_number: pullRequestNumber,
      }))).rejects.toThrow("lifecycle fields were inconsistent");
    }
  });

  test("allows an unmerged pull request to retain GitHub test-merge identity", async () => {
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json({
        ...pullRequestPayload(),
        merge_commit_sha: mergeCommitSha,
      }),
    );
    const called = await adapter.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }));
    expect((called.result as Record<string, unknown>).mergeCommitSha)
      .toBe(mergeCommitSha);
  });

  test("maps HTTP failures after body disposal and preserves status if disposal fails", async () => {
    const ordinary = controlledResponse({ status: 403 });
    const ordinaryAdapter = createAdapter(
      new RecordingTokenProvider(),
      async () => ordinary.response,
    );
    await expectFixedFailure(
      ordinaryAdapter.callReadTool(callInput("get_pr_info", {
        pr_number: pullRequestNumber,
      })),
      "HTTP 403",
      ["delegated-token"],
    );
    expect(ordinary.cancellations()).toBe(1);
    expect(ordinary.readerCalls()).toBe(0);

    const failingCancel = controlledResponse({
      status: 403,
      cancelRejects: true,
    });
    const failingCancelAdapter = createAdapter(
      new RecordingTokenProvider(),
      async () => failingCancel.response,
    );
    await expectFixedFailure(
      failingCancelAdapter.callReadTool(callInput("get_pr_info", {
        pr_number: pullRequestNumber,
      })),
      "HTTP 403",
      ["cancel-private-cause", "delegated-token"],
    );
    expect(failingCancel.cancellations()).toBe(1);
    expect(failingCancel.readerCalls()).toBe(0);
  });

  test("rejects credential-shaped provider request identities", async () => {
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json(pullRequestPayload(), {
        headers: { "x-github-request-id": "trace_github_pat_example" },
      }),
    );

    await expect(adapter.callReadTool(callInput("get_pr_info", {
      pr_number: pullRequestNumber,
    }))).rejects.toThrow("provider request identity was invalid");
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
      expiresAt: "2026-07-31T03:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubRestPullRequestReadAdapter {
  return new GitHubRestPullRequestReadAdapter({
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

function pullRequestPayload(): Record<string, unknown> {
  return {
    id: 987654,
    node_id: "PR_kwDOGitHub",
    number: pullRequestNumber,
    state: "open",
    locked: false,
    title: "Add one guarded pull request read",
    user: { login: "teamleaderleo" },
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: {
      ref: "sable/697-pr-info-native-read",
      sha: headSha,
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    base: {
      ref: "main",
      sha: baseSha,
      repo: { full_name: "TeamLeaderLeo/Stensibly" },
    },
    url: "https://api.github.test/repos/TeamLeaderLeo/Stensibly/pulls/42",
    created_at: "2026-07-31T02:00:00Z",
    updated_at: "2026-07-31T02:05:00Z",
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
}) {
  let cancellationCount = 0;
  let readerCallCount = 0;
  const status = options.status ?? 200;
  const response = {
    ok: status >= 200 && status < 300,
    status,
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

async function expectFixedFailure(
  promise: Promise<unknown>,
  expected: string,
  forbidden: string[],
): Promise<void> {
  try {
    await promise;
    throw new Error("expected fixed failure");
  } catch (error) {
    expect(String(error)).toContain(expected);
    for (const secret of forbidden) {
      expect(String(error)).not.toContain(secret);
    }
  }
}
