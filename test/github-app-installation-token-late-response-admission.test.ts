import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubAppInstallationTokenMinter,
} from "../src/github-app-installation-token.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

describe("GitHub installation-token late response admission", () => {
  test("disposes a response that arrives after the total lifetime expires", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let cancelled = false;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const provider = minter(
      (async () => await fetchPromise) as unknown as typeof fetch,
      20,
    );

    await expect(request(provider)).rejects.toThrow(
      "request failed before a response was available",
    );

    resolveFetch?.({
      ok: true,
      status: 201,
      headers: new Headers(),
      body: {
        cancel() {
          cancelled = true;
          return Promise.resolve();
        },
      },
    } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelled).toBe(true);
  });

  test("reads only done/value descriptors without caller-owned key enumeration", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(tokenPayload()));
    let ownKeysCalls = 0;
    let readIndex = 0;
    const results = [
      proxiedResult({ done: false as const, value: encoded }),
      proxiedResult({ done: true as const, value: undefined }),
    ];
    const response = responseWithReader({
      async read() {
        const result = results[readIndex];
        readIndex += 1;
        if (!result) throw new Error("unexpected extra token-response read");
        return result;
      },
    });
    const provider = minter(
      (async () => response) as unknown as typeof fetch,
      1_000,
    );

    await expect(request(provider)).resolves.toMatchObject({
      token: "bounded-token",
      expiresAt: "2026-08-03T11:00:00.000Z",
    });
    expect(readIndex).toBe(2);
    expect(ownKeysCalls).toBe(0);

    function proxiedResult(
      value: ReadableStreamReadResult<Uint8Array>,
    ): ReadableStreamReadResult<Uint8Array> {
      return new Proxy(value, {
        ownKeys() {
          ownKeysCalls += 1;
          throw new Error("token read-result ownKeys must remain unused");
        },
      });
    }
  });
});

function minter(fetcher: typeof fetch, responseTimeoutMs: number) {
  return new GitHubAppInstallationTokenMinter({
    appId: "12345",
    installationId: "98765",
    accountLogin: "teamleaderleo",
    privateKeyPem,
    repositoryFullNames: [repositoryFullName],
    apiBaseUrl: "https://api.github.test",
    fetch: fetcher,
    now: () => Date.parse("2026-08-03T10:00:00.000Z"),
    responseTimeoutMs,
  });
}

function request(provider: GitHubAppInstallationTokenMinter) {
  return provider.getInstallationToken({
    repositoryFullName,
    permission: { name: "contents", access: "write" },
  });
}

function tokenPayload() {
  return {
    token: "bounded-token",
    expires_at: "2026-08-03T11:00:00.000Z",
    permissions: { contents: "write", metadata: "read" },
    repository_selection: "selected",
    repositories: [{ full_name: repositoryFullName }],
  };
}

function responseWithReader(readerInput: {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
}): Response {
  const reader = {
    read: readerInput.read,
    cancel() {
      return Promise.resolve();
    },
    releaseLock() {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return {
    ok: true,
    status: 201,
    headers: new Headers(),
    body: {
      getReader() {
        return reader;
      },
    },
  } as unknown as Response;
}
