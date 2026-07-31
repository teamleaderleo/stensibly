import { expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestActionsRunAdapter } from "../src/github-rest-actions-run-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const commitSha = "d".repeat(40);

test("copies admitted Actions response chunks before producer mutation", async () => {
  const payload = JSON.stringify({
    total_count: 1,
    workflow_runs: [{
      id: 30660326044,
      run_attempt: 1,
      workflow_id: 123456,
      name: "Canonical CI",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      head_sha: commitSha,
      repository: { full_name: "TeamLeaderLeo/Stensibly" },
      created_at: "2026-07-31T19:40:00Z",
      updated_at: "2026-07-31T19:48:00Z",
      run_started_at: "2026-07-31T19:41:00Z",
    }],
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
  const response = new Response(stream, {
    headers: { "content-type": "application/json" },
  });

  const adapter = new GitHubRestActionsRunAdapter({
    connectionId: "ghconn_installation_98765",
    installationId: "98765",
    credentialRef: "secret://github/app-private-key",
    tokenProvider: new StaticTokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: (async () => {
      setTimeout(() => {
        first.fill(0x78);
        streamController!.enqueue(second);
        streamController!.close();
      }, 0);
      return response;
    }) as typeof fetch,
  });

  const called = await adapter.callReadTool({
    tool: "fetch_commit_workflow_runs",
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
