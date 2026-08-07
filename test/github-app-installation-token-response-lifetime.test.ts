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

function minter(fetcher: typeof fetch, responseTimeoutMs = 25) {
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

function tokenPayload(token = "bounded-token") {
  return {
    token,
    expires_at: "2026-08-03T11:00:00.000Z",
    permissions: { contents: "write", metadata: "read" },
    repository_selection: "selected",
    repositories: [{ full_name: repositoryFullName }],
  };
}

describe("GitHub installation-token total response lifetime", () => {
  test("settles a fetch that never returns headers and aborts its signal", async () => {
    let signal: AbortSignal | null = null;
    const provider = minter((async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      signal = init?.signal as AbortSignal;
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch);

    await expect(request(provider)).rejects.toThrow(
      "request failed before a response was available",
    );
    const observedSignal = signal as AbortSignal | null;
    expect(observedSignal?.aborted).toBe(true);
  });

  test("settles a body read that never returns and never awaits cancellation", async () => {
    let cancelled = false;
    const response = responseWithReader({
      read: async () => await new Promise<never>(() => {}),
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const provider = minter(
      (async () => response) as unknown as typeof fetch,
    );

    await expect(request(provider)).rejects.toThrow(
      "response could not be read",
    );
    expect(cancelled).toBe(true);
  });

  test("bounds zero-byte chunk work and does not await cancellation", async () => {
    let reads = 0;
    let cancelled = false;
    const response = responseWithReader({
      async read() {
        reads += 1;
        return { done: false as const, value: new Uint8Array() };
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const provider = minter(
      (async () => response) as unknown as typeof fetch,
      2_000,
    );

    await expect(request(provider)).rejects.toThrow(
      "response exceeded its work limit",
    );
    expect(reads).toBe(4_097);
    expect(cancelled).toBe(true);
  });

  test("does not await a non-settling status-body cancellation", async () => {
    let cancelled = false;
    const response = {
      ok: false,
      status: 503,
      headers: new Headers(),
      body: {
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      },
    } as unknown as Response;
    const provider = minter(
      (async () => response) as unknown as typeof fetch,
    );

    await expect(request(provider)).rejects.toThrow(
      "GitHub could not mint installation token (HTTP 503)",
    );
    expect(cancelled).toBe(true);
  });

  test("detaches delivered chunks before a provider mutates its buffer", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(tokenPayload()));
    const split = Math.floor(encoded.byteLength / 2);
    const first = encoded.slice(0, split);
    const second = encoded.slice(split);
    let readIndex = 0;
    const response = responseWithReader({
      async read() {
        readIndex += 1;
        if (readIndex === 1) return { done: false as const, value: first };
        if (readIndex === 2) {
          first.fill(0);
          return { done: false as const, value: second };
        }
        return { done: true as const, value: undefined };
      },
    });
    const provider = minter(
      (async () => response) as unknown as typeof fetch,
    );

    await expect(request(provider)).resolves.toMatchObject({
      token: "bounded-token",
      expiresAt: "2026-08-03T11:00:00.000Z",
    });
  });

  test("rejects hostile stream result accessors without invoking them", async () => {
    let getterCalls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "done", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return false;
      },
    });
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      value: new Uint8Array([1]),
    });
    const response = responseWithReader({
      async read() {
        return hostile as unknown as ReadableStreamReadResult<Uint8Array>;
      },
    });
    const provider = minter(
      (async () => response) as unknown as typeof fetch,
    );

    await expect(request(provider)).rejects.toThrow(
      "response body was invalid",
    );
    expect(getterCalls).toBe(0);
  });
});

function responseWithReader(readerInput: {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel?: () => Promise<void> | void;
}): Response {
  const reader = {
    read: readerInput.read,
    cancel: readerInput.cancel ?? (() => undefined),
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
