import { expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestCommitStatusAdapter } from "../src/github-rest-commit-status-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const commitSha = "d".repeat(40);

test("copies admitted commit-status chunks before producer mutation", async () => {
  const payload = JSON.stringify({
    state: "success",
    sha: commitSha,
    total_count: 1,
    statuses: [{
      id: 777,
      state: "success",
      context: "task-sk-review",
      description: "Run sk-checks",
      target_url: "https://ci.example/task-sk-review",
      creator: { login: "sk-checks-bot", id: 42 },
      created_at: "2026-07-31T19:41:00Z",
      updated_at: "2026-07-31T19:47:00Z",
    }],
    repository: { full_name: "TeamLeaderLeo/Stensibly" },
  });
  const bytes = new TextEncoder().encode(payload);
  const split = Math.floor(bytes.byteLength / 2);
  const oversizedBacking = new Uint8Array(1024 * 1024);
  const first = oversizedBacking.subarray(0, split);
  first.set(bytes.subarray(0, split));
  const second = bytes.slice(split);

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(first);
    },
  });

  const adapter = new GitHubRestCommitStatusAdapter({
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    credentialRef: "secret://github/app-private-key",
    tokenProvider: new StaticTokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: (async (input) => {
      setTimeout(() => {
        first.fill(0x78);
        streamController!.enqueue(second);
        streamController!.close();
      }, 0);
      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    }) as unknown as typeof fetch,
  });

  const called = await adapter.callReadTool({
    tool: "get_commit_combined_status",
    arguments: Object.freeze({ commit_sha: commitSha }),
    repositoryFullName,
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    credentialRef: "secret://github/app-private-key",
    catalogueFingerprint: `sha256:${"a".repeat(64)}`,
  });

  expect((called.result as { totalCount: number }).totalCount).toBe(1);
});

class StaticTokenProvider implements GitHubInstallationTokenProvider {
  async getInstallationToken(
    _input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    return {
      token: "delegated-token",
      expiresAt: "2026-07-31T21:00:00.000Z",
    };
  }
}
