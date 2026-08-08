import { expect, test } from "bun:test";
import type {
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import { GitHubRestDelegatedReadAdapter } from "../src/github-rest-delegated-read-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const connectionId = "ghconn_input_boundary";
const installationId = "98765";
const credentialRef = "secret://github/app-private-key";
const catalogueFingerprint = `sha256:${"a".repeat(64)}`;
const commitSha = "b".repeat(40);

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

function createAdapter(tokenProvider: TokenProvider): GitHubRestDelegatedReadAdapter {
  return new GitHubRestDelegatedReadAdapter({
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
    tool: "fetch_file" as const,
    arguments: {
      path: "README.md",
      ref: commitSha,
    },
    repositoryFullName,
    connectionId,
    installationId,
    credentialRef,
    catalogueFingerprint,
  };
}

test("normalizes a revoked top-level delegated-read call before token/provider work", async () => {
  const tokenProvider = new TokenProvider();
  const instance = createAdapter(tokenProvider);
  const revoked = Proxy.revocable(validCall(), {});
  revoked.revoke();

  await expect(instance.callReadTool(revoked.proxy))
    .rejects.toThrow("GitHub delegated adapter call could not be inspected");
  expect(tokenProvider.requests).toEqual([]);
});

test("reads declared call fields without caller key enumeration", async () => {
  const tokenProvider = new TokenProvider();
  const instance = createAdapter(tokenProvider);
  const target = validCall() as Record<string, unknown>;
  Object.defineProperty(target, "decoration", {
    enumerable: true,
    get() {
      throw new Error("delegated-read decoration getter must remain unreachable");
    },
  });
  let ownKeysCalls = 0;
  const proxied = new Proxy(target, {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("delegated-read ownKeys must remain unreachable");
    },
  });

  await expect(instance.callReadTool(proxied as ReturnType<typeof validCall>))
    .rejects.toThrow("provider dispatch must remain unreachable");
  expect(ownKeysCalls).toBe(0);
  expect(tokenProvider.requests).toHaveLength(1);
});

test("normalizes a revoked nested arguments object before token/provider work", async () => {
  const tokenProvider = new TokenProvider();
  const instance = createAdapter(tokenProvider);
  const revoked = Proxy.revocable(validCall().arguments, {});
  revoked.revoke();
  const value = {
    ...validCall(),
    arguments: revoked.proxy,
  };

  await expect(instance.callReadTool(value))
    .rejects.toThrow("GitHub delegated fetch_file arguments could not be inspected");
  expect(tokenProvider.requests).toEqual([]);
});
