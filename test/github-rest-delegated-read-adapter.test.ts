import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestDelegatedReadAdapter } from "../src/github-rest-delegated-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "b".repeat(40);
const blobSha = "c".repeat(40);

describe("native GitHub delegated repository reads", () => {
  test("gets exact repository metadata with metadata-only authority", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let requestUrl = "";
    const requestHeaders: Headers[] = [];
    const adapter = createAdapter(tokenProvider, async (input, init) => {
      requestUrl = String(input);
      requestHeaders.push(new Headers(init?.headers));
      return Response.json(repositoryPayload(), {
        headers: { "x-github-request-id": "ABC1:1234" },
      });
    });

    const called = await adapter.callReadTool(callInput("get_repo", {}));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "metadata", access: "read" },
    }]);
    expect(requestUrl).toBe(
      "https://api.github.test/repos/teamleaderleo/stensibly",
    );
    expect(requestHeaders[0]?.get("authorization")).toBe("Bearer delegated-token");
    expect(requestHeaders[0]?.get("accept")).toBe("application/vnd.github+json");
    expect(requestHeaders[0]?.get("x-github-api-version")).toBe("2022-11-28");
    expect(called).toEqual({
      providerRequestId: "ABC1:1234",
      result: {
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
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
  });

  test("fetches one immutable bounded file with contents-only authority", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const content = Buffer.from("hello from an immutable commit\n", "utf8");
    let requestUrl = "";
    const adapter = createAdapter(tokenProvider, async (input) => {
      requestUrl = String(input);
      return Response.json({
        type: "file",
        path: "src/file name.ts",
        sha: blobSha,
        size: content.byteLength,
        encoding: "base64",
        content: `${content.toString("base64").slice(0, 12)}\n${content.toString("base64").slice(12)}\n`,
        url: `https://api.github.test/repos/teamleaderleo/stensibly/contents/src/file%20name.ts?ref=${commitSha}`,
        git_url: `https://api.github.test/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      }, {
        headers: { "x-github-request-id": "FILE:1234" },
      });
    });

    const called = await adapter.callReadTool(callInput("fetch_file", {
      path: "src/file name.ts",
      ref: commitSha,
    }));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "contents", access: "read" },
    }]);
    expect(requestUrl).toBe(
      `https://api.github.test/repos/teamleaderleo/stensibly/contents/src/file%20name.ts?ref=${commitSha}`,
    );
    expect(called).toEqual({
      providerRequestId: "FILE:1234",
      result: {
        repositoryFullName,
        path: "src/file name.ts",
        ref: commitSha,
        blobSha,
        size: content.byteLength,
        encoding: "base64",
        contentBase64: content.toString("base64"),
      },
    });
  });

  test("stops binding and unsupported-tool mismatches before token or provider activity", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokenProvider, async () => {
      providerCalls += 1;
      return Response.json(repositoryPayload());
    });

    await expect(adapter.callReadTool({
      ...callInput("get_repo", {}),
      connectionId: "ghconn_other",
    })).rejects.toThrow("did not match its admitted connection binding");
    await expect(adapter.callReadTool({
      ...callInput("get_repo", {}),
      tool: "get_pr_info",
    })).rejects.toThrow("outside the enabled native subset");
    await expect(adapter.callReadTool({
      ...callInput("get_repo", {}),
      arguments: { repository: "other/repo" },
    })).rejects.toThrow("has an unknown field");

    expect(tokenProvider.requests).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  test("rejects repository, path, and provider-owned URL identity mismatches", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const content = Buffer.from("bounded", "utf8");
    const adapter = createAdapter(tokenProvider, async () => Response.json({
      type: "file",
      path: "README.md",
      sha: blobSha,
      size: content.byteLength,
      encoding: "base64",
      content: content.toString("base64"),
      url: `https://api.github.test/repos/teamleaderleo/other/contents/README.md?ref=${commitSha}`,
      git_url: `https://api.github.test/repos/teamleaderleo/other/git/blobs/${blobSha}`,
    }));

    await expect(adapter.callReadTool(callInput("fetch_file", {
      path: "README.md",
      ref: commitSha,
    }))).rejects.toThrow("did not match the accepted repository");

    const pathAdapter = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json({
        type: "file",
        path: "other.md",
        sha: blobSha,
        size: content.byteLength,
        encoding: "base64",
        content: content.toString("base64"),
        url: `https://api.github.test/repos/teamleaderleo/stensibly/contents/other.md`,
        git_url: `https://api.github.test/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      }),
    );
    await expect(pathAdapter.callReadTool(callInput("fetch_file", {
      path: "README.md",
      ref: commitSha,
    }))).rejects.toThrow("path did not match the requested file");

    const repoAdapter = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json({
        ...repositoryPayload(),
        full_name: "teamleaderleo/other",
      }),
    );
    await expect(repoAdapter.callReadTool(callInput("get_repo", {})))
      .rejects.toThrow("did not match the accepted repository");
  });

  test("rejects directories, invalid base64, size mismatches, and explicit file limits", async () => {
    const directory = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json([]),
    );
    await expect(directory.callReadTool(callInput("fetch_file", {
      path: "src",
      ref: commitSha,
    }))).rejects.toThrow("response was not an object");

    for (const payload of [
      {
        type: "file",
        path: "README.md",
        sha: blobSha,
        size: 3,
        encoding: "base64",
        content: "%%%",
      },
      {
        type: "file",
        path: "README.md",
        sha: blobSha,
        size: 10,
        encoding: "base64",
        content: Buffer.from("tiny").toString("base64"),
      },
      {
        type: "file",
        path: "README.md",
        sha: blobSha,
        size: 9,
        encoding: "base64",
        content: Buffer.from("123456789").toString("base64"),
      },
    ]) {
      const adapter = createAdapter(
        new RecordingTokenProvider(),
        async () => Response.json({
          ...payload,
          url: `https://api.github.test/repos/teamleaderleo/stensibly/contents/README.md`,
          git_url: `https://api.github.test/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
        }),
        8,
      );
      await expect(adapter.callReadTool(callInput("fetch_file", {
        path: "README.md",
        ref: commitSha,
      }))).rejects.toBeInstanceOf(Error);
    }
  });

  test("bounds streamed responses before JSON parsing", async () => {
    const tokenProvider = new RecordingTokenProvider();
    const declared = createAdapter(tokenProvider, async () => new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(200_000),
      },
    }));
    await expect(declared.callReadTool(callInput("get_repo", {})))
      .rejects.toThrow("exceeds 131072 bytes");

    const streamed = createAdapter(
      new RecordingTokenProvider(),
      async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(80_000));
          controller.enqueue(new Uint8Array(80_000));
          controller.close();
        },
      }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(streamed.callReadTool(callInput("get_repo", {})))
      .rejects.toThrow("exceeds 131072 bytes");
  });

  test("replaces credential-bearing transport and body-read failures with fixed prose", async () => {
    const bearer = "Bearer delegated-token";
    const providerUrl = "https://api.github.test/repos/teamleaderleo/stensibly";
    const requestFailure = createAdapter(
      new RecordingTokenProvider(),
      async (input, init) => {
        throw new Error(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
      },
    );
    await expectFixedFailure(
      requestFailure.callReadTool(callInput("get_repo", {})),
      "request failed before a response was available",
      [bearer, providerUrl, "delegated-token"],
    );

    const responseFailure = createAdapter(
      new RecordingTokenProvider(),
      async () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          throw new Error(`${bearer} ${providerUrl} provider-cause`);
        },
      }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expectFixedFailure(
      responseFailure.callReadTool(callInput("get_repo", {})),
      "response could not be read",
      [bearer, providerUrl, "delegated-token", "provider-cause"],
    );
  });

  test("maps HTTP failures without reading or publishing provider bodies", async () => {
    const providerSecret = "provider-private-body";
    const adapter = createAdapter(
      new RecordingTokenProvider(),
      async () => new Response(providerSecret, { status: 403 }),
    );

    try {
      await adapter.callReadTool(callInput("get_repo", {}));
      throw new Error("expected provider rejection");
    } catch (error) {
      expect(String(error)).toContain("HTTP 403");
      expect(String(error)).not.toContain(providerSecret);
      expect(String(error)).not.toContain("delegated-token");
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
      expiresAt: "2026-07-31T01:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  maximumFileBytes = 128 * 1024,
): GitHubRestDelegatedReadAdapter {
  return new GitHubRestDelegatedReadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
    maximumFileBytes,
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

function repositoryPayload() {
  return {
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
