import { expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestPullRequestReadAdapter } from "../src/github-rest-pull-request-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_pr_sibling_boundary";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;

class TokenProvider implements GitHubInstallationTokenProvider {
  readonly requests: GitHubInstallationTokenRequest[] = [];

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requests.push(input);
    return {
      token: "delegated-token",
      expiresAt: "2026-08-08T12:00:00.000Z",
    };
  }
}

function createAdapter(tokenProvider: TokenProvider): GitHubRestPullRequestReadAdapter {
  return new GitHubRestPullRequestReadAdapter({
    connectionId,
    installationId,
    credentialRef,
    tokenProvider,
    apiBaseUrl: "https://api.github.test",
    fetch: (async () => {
      throw new Error("provider dispatch must remain unreachable");
    }) as typeof fetch,
  });
}

function validCall() {
  return {
    tool: "get_pr_info" as const,
    arguments: { pr_number: 1194 },
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

test("PR metadata adapter normalizes revoked call before token/provider work", async () => {
  const tokenProvider = new TokenProvider();
  const instance = createAdapter(tokenProvider);
  const revoked = Proxy.revocable(validCall(), {});
  revoked.revoke();

  await expect(instance.callReadTool(revoked.proxy))
    .rejects.toThrow("GitHub delegated adapter call could not be inspected");
  expect(tokenProvider.requests).toEqual([]);
});

test("PR metadata adapter ignores unrelated call decorations without ownKeys", async () => {
  const tokenProvider = new TokenProvider();
  const instance = createAdapter(tokenProvider);
  const target = validCall() as Record<string, unknown>;
  Object.defineProperty(target, "decoration", {
    enumerable: true,
    get() {
      throw new Error("PR delegated decoration getter must remain unreachable");
    },
  });
  let ownKeysCalls = 0;
  const proxied = new Proxy(target, {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("PR delegated ownKeys must remain unreachable");
    },
  });

  try {
    await instance.callReadTool(proxied as ReturnType<typeof validCall>);
    throw new Error("expected provider dispatch failure");
  } catch (error) {
    expect(String(error)).toContain("request failed before a response was available");
    expect(String(error)).not.toContain("provider dispatch must remain unreachable");
  }
  expect(ownKeysCalls).toBe(0);
  expect(tokenProvider.requests).toHaveLength(1);
});
