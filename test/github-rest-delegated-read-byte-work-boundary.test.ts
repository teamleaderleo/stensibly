import { expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestDelegatedReadAdapter } from "../src/github-rest-delegated-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_byte_work_boundary";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;

class TokenProvider implements GitHubInstallationTokenProvider {
  async getInstallationToken(
    _input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    return {
      token: "delegated-token",
      expiresAt: "2026-08-08T12:00:00.000Z",
    };
  }
}

function adapter(fetchImpl: typeof fetch): GitHubRestDelegatedReadAdapter {
  return new GitHubRestDelegatedReadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider: new TokenProvider(),
    apiBaseUrl: "https://api.github.test",
    fetch: fetchImpl,
  });
}

function callInput() {
  return {
    tool: "get_repo" as const,
    arguments: Object.freeze({}),
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

function repositoryPayload(padding = "") {
  return {
    id: 123456,
    node_id: "R_kgDObytework",
    full_name: repositoryFullName,
    private: true,
    archived: false,
    disabled: false,
    visibility: "private",
    default_branch: "main",
    updated_at: "2026-08-08T00:00:00.000Z",
    pushed_at: "2026-08-08T00:00:00.000Z",
    padding,
  };
}

function fakeResponse(body: ReadableStream<unknown>): Response {
  return Object.freeze({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body,
  }) as unknown as Response;
}

test("accepts a byte-valid response split into more than 4096 positive chunks", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(repositoryPayload("x".repeat(5_000))));
  expect(bytes.byteLength).toBeLessThan(128 * 1024);
  expect(bytes.byteLength).toBeGreaterThan(4_096);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const instance = adapter((async () => fakeResponse(body)) as typeof fetch);

  await expect(instance.callReadTool(callInput())).resolves.toMatchObject({
    result: {
      repositoryFullName,
      id: 123456,
      defaultBranch: "main",
    },
  });
});

test("rejects non-byte typed-array chunks instead of truncating their elements", async () => {
  const body = new ReadableStream<unknown>({
    start(controller) {
      controller.enqueue(new Uint16Array([0x7b]));
      controller.close();
    },
  });
  const instance = adapter((async () => fakeResponse(body)) as typeof fetch);

  await expect(instance.callReadTool(callInput()))
    .rejects.toThrow("GitHub delegated provider response could not be read");
});
