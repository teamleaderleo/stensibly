import { describe, expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestPullRequestReadAdapter } from "../src/github-rest-pull-request-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const pullRequestNumber = 42;

class TokenProvider implements GitHubInstallationTokenProvider {
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

function payload() {
  return {
    url: "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42",
    number: pullRequestNumber,
    id: 987654,
    node_id: "PR_kwDOGitHub",
    state: "closed",
    draft: false,
    locked: false,
    merged: true,
    title: "Reject impossible pull request lifecycle ordering",
    user: { login: "teamleaderleo" },
    head: {
      repo: { full_name: repositoryFullName },
      sha: "d".repeat(40),
      ref: "review/768-pr-lifecycle-order",
    },
    base: {
      repo: { full_name: repositoryFullName },
      sha: "e".repeat(40),
      ref: "main",
    },
    merge_commit_sha: "f".repeat(40),
    created_at: "2026-07-31T02:00:00Z",
    closed_at: "2026-07-31T02:05:00Z",
    merged_at: "2026-07-31T02:06:00Z",
    updated_at: "2026-07-31T02:07:00Z",
    additions: 2,
    deletions: 1,
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    comments: 0,
  };
}

describe("native GitHub pull request lifecycle ordering", () => {
  test("rejects a merge timestamp after the pull request was already closed", async () => {
    const tokenProvider = new TokenProvider();
    const adapter = new GitHubRestPullRequestReadAdapter({
      connectionId: "ghconn_installation_98765",
      installationId: "98765",
      credentialRef: "secret://github/app-private-key",
      tokenProvider,
      apiBaseUrl: "https://api.github.test",
      fetch: (async () => Response.json(payload())) as unknown as typeof fetch,
    });

    await expect(adapter.callReadTool({
      tool: "get_pr_info",
      arguments: { pr_number: pullRequestNumber },
      repositoryFullName,
      connectionId: "ghconn_installation_98765",
      installationId: "98765",
      credentialRef: "secret://github/app-private-key",
      catalogueFingerprint: `sha256:${"a".repeat(64)}`,
    })).rejects.toThrow("lifecycle fields were inconsistent");

    expect(tokenProvider.requests).toEqual([{
      repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    }]);
  });
});
