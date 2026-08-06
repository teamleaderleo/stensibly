import { describe, expect, test } from "bun:test";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "../src/github-rest-repository-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/response-lifetime";
const path = "docs/response-lifetime.md";
const parentSha = "a".repeat(40);
const apiBaseUrl = "https://api.github.test";

describe("native repository write total response lifetime", () => {
  test("bounds fetch acquisition and aborts the provider signal", async () => {
    let signal: AbortSignal | null = null;
    const adapter = adapterWithFetch((async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      signal = init?.signal as AbortSignal;
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch, 10);

    await expect(create(adapter)).rejects.toThrow(
      "GitHub could not read expected parent commit before a response was available",
    );
    expect(signal?.aborted).toBe(true);
  });

  test("bounds a stalled response body and cancels without awaiting", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const adapter = adapterWithFetch(
      (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      10,
    );

    await expect(create(adapter)).rejects.toThrow(
      "GitHub read expected parent commit response could not be read within its bounds",
    );
    expect(cancelled).toBe(true);
  });

  test("disposes a response that arrives after acquisition timeout", async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    let cancelled = false;
    const provider = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const adapter = adapterWithFetch(
      (async () => await provider) as unknown as typeof fetch,
      10,
    );

    await expect(create(adapter)).rejects.toThrow(
      "GitHub could not read expected parent commit before a response was available",
    );
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    resolveFetch?.(new Response(body, { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test.each([0, -1, 120_001, 1.5, Number.NaN])(
    "rejects invalid response deadline %s before provider work",
    (responseDeadlineMs) => {
      expect(() => adapterWithFetch(
        (async () => new Response()) as unknown as typeof fetch,
        responseDeadlineMs,
      )).toThrow("GitHub provider response deadline is invalid");
    },
  );
});

function adapterWithFetch(
  fetcher: typeof fetch,
  responseDeadlineMs: number,
): GitHubRestRepositoryWriteAdapter {
  return new GitHubRestRepositoryWriteAdapter({
    tokenProvider: tokenProvider(),
    apiBaseUrl,
    fetch: fetcher,
    responseDeadlineMs,
  });
}

function create(adapter: GitHubRestRepositoryWriteAdapter) {
  return adapter.dispatchRepositoryWrite({
    repositoryFullName,
    path,
    operation: "create_file",
    targetRef,
    expectedParentSha: parentSha,
    payload: {
      operation: "create_file",
      content: "bounded\n",
      message: "Bound response lifetime",
    },
    idempotencyKey: "response-lifetime-create",
  });
}

function tokenProvider(): GitHubRepositoryWriteTokenProvider {
  return {
    async getRepositoryContentsToken() {
      return {
        token: "contents-token",
        expiresAt: "2026-08-06T12:00:00.000Z",
      };
    },
  };
}
