import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubAppInstallationTokenMinter,
} from "../src/github-app-installation-token.ts";
import {
  GitHubProviderRejectedError,
} from "../src/github-provider-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const fixedResponseError =
  "GitHub installation token response could not be read";
const timeoutMs = 20;
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

describe("GitHub installation-token response metadata admission", () => {
  test.each(["ok", "status", "headers"] as const)(
    "fails closed when provider %s metadata throws",
    async (field) => {
      const secret = `provider-${field}-secret`;
      let cancelled = false;
      let providerSignal: AbortSignal | undefined;
      const body = {
        cancel() {
          cancelled = true;
          return Promise.resolve();
        },
      };
      const response = {
        get ok() {
          if (field === "ok") throw new Error(secret);
          return field === "status" ? false : true;
        },
        get status() {
          if (field === "status") throw new Error(secret);
          return 201;
        },
        get headers() {
          if (field === "headers") throw new Error(secret);
          return new Headers();
        },
        body,
      } as unknown as Response;
      const provider = minter((async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        providerSignal = init?.signal ?? undefined;
        return response;
      }) as unknown as typeof fetch);

      const error = await capture(request(provider));

      expect(error).toBeInstanceOf(GitHubProviderRejectedError);
      expect((error as Error).message).toBe(fixedResponseError);
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(cancelled).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, timeoutMs * 3));
      expect(providerSignal).toBeInstanceOf(AbortSignal);
      expect(providerSignal?.aborted).toBe(false);
    },
  );
});

function minter(fetcher: typeof fetch): GitHubAppInstallationTokenMinter {
  return new GitHubAppInstallationTokenMinter({
    appId: "12345",
    installationId: "98765",
    accountLogin: "teamleaderleo",
    privateKeyPem,
    repositoryFullNames: [repositoryFullName],
    apiBaseUrl: "https://api.github.test",
    fetch: fetcher,
    now: () => Date.parse("2026-08-05T18:30:00.000Z"),
    responseTimeoutMs: timeoutMs,
  });
}

function request(provider: GitHubAppInstallationTokenMinter) {
  return provider.getInstallationToken({
    repositoryFullName,
    permission: { name: "contents", access: "write" },
  });
}

async function capture(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected token response metadata failure");
}
