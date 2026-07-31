import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestDelegatedReadAdapter } from "../src/github-rest-delegated-read-adapter.ts";
import { stableJson } from "../src/github-provider-validation.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_installation_98765";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "b".repeat(40);
const blobSha = "c".repeat(40);

describe("delegated provider URL and receipt identity", () => {
  test("accepts canonical GitHub repository casing under a GHES API base", async () => {
    const content = Buffer.from("case-bound content", "utf8");
    const adapter = createAdapter(
      async () => Response.json(filePayload(
        content,
        "Docs/Readme.md",
        "https://github.example.test/api/v3/repos/TeamLeaderLeo/Stensibly/contents/Docs/Readme.md",
        `https://github.example.test/api/v3/repos/TeamLeaderLeo/Stensibly/git/blobs/${blobSha}`,
      )),
      "https://github.example.test/api/v3",
    );

    const called = await adapter.callReadTool(callInput("Docs/Readme.md"));

    expect(called.result).toEqual({
      repositoryFullName,
      path: "Docs/Readme.md",
      ref: commitSha,
      blobSha,
      size: content.byteLength,
      encoding: "base64",
      contentBase64: content.toString("base64"),
    });
  });

  test("keeps provider-owned file path casing exact", async () => {
    const content = Buffer.from("case-bound content", "utf8");
    const adapter = createAdapter(async () => Response.json(filePayload(
      content,
      "Docs/Readme.md",
      "https://api.github.test/repos/TeamLeaderLeo/Stensibly/contents/docs/Readme.md",
      `https://api.github.test/repos/TeamLeaderLeo/Stensibly/git/blobs/${blobSha}`,
    )));

    await expect(adapter.callReadTool(callInput("Docs/Readme.md")))
      .rejects.toThrow("did not match the accepted repository");
  });

  test("caps retained files so the generic delegated receipt remains below 256 KiB", async () => {
    const content = Buffer.alloc(128 * 1024, 97);
    const adapter = createAdapter(async () => Response.json(filePayload(
      content,
      "large.txt",
      "https://api.github.test/repos/teamleaderleo/stensibly/contents/large.txt",
      `https://api.github.test/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
    )));

    const called = await adapter.callReadTool(callInput("large.txt"));

    expect(Buffer.byteLength(stableJson(called.result), "utf8"))
      .toBeLessThan(256 * 1024);
    expect(() => new GitHubRestDelegatedReadAdapter({
      connectionId,
      installationId,
      credentialRef,
      tokenProvider: new TokenProvider(),
      apiBaseUrl: "https://api.github.test",
      maximumFileBytes: 128 * 1024 + 1,
    })).toThrow("between 1 and 131072");
  });

  test("rejects direct and namespaced credential-shaped request identities", async () => {
    const content = Buffer.from("request identity", "utf8");
    for (const requestId of [
      "github_pat_private",
      "trace.ghp_private",
      "trace:stn.tok_private",
      "trace/sk-proj-private",
      "trace:xoxb-private",
      "trace:env://PRIVATE_TOKEN",
      "trace-secret://github/private",
    ]) {
      const adapter = createAdapter(async () => Response.json(filePayload(
        content,
        "README.md",
        "https://api.github.test/repos/teamleaderleo/stensibly/contents/README.md",
        `https://api.github.test/repos/teamleaderleo/stensibly/git/blobs/${blobSha}`,
      ), {
        headers: { "x-github-request-id": requestId },
      }));

      await expect(adapter.callReadTool(callInput("README.md")))
        .rejects.toThrow("request identity was invalid");
    }
  });
});

class TokenProvider implements GitHubInstallationTokenProvider {
  async getInstallationToken(
    _input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    return {
      token: "delegated-token",
      expiresAt: "2026-07-31T01:00:00.000Z",
    };
  }
}

function createAdapter(
  implementation: () => Promise<Response>,
  apiBaseUrl = "https://api.github.test",
): GitHubRestDelegatedReadAdapter {
  return new GitHubRestDelegatedReadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider: new TokenProvider(),
    apiBaseUrl,
    fetch: implementation as unknown as typeof fetch,
  });
}

function callInput(path: string) {
  return {
    tool: "fetch_file",
    arguments: Object.freeze({ path, ref: commitSha }),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function filePayload(
  content: Buffer,
  path: string,
  url: string,
  gitUrl: string,
) {
  return {
    type: "file",
    path,
    sha: blobSha,
    size: content.byteLength,
    encoding: "base64",
    content: content.toString("base64"),
    url,
    git_url: gitUrl,
  };
}