import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  readBoundedGitHubProviderResponseText,
} from "../src/github-provider-bounded-response.ts";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueWriteAdapter,
} from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const hostileDetail = `github_pat_${"a".repeat(24)}`;
const fixedReadError =
  "GitHub provider response could not be read within its bounds";
const fixedCreateAmbiguity =
  "GitHub create issue outcome requires reconciliation";

describe("hostile GitHub provider response metadata", () => {
  test("turns throwing response headers access into fixed reader failure and disposal", async () => {
    let cancelled = false;
    const response = {
      get headers() {
        throw new Error(hostileDetail);
      },
      body: cancellableBody(() => {
        cancelled = true;
      }),
    } as unknown as Response;

    await expectFixedReaderFailure(response);
    expect(cancelled).toBe(true);
  });

  test("turns throwing content-length lookup into fixed reader failure and disposal", async () => {
    let cancelled = false;
    const response = {
      headers: {
        get() {
          throw new Error(hostileDetail);
        },
      },
      body: cancellableBody(() => {
        cancelled = true;
      }),
    } as unknown as Response;

    await expectFixedReaderFailure(response);
    expect(cancelled).toBe(true);
  });

  test("turns throwing response body access into fixed reader failure", async () => {
    let bodyReads = 0;
    const response = {
      headers: new Headers(),
      get body() {
        bodyReads += 1;
        throw new Error(hostileDetail);
      },
    } as unknown as Response;

    await expectFixedReaderFailure(response);
    expect(bodyReads).toBeGreaterThan(0);
  });

  test("cancels when a read result done getter throws hostile prose", async () => {
    let cancelled = false;
    const response = injectedReaderResponse({
      get done() {
        throw new Error(hostileDetail);
      },
      value: new Uint8Array(),
    }, () => {
      cancelled = true;
    });

    await expectFixedReaderFailure(response);
    expect(cancelled).toBe(true);
  });

  test("cancels when a read result value getter throws hostile prose", async () => {
    let cancelled = false;
    const response = injectedReaderResponse({
      done: false,
      get value() {
        throw new Error(hostileDetail);
      },
    }, () => {
      cancelled = true;
    });

    await expectFixedReaderFailure(response);
    expect(cancelled).toBe(true);
  });

  test("cancels when a read result is not an object", async () => {
    for (const readResult of [null, undefined, "chunk"] as const) {
      let cancelled = false;
      const response = injectedReaderResponse(readResult, () => {
        cancelled = true;
      });

      await expectFixedReaderFailure(response);
      expect(cancelled).toBe(true);
    }
  });

  test("preserves an admitted request ID when ok metadata throws", async () => {
    let cancelled = false;
    const response = {
      headers: new Headers({
        "x-github-request-id": "REQ-HOSTILE-OK",
      }),
      get ok() {
        throw new Error(hostileDetail);
      },
      status: 201,
      body: cancellableBody(() => {
        cancelled = true;
      }),
    } as unknown as Response;

    await expectAttributedAdapterFailure(response, "REQ-HOSTILE-OK");
    expect(cancelled).toBe(true);
  });

  test("preserves an admitted request ID when status metadata throws", async () => {
    let cancelled = false;
    const response = {
      headers: new Headers({
        "x-github-request-id": "REQ-HOSTILE-STATUS",
      }),
      ok: false,
      get status() {
        throw new Error(hostileDetail);
      },
      body: cancellableBody(() => {
        cancelled = true;
      }),
    } as unknown as Response;

    await expectAttributedAdapterFailure(response, "REQ-HOSTILE-STATUS");
    expect(cancelled).toBe(true);
  });

  test("uses fixed unattributed ambiguity when headers getter fails before request identity", async () => {
    let cancelled = false;
    const response = {
      get headers() {
        throw new Error(hostileDetail);
      },
      ok: true,
      status: 201,
      body: cancellableBody(() => {
        cancelled = true;
      }),
    } as unknown as Response;

    await expectUnattributedAdapterFailure(response);
    expect(cancelled).toBe(true);
  });

  test("uses fixed unattributed ambiguity when request-ID lookup throws", async () => {
    let cancelled = false;
    const response = {
      headers: {
        get() {
          throw new Error(hostileDetail);
        },
      },
      ok: true,
      status: 201,
      body: cancellableBody(() => {
        cancelled = true;
      }),
    } as unknown as Response;

    await expectUnattributedAdapterFailure(response);
    expect(cancelled).toBe(true);
  });
});

async function expectFixedReaderFailure(response: Response): Promise<void> {
  const error = await capture(
    readBoundedGitHubProviderResponseText(response, 512 * 1024, 25),
  );
  expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
  expect((error as Error).message).toBe(fixedReadError);
  expect((error as Error).message).not.toContain(hostileDetail);
}

async function expectAttributedAdapterFailure(
  response: Response,
  providerRequestId: string,
): Promise<void> {
  const error = await capture(createIssue(adapterFor(response)));
  expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
  expect(error).toMatchObject({
    providerRequestId,
    message:
      "GitHub provider effect requires reconciliation after verification failed",
  });
  expect((error as Error).message).not.toContain(hostileDetail);
}

async function expectUnattributedAdapterFailure(response: Response): Promise<void> {
  const error = await capture(createIssue(adapterFor(response)));
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(GitHubProviderPostEffectError);
  expect((error as Error).message).toBe(fixedCreateAmbiguity);
  expect((error as Error).message).not.toContain(hostileDetail);
}

function createIssue(adapter: GitHubRestIssueWriteAdapter) {
  return adapter.createIssue({
    repositoryFullName,
    title: "Hostile response metadata",
    body: "Body",
    labels: [],
    assignees: [],
    idempotencyKey: "hostile-response-metadata",
  });
}

function injectedReaderResponse(
  readResult: unknown,
  cancel: () => void,
): Response {
  let delivered = false;
  return {
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return readResult;
          },
          cancel,
          releaseLock() {},
        };
      },
      cancel,
    },
  } as unknown as Response;
}

function cancellableBody(cancel: () => void) {
  return {
    cancel() {
      cancel();
    },
  };
}

function adapterFor(response: Response): GitHubRestIssueWriteAdapter {
  return new GitHubRestIssueWriteAdapter({
    tokenProvider: {
      async getInstallationToken() {
        return {
          token: "installation-token",
          expiresAt: "2026-08-03T12:00:00.000Z",
        };
      },
    },
    fetch: (async () => response) as typeof fetch,
    providerResponseDeadlineMs: 25,
  });
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected hostile provider response rejection");
}
