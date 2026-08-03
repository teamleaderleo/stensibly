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
const readDeadlineMs = 20;
const witnessWindowMs = 250;

type DeadlineReader = (
  response: Response,
  maximumBytes: number,
  deadlineMs: number,
) => Promise<string>;

describe("bounded GitHub provider response read deadline", () => {
  test("cancels and rejects when the first response-body read never settles", async () => {
    const observed = stalledResponse("REQ-SHARED-DEADLINE");
    const read = readBoundedGitHubProviderResponseText as unknown as DeadlineReader;

    const outcome = await withinWitnessWindow(
      read(observed.response, 512 * 1024, readDeadlineMs),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") {
      throw new Error("Bounded response reader did not enforce its read deadline");
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
      fetch: (async () => observed.response) as unknown as typeof fetch,
      responseReadTimeoutMs: readDeadlineMs,
    } as unknown as ConstructorParameters<typeof GitHubRestIssueSetWriteAdapter>[0]);

    const outcome = await withinWitnessWindow(adapter.addIssueLabels({
      repositoryFullName,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "set-response-read-deadline",
    }));

    expectPostEffectDeadline(outcome, requestId);
    expect(observed.cancelCalled()).toBe(true);
  });

  test("create writes retain an admitted request ID when the response body stalls", async () => {
    const requestId = "REQ-CREATE-DEADLINE";
    const observed = stalledResponse(requestId);
    const adapter = new GitHubRestIssueWriteAdapter({
      tokenProvider: tokenProvider(),
      fetch: (async () => observed.response) as unknown as typeof fetch,
      responseReadTimeoutMs: readDeadlineMs,
    } as unknown as ConstructorParameters<typeof GitHubRestIssueWriteAdapter>[0]);

    const outcome = await withinWitnessWindow(adapter.createIssue({
      repositoryFullName,
      title: "Bound stalled provider response reads",
      labels: [],
      assignees: [],
      idempotencyKey: "create-response-read-deadline",
    }));

    expectPostEffectDeadline(outcome, requestId);
    expect(observed.cancelCalled()).toBe(true);
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
