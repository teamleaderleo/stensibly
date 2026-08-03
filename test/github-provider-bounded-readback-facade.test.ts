import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  readBoundedGitHubProviderResponseText,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";
import {
  GitHubRestIssueWriteAdapter,
} from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const deadlineMs = 20;
const watchdogMs = 250;
const fixedReadError =
  "GitHub provider response could not be read within its bounds";

describe("bounded GitHub provider readback facade", () => {
  test("preserves bounded text and Link pagination while clearing the deadline", async () => {
    let signal: AbortSignal | null = null;
    const link =
      "<https://api.github.com/repos/teamleaderleo/stensibly/issues?page=2>; rel=\"next\"";
    const fetcher = withGitHubProviderResponseDeadline(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? null;
        return Response.json({ value: "ok" }, {
          status: 200,
          headers: {
            link,
            "x-github-request-id": "REQ-BOUNDED-READBACK",
          },
        });
      }) as typeof fetch,
      deadlineMs,
    );

    const response = await fetcher("https://api.github.com/example");
    expect(response.headers.get("link")).toBe(link);
    expect(await response.text()).toBe('{"value":"ok"}');
    await expect(response.text()).rejects.toThrow(fixedReadError);

    await new Promise((resolve) => setTimeout(resolve, deadlineMs + 10));
    expect(signal?.aborted).toBe(false);
  });

  test("keeps ordinary list reads executable and publishes the next cursor", async () => {
    const adapter = new GitHubRestIssueWriteAdapter({
      tokenProvider: tokenProvider(),
      providerResponseDeadlineMs: deadlineMs,
      fetch: (async () => Response.json([
        issueResponse(1),
      ], {
        status: 200,
        headers: {
          link:
            '<https://api.github.com/repos/teamleaderleo/stensibly/issues?page=2>; rel="next"',
          "x-github-request-id": "REQ-LIST-READBACK",
        },
      })) as typeof fetch,
    });

    const result = await adapter.listIssues({
      repositoryFullName,
      state: "open",
      limit: 1,
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reference.number).toBe(1);
    expect(result.nextCursor).toBe("github-rest-v1:2:0");
    expect(result.providerRequestId).toBe("REQ-LIST-READBACK");
  });

  test("settles a legacy text read when the first body read never returns", async () => {
    let cancelled = false;
    const fetcher = withGitHubProviderResponseDeadline(
      (async () => stalledResponse(() => {
        cancelled = true;
      })) as typeof fetch,
      deadlineMs,
    );
    const response = await fetcher("https://api.github.com/example");

    const outcome = await settleWithin(response.text(), watchdogMs);

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") {
      throw new Error("Stalled legacy response text did not settle");
    }
    expect(outcome.error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((outcome.error as Error).message).toBe(fixedReadError);
    expect(cancelled).toBe(true);
  });

  test("rejects a hostile done accessor without invoking it", async () => {
    let getterCalls = 0;
    let cancelled = false;
    const readResult = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(readResult, "done", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return false;
      },
    });
    Object.defineProperty(readResult, "value", {
      enumerable: true,
      value: new Uint8Array(),
    });

    const error = await capture(readBoundedGitHubProviderResponseText(
      readerResponse(readResult, () => {
        cancelled = true;
      }),
      512 * 1024,
      deadlineMs,
    ));

    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(fixedReadError);
    expect(getterCalls).toBe(0);
    expect(cancelled).toBe(true);
  });

  test("rejects a hostile value accessor without invoking it", async () => {
    let getterCalls = 0;
    let cancelled = false;
    const readResult = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(readResult, "done", {
      enumerable: true,
      value: false,
    });
    Object.defineProperty(readResult, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return new Uint8Array();
      },
    });

    const error = await capture(readBoundedGitHubProviderResponseText(
      readerResponse(readResult, () => {
        cancelled = true;
      }),
      512 * 1024,
      deadlineMs,
    ));

    expect(error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((error as Error).message).toBe(fixedReadError);
    expect(getterCalls).toBe(0);
    expect(cancelled).toBe(true);
  });
});

function issueResponse(number: number) {
  return {
    number,
    node_id: `ISSUE_${number}`,
    repository_url: `https://api.github.com/repos/${repositoryFullName}`,
    title: `Issue ${number}`,
    body: null,
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    milestone: null,
    created_at: "2026-08-03T10:00:00.000Z",
    updated_at: "2026-08-03T10:01:00.000Z",
  };
}

function tokenProvider() {
  return {
    async getInstallationToken() {
      return {
        token: "installation-token",
        expiresAt: "2026-08-03T12:00:00.000Z",
      };
    },
  };
}

function stalledResponse(cancel: () => void): Response {
  return {
    headers: new Headers(),
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
          },
          cancel,
          releaseLock() {},
        };
      },
      cancel,
    },
  } as unknown as Response;
}

function readerResponse(readResult: unknown, cancel: () => void): Response {
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

type Settled =
  | { kind: "value"; value: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "watchdog" };

async function settleWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<Settled> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<Settled, Settled>(
        (value) => ({ kind: "value", value }),
        (error) => ({ kind: "error", error }),
      ),
      new Promise<Settled>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "watchdog" }), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected bounded readback rejection");
}
