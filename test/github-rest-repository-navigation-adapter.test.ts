import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";
import { GitHubRestRepositoryNavigationAdapter } from "../src/github-rest-repository-navigation-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_navigation_98765";
const installationId = "98765";
const credentialRef = "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "b".repeat(40);
const blobSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const tagSha = "e".repeat(40);
const nestedTagSha = "f".repeat(40);

describe("native GitHub repository navigation reads", () => {
  test("lists an immutable root directory with contents-only authority", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let requestUrl = "";
    const adapter = createAdapter(tokenProvider, async (input, init) => {
      requestUrl = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer navigation-token");
      return Response.json([
        directoryPayload("src", "dir", treeSha, 0),
        directoryPayload("README.md", "file", blobSha, 321),
      ], { headers: { "x-github-request-id": "DIR:ROOT" } });
    });

    const called = await adapter.callReadTool(callInput("list_directory", {
      path: "",
      ref: commitSha,
    }));

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "contents", access: "read" },
    }]);
    expect(requestUrl).toBe(
      `https://api.github.test/repos/teamleaderleo/stensibly/contents?ref=${commitSha}`,
    );
    expect(called).toEqual({
      providerRequestId: "DIR:ROOT",
      result: {
        repositoryFullName,
        path: "",
        commitSha,
        entries: [
          { name: "README.md", path: "README.md", type: "file", objectSha: blobSha, size: 321 },
          { name: "src", path: "src", type: "dir", objectSha: treeSha, size: null },
        ],
        truncated: false,
      },
    });
    expect(Object.isFrozen(called)).toBe(true);
    expect(Object.isFrozen(called.result)).toBe(true);
  });

  test("lists nested and empty directories without guessing mutable refs", async () => {
    const urls: string[] = [];
    const adapter = createAdapter(new RecordingTokenProvider(), async (input) => {
      urls.push(String(input));
      return Response.json(urls.length === 1
        ? [directoryPayload("src/providers/index.ts", "file", blobSha, 10)]
        : []);
    });

    const nested = await adapter.callReadTool(callInput("list_directory", {
      path: "src/providers",
      ref: commitSha,
    }));
    const empty = await adapter.callReadTool(callInput("list_directory", {
      path: "empty",
      ref: commitSha,
    }));

    expect(urls).toEqual([
      `https://api.github.test/repos/teamleaderleo/stensibly/contents/src/providers?ref=${commitSha}`,
      `https://api.github.test/repos/teamleaderleo/stensibly/contents/empty?ref=${commitSha}`,
    ]);
    expect(nested.result).toMatchObject({
      path: "src/providers",
      entries: [{ path: "src/providers/index.ts" }],
    });
    expect(empty.result).toMatchObject({ path: "empty", entries: [] });
  });

  test("rejects directory count, duplicate, type, and path identity violations", async () => {
    const tooMany = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json([
        directoryPayload("a", "file", blobSha, 1),
        directoryPayload("b", "file", treeSha, 1),
      ]),
      1,
    );
    await expectCode(
      tooMany.callReadTool(callInput("list_directory", { path: "", ref: commitSha })),
      "github_delegated_provider_result_too_large",
    );

    const duplicate = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json([
        directoryPayload("README.md", "file", blobSha, 1),
        directoryPayload("README.md", "file", blobSha, 1),
      ]),
    );
    await expectCode(
      duplicate.callReadTool(callInput("list_directory", { path: "", ref: commitSha })),
      "github_delegated_provider_invalid_response",
    );

    const unknownType = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json([{ ...directoryPayload("README.md", "file", blobSha, 1), type: "socket" }]),
    );
    await expectCode(
      unknownType.callReadTool(callInput("list_directory", { path: "", ref: commitSha })),
      "github_delegated_provider_invalid_response",
    );

    const wrongParent = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json([directoryPayload("other/file.ts", "file", blobSha, 1)]),
    );
    await expectCode(
      wrongParent.callReadTool(callInput("list_directory", { path: "src", ref: commitSha })),
      "github_delegated_provider_identity_mismatch",
    );
  });

  test("resolves one fully-qualified branch to its exact commit", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let requestUrl = "";
    const adapter = createAdapter(tokenProvider, async (input) => {
      requestUrl = String(input);
      return Response.json(refPayload("refs/heads/feature/navigation", "commit", commitSha), {
        headers: { "x-github-request-id": "REF:BRANCH" },
      });
    });

    const called = await adapter.callReadTool(callInput("resolve_ref", {
      ref: "refs/heads/feature/navigation",
    }));

    expect(requestUrl).toBe(
      "https://api.github.test/repos/teamleaderleo/stensibly/git/ref/heads/feature/navigation",
    );
    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "contents", access: "read" },
    }]);
    expect(called).toEqual({
      providerRequestId: "REF:BRANCH",
      result: {
        repositoryFullName,
        ref: "refs/heads/feature/navigation",
        refType: "branch",
        refObjectSha: commitSha,
        commitSha,
        peeledTagDepth: 0,
      },
    });
  });

  test("preserves tag namespace and peels annotated tags to a commit", async () => {
    const urls: string[] = [];
    const adapter = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/git/ref/tags/v1.0.0")) {
        return Response.json(refPayload("refs/tags/v1.0.0", "tag", tagSha), {
          headers: { "x-github-request-id": "REF:TAG" },
        });
      }
      if (url.endsWith(`/git/tags/${tagSha}`)) {
        return Response.json(tagPayload(tagSha, "tag", nestedTagSha), {
          headers: { "x-github-request-id": "TAG:1" },
        });
      }
      return Response.json(tagPayload(nestedTagSha, "commit", commitSha), {
        headers: { "x-github-request-id": "TAG:2" },
      });
    });

    const called = await adapter.callReadTool(callInput("resolve_ref", {
      ref: "refs/tags/v1.0.0",
    }));

    expect(urls).toEqual([
      "https://api.github.test/repos/teamleaderleo/stensibly/git/ref/tags/v1.0.0",
      `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${tagSha}`,
      `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${nestedTagSha}`,
    ]);
    expect(called).toEqual({
      providerRequestId: "TAG:2",
      result: {
        repositoryFullName,
        ref: "refs/tags/v1.0.0",
        refType: "tag",
        refObjectSha: tagSha,
        commitSha,
        peeledTagDepth: 2,
      },
    });
  });

  test("rejects ref identity mismatch and cyclic tag chains", async () => {
    const mismatch = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json(refPayload("refs/heads/other", "commit", commitSha)),
    );
    await expectCode(
      mismatch.callReadTool(callInput("resolve_ref", { ref: "refs/heads/main" })),
      "github_delegated_provider_identity_mismatch",
    );

    const cycle = createAdapter(new RecordingTokenProvider(), async (input) => {
      const url = String(input);
      return url.endsWith("/git/ref/tags/cycle")
        ? Response.json(refPayload("refs/tags/cycle", "tag", tagSha))
        : Response.json(tagPayload(tagSha, "tag", tagSha));
    });
    await expectCode(
      cycle.callReadTool(callInput("resolve_ref", { ref: "refs/tags/cycle" })),
      "github_delegated_provider_invalid_response",
    );
  });

  test("invalid refs and binding mismatches perform zero token or provider activity", async () => {
    const tokenProvider = new RecordingTokenProvider();
    let providerCalls = 0;
    const adapter = createAdapter(tokenProvider, async () => {
      providerCalls += 1;
      return Response.json({});
    });

    await expectCode(
      adapter.callReadTool(callInput("resolve_ref", { ref: "main" })),
      "github_delegated_provider_invalid_request",
    );
    await expectCode(
      adapter.callReadTool({ ...callInput("resolve_ref", { ref: "refs/heads/main" }), connectionId: "other" }),
      "github_delegated_adapter_binding_mismatch",
    );
    expect(tokenProvider.requests).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  test("rejects credential-shaped request IDs and bounds response bytes", async () => {
    const credentialId = createAdapter(
      new RecordingTokenProvider(),
      async () => Response.json([], { headers: { "x-github-request-id": "github_pat_abcdefghijklmnopqrstuvwxyz" } }),
    );
    await expectCode(
      credentialId.callReadTool(callInput("list_directory", { path: "", ref: commitSha })),
      "github_delegated_provider_invalid_response",
    );

    const oversized = createAdapter(
      new RecordingTokenProvider(),
      async () => new Response("[]", {
        headers: {
          "content-type": "application/json",
          "content-length": String(600_000),
        },
      }),
    );
    await expectCode(
      oversized.callReadTool(callInput("list_directory", { path: "", ref: commitSha })),
      "github_delegated_provider_result_too_large",
    );
  });
});

class RecordingTokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "navigation-token",
      expiresAt: "2026-08-15T12:00:00.000Z",
    };
  }
}

function createAdapter(
  tokenProvider: GitHubInstallationTokenProvider,
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  maximumDirectoryEntries = 256,
): GitHubRestRepositoryNavigationAdapter {
  return new GitHubRestRepositoryNavigationAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as typeof fetch,
    maximumDirectoryEntries,
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

function directoryPayload(
  path: string,
  type: "file" | "dir" | "symlink" | "submodule",
  sha: string,
  size: number,
) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    type,
    sha,
    size,
    url: `https://api.github.test/repos/teamleaderleo/stensibly/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commitSha}`,
  };
}

function refPayload(
  ref: string,
  type: "commit" | "tag",
  sha: string,
) {
  const tail = ref.slice("refs/".length);
  return {
    ref,
    url: `https://api.github.test/repos/teamleaderleo/stensibly/git/refs/${tail}`,
    object: {
      type,
      sha,
      url: type === "commit"
        ? `https://api.github.test/repos/teamleaderleo/stensibly/git/commits/${sha}`
        : `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${sha}`,
    },
  };
}

function tagPayload(
  sha: string,
  targetType: "commit" | "tag",
  targetSha: string,
) {
  return {
    sha,
    url: `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${sha}`,
    object: {
      type: targetType,
      sha: targetSha,
      url: targetType === "commit"
        ? `https://api.github.test/repos/teamleaderleo/stensibly/git/commits/${targetSha}`
        : `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${targetSha}`,
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    expect((error as GitHubProviderRejectedError).code).toBe(code);
  }
}
