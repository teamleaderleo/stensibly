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

describe("hostile GitHub provider response metadata", () => {
  test("turns throwing response headers access into fixed reader failure and disposal", async () => {
    let cancelled = false;
    const response = {
      get headers() {
        throw new Error(hostileDetail);
      },
      body: {
        cancel() {
          cancelled = true;
        },
      },
    } as unknown as Response;

    const error = await capture(
      readBoundedGitHubProviderResponseText(response, 512 * 1024, 25),
    );

    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(fixedReadError);
    expect((error as Error).message).not.toContain(hostileDetail);
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
      body: {
        cancel() {
          cancelled = true;
        },
      },
    } as unknown as Response;

    const error = await capture(
      readBoundedGitHubProviderResponseText(response, 512 * 1024, 25),
    );

    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(fixedReadError);
    expect((error as Error).message).not.toContain(hostileDetail);
    expect(cancelled).toBe(true);
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

    const error = await capture(
      readBoundedGitHubProviderResponseText(response, 512 * 1024, 25),
    );

    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(fixedReadError);
    expect((error as Error).message).not.toContain(hostileDetail);
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

    const error = await capture(
      readBoundedGitHubProviderResponseText(response, 512 * 1024, 25),
    );

    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(fixedReadError);
    expect((error as Error).message).not.toContain(hostileDetail);
    expect(cancelled).toBe(true);
  });

  test("preserves an admitted mutation request ID when later status metadata throws", async () => {
    let cancelled = false;
    const response = {
      headers: new Headers({
        "x-github-request-id": "REQ-HOSTILE-METADATA",
      }),
      get ok() {
        throw new Error(hostileDetail);
      },
      status: 201,
      body: {
        cancel() {
          cancelled = true;
        },
      },
    } as unknown as Response;
    const adapter = adapterFor(response);

    const error = await capture(adapter.createIssue({
      repositoryFullName,
      title: "Hostile response metadata",
      body: "Body",
      labels: [],
      assignees: [],
      idempotencyKey: "hostile-response-metadata",
    }));

    expect(error).toBeInstanceOf(GitHubProviderPostEffectError);
    expect(error).toMatchObject({
      providerRequestId: "REQ-HOSTILE-METADATA",
      message:
        "GitHub provider effect requires reconciliation after verification failed",
    });
    expect((error as Error).message).not.toContain(hostileDetail);
    expect(cancelled).toBe(true);
  });

  test("uses fixed unattributed ambiguity when headers fail before request identity admission", async () => {
    let cancelled = false;
    const response = {
      get headers() {
        throw new Error(hostileDetail);
      },
      ok: true,
      status: 201,
      body: {
        cancel() {
          cancelled = true;
        },
      },
    } as unknown as Response;
    const adapter = adapterFor(response);

    const error = await capture(adapter.createIssue({
      repositoryFullName,
      title: "Hostile response headers",
      body: "Body",
      labels: [],
      assignees: [],
      idempotencyKey: "hostile-response-headers",
    }));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubProviderPostEffectError);
    expect((error as Error).message).toBe(
      "GitHub create issue outcome requires reconciliation",
    );
    expect((error as Error).message).not.toContain(hostileDetail);
    expect(cancelled).toBe(true);
  });
});

function injectedReaderResponse(
  readResult: object,
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
