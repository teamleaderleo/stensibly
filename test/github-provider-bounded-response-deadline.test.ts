import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  readBoundedGitHubProviderResponseText,
} from "../src/github-provider-bounded-response.ts";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";
import {
  GitHubRestIssueWriteAdapter,
} from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;
const responseDeadlineMs = 20;
const witnessWindowMs = 250;
const invalidValues = [
  0,
  -0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  120_001,
  "20",
  null,
] as const;
const invalidDeadlineError = "GitHub provider response deadline is invalid";

describe("bounded GitHub provider response deadline", () => {
  test("rejects invalid direct-reader deadlines before response-body access", async () => {
    for (const providerResponseDeadlineMs of invalidValues) {
      let bodyReads = 0;
      const response = {
        headers: new Headers(),
        get body() {
          bodyReads += 1;
          throw new Error("body must remain unread");
        },
      } as unknown as Response;

      await expect(readBoundedGitHubProviderResponseText(
        response,
        512 * 1024,
        providerResponseDeadlineMs as number,
      )).rejects.toThrow(invalidDeadlineError);
      expect(bodyReads).toBe(0);
    }
  });

  test("cancels and rejects when the first response-body read never settles", async () => {
    const observed = stalledResponse("REQ-SHARED-DEADLINE");

    const outcome = await withinWitnessWindow(
      readBoundedGitHubProviderResponseText(
        observed.response,
        512 * 1024,
        responseDeadlineMs,
      ),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") {
      throw new Error("Bounded response reader did not enforce its deadline");
    }
    expect(outcome.error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((outcome.error as Error).message).toBe(
      "GitHub provider response could not be read within its bounds",
    );
    expect(observed.cancelCalled()).toBe(true);
  });

  test("set writes retain an admitted request ID when the response body stalls", async () => {
    const requestId = "REQ-SET-DEADLINE";
    const observed = stalledResponse(requestId);
    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async () => observed.response) as typeof fetch,
      providerResponseDeadlineMs: responseDeadlineMs,
    });

    const outcome = await withinWitnessWindow(adapter.addIssueLabels({
      repositoryFullName,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "set-response-deadline",
    }));

    expectPostEffectDeadline(outcome, requestId);
    expect(observed.cancelCalled()).toBe(true);
  });

  test("create writes retain an admitted request ID when the response body stalls", async () => {
    const requestId = "REQ-CREATE-DEADLINE";
    const observed = stalledResponse(requestId);
    const adapter = new GitHubRestIssueWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async () => observed.response) as typeof fetch,
      providerResponseDeadlineMs: responseDeadlineMs,
    });

    const outcome = await withinWitnessWindow(adapter.createIssue({
      repositoryFullName,
      title: "Bound stalled provider response reads",
      labels: [],
      assignees: [],
      idempotencyKey: "create-response-deadline",
    }));

    expectPostEffectDeadline(outcome, requestId);
    expect(observed.cancelCalled()).toBe(true);
  });

  test("preserves an explicit set deadline through delegated create writes", async () => {
    const requestId = "REQ-DELEGATED-CREATE-DEADLINE";
    const observed = stalledResponse(requestId);
    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async () => observed.response) as typeof fetch,
      providerResponseDeadlineMs: responseDeadlineMs,
    });

    const outcome = await withinWitnessWindow(adapter.createIssue({
      repositoryFullName,
      title: "Preserve delegated response deadline",
      labels: [],
      assignees: [],
      idempotencyKey: "delegated-create-response-deadline",
    }));

    expectPostEffectDeadline(outcome, requestId);
    expect(observed.cancelCalled()).toBe(true);
  });

  test("starts the production default before dispatch for both adapters", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(null, { status: 422 });
    }) as typeof fetch;

    const writeAdapter = new GitHubRestIssueWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: fetcher,
    });
    await expect(writeAdapter.createIssue({
      repositoryFullName,
      title: "Default response deadline",
      labels: [],
      assignees: [],
      idempotencyKey: "default-write-response-deadline",
    })).rejects.toThrow("GitHub rejected create issue");

    const setAdapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: fetcher,
    });
    await expect(setAdapter.addIssueLabels({
      repositoryFullName,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "default-set-response-deadline",
    })).rejects.toThrow("GitHub rejected add issue labels");

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  test("rejects invalid adapter deadlines before token or fetch access", () => {
    for (const providerResponseDeadlineMs of invalidValues) {
      let tokenCalls = 0;
      let fetchCalls = 0;
      const options = {
        tokenProvider: {
          async getInstallationToken() {
            tokenCalls += 1;
            return {
              token: "installation-token",
              expiresAt: "2026-08-03T12:00:00.000Z",
            };
          },
        },
        fetch: (async () => {
          fetchCalls += 1;
          return Response.json({});
        }) as typeof fetch,
        providerResponseDeadlineMs,
      };

      expect(() => new GitHubRestIssueWriteAdapter(
        options as ConstructorParameters<typeof GitHubRestIssueWriteAdapter>[0],
      )).toThrow(invalidDeadlineError);
      expect(() => new GitHubRestIssueSetWriteAdapter(
        options as ConstructorParameters<typeof GitHubRestIssueSetWriteAdapter>[0],
      )).toThrow(invalidDeadlineError);
      expect(tokenCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    }
  });
});

function expectPostEffectDeadline(
  outcome: Awaited<ReturnType<typeof withinWitnessWindow>>,
  providerRequestId: string,
): void {
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind !== "rejected") {
    throw new Error("GitHub mutation did not settle after its response deadline");
  }
  expect(outcome.error).toBeInstanceOf(GitHubProviderPostEffectError);
  expect(outcome.error).toMatchObject({
    providerRequestId,
    message:
      "GitHub provider effect requires reconciliation after verification failed",
  });
}

function stalledResponse(requestId: string) {
  let cancelCalled = false;
  const reader = {
    read() {
      return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
    },
    cancel() {
      cancelCalled = true;
      return new Promise<void>(() => {});
    },
    releaseLock() {},
  };
  return {
    response: {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "application/json",
        "x-github-request-id": requestId,
      }),
      body: {
        getReader() {
          return reader;
        },
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => {});
        },
      },
    } as unknown as Response,
    cancelCalled: () => cancelCalled,
  };
}

async function withinWitnessWindow<T>(promise: Promise<T>): Promise<
  | { kind: "fulfilled"; value: T; error: null }
  | { kind: "rejected"; value: null; error: unknown }
  | { kind: "timeout"; value: null; error: null }
> {
  return await Promise.race([
    promise.then(
      (value) => ({ kind: "fulfilled" as const, value, error: null }),
      (error: unknown) => ({ kind: "rejected" as const, value: null, error }),
    ),
    new Promise<{ kind: "timeout"; value: null; error: null }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout", value: null, error: null }), witnessWindowMs);
    }),
  ]);
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
