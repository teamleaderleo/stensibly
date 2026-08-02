import { describe, expect, test } from "bun:test";
import {
  GitHubOfficialMcpPullRequestAdapter,
  type GitHubOfficialMcpPullRequestTransport,
} from "../src/github-official-mcp-pull-request-adapter.ts";
import {
  GitHubOfficialMcpRemoteError,
  type GitHubOfficialMcpRemoteCallInput,
  type GitHubOfficialMcpRemoteCallResult,
  type GitHubOfficialMcpRemoteErrorCode,
} from "../src/github-official-mcp-remote-transport.ts";
import { GitHubProviderRejectedError } from "../src/github-provider-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_official_mcp";
const installationId = "98765";
const credentialRef = "secret://github/official-mcp";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const pullRequestNumber = 42;
const secret = `github_pat_${"z".repeat(32)}`;

class HostileEnvelopeTransport implements GitHubOfficialMcpPullRequestTransport {
  getterCalls = 0;

  async callMappedRead(
    _input: GitHubOfficialMcpRemoteCallInput,
  ): Promise<GitHubOfficialMcpRemoteCallResult> {
    const envelope = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(envelope, "result", {
      enumerable: true,
      get: () => {
        this.getterCalls += 1;
        return minimalPullRequestPayload();
      },
    });
    return envelope as unknown as GitHubOfficialMcpRemoteCallResult;
  }
}

class DecoratedEnvelopeTransport implements GitHubOfficialMcpPullRequestTransport {
  async callMappedRead(
    _input: GitHubOfficialMcpRemoteCallInput,
  ): Promise<GitHubOfficialMcpRemoteCallResult> {
    const envelope = { result: minimalPullRequestPayload() };
    Object.defineProperty(envelope, "hidden", {
      enumerable: false,
      value: secret,
    });
    return envelope as unknown as GitHubOfficialMcpRemoteCallResult;
  }
}

class FailingTransport implements GitHubOfficialMcpPullRequestTransport {
  constructor(readonly code: GitHubOfficialMcpRemoteErrorCode) {}

  async callMappedRead(
    _input: GitHubOfficialMcpRemoteCallInput,
  ): Promise<GitHubOfficialMcpRemoteCallResult> {
    throw new GitHubOfficialMcpRemoteError(
      this.code,
      `private provider detail ${secret}`,
    );
  }
}

describe("official GitHub MCP pull request transport boundary", () => {
  test("descriptor-admits the outer transport envelope before reading result", async () => {
    const transport = new HostileEnvelopeTransport();
    const error = await capturedError(() =>
      createAdapter(transport).callReadTool(callInput())
    );

    expect(error.code).toBe("github_delegated_provider_invalid_response");
    expect(error.message).toBe(
      "Official GitHub MCP transport result fields must be enumerable data properties",
    );
    expect(transport.getterCalls).toBe(0);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("rejects hidden or decorated outer transport fields", async () => {
    const error = await capturedError(() =>
      createAdapter(new DecoratedEnvelopeTransport()).callReadTool(callInput())
    );

    expect(error.code).toBe("github_delegated_provider_invalid_response");
    expect(error.message).toBe(
      "Official GitHub MCP transport result contained an unexpected field",
    );
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("maps every closed remote error code to adapter-owned fixed prose", async () => {
    const cases: readonly [GitHubOfficialMcpRemoteErrorCode, string][] = [
      [
        "github_official_mcp_mapping_rejected",
        "Official GitHub MCP read mapping was stale or unsupported",
      ],
      [
        "github_official_mcp_credential_unavailable",
        "Official GitHub MCP credential was unavailable",
      ],
      [
        "github_official_mcp_transport_failed",
        "Official GitHub MCP read failed before a verified result was available",
      ],
      [
        "github_official_mcp_invalid_result",
        "Official GitHub MCP returned an invalid result",
      ],
      [
        "github_official_mcp_close_failed",
        "Official GitHub MCP session could not be closed",
      ],
    ];

    for (const [code, message] of cases) {
      const error = await capturedError(() =>
        createAdapter(new FailingTransport(code)).callReadTool(callInput())
      );
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

function createAdapter(
  transport: GitHubOfficialMcpPullRequestTransport,
): GitHubOfficialMcpPullRequestAdapter {
  return new GitHubOfficialMcpPullRequestAdapter({
    transport,
    connectionId,
    installationId,
    credentialRef,
  });
}

function callInput() {
  return {
    tool: "get_pr_info",
    arguments: { pr_number: pullRequestNumber },
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

async function capturedError(
  operation: () => Promise<unknown>,
): Promise<GitHubProviderRejectedError> {
  try {
    await operation();
    throw new Error("Expected GitHub provider rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderRejectedError);
    return error as GitHubProviderRejectedError;
  }
}

function minimalPullRequestPayload(): Record<string, unknown> {
  return {
    number: pullRequestNumber,
    title: "Verify official GitHub MCP pull request results",
    state: "open",
    draft: false,
    merged: false,
    html_url: "https://github.com/teamleaderleo/stensibly/pull/42",
    user: { login: "teamleaderleo" },
    head: {
      ref: "lark/815-official-pr-result-recovery",
      sha: "d".repeat(40),
      repo: { full_name: repositoryFullName },
    },
    base: {
      ref: "main",
      sha: "e".repeat(40),
      repo: { full_name: repositoryFullName },
    },
    created_at: "2026-08-02T10:00:00Z",
    updated_at: "2026-08-02T10:05:00Z",
  };
}
