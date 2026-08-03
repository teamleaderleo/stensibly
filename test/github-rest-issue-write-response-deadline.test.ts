import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueWriteAdapter,
} from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const deadlineMs = 5;
const watchdogMs = 250;

describe("GitHub issue-write response deadline", () => {
  test("settles unattributed ambiguity when response acquisition never completes", async () => {
    const adapter = adapterWithDeadline(
      (async () => await new Promise<Response>(() => undefined)) as typeof fetch,
    );

    const settled = await settleWithin(createIssue(adapter), watchdogMs);

    expect(settled.kind).toBe("error");
    if (settled.kind !== "error") return;
    expect(settled.error).not.toBeInstanceOf(GitHubProviderPostEffectError);
    expect(settled.error).toBeInstanceOf(Error);
    expect((settled.error as Error).message).toBe(
      "GitHub create issue outcome requires reconciliation",
    );
  });

  test("retains request identity when the first successful-response body read never completes", async () => {
    let readerCancelled = 0;
    let bodyCancelled = 0;
    const never = new Promise<ReadableStreamReadResult<Uint8Array>>(
      () => undefined,
    );
    const response = {
      ok: true,
      status: 201,
      headers: new Headers({
        "content-type": "application/json",
        "x-github-request-id": "REQ-BODY-DEADLINE",
      }),
      body: {
        getReader() {
          return {
            read() {
              return never;
            },
            cancel() {
              readerCancelled += 1;
              return new Promise<void>(() => undefined);
            },
            releaseLock() {},
          };
        },
        cancel() {
          bodyCancelled += 1;
          return new Promise<void>(() => undefined);
        },
      },
    } as unknown as Response;
    const adapter = adapterWithDeadline(
      (async () => response) as typeof fetch,
    );

    const settled = await settleWithin(createIssue(adapter), watchdogMs);

    expect(settled.kind).toBe("error");
    if (settled.kind !== "error") return;
    expect(settled.error).toBeInstanceOf(GitHubProviderPostEffectError);
    expect(settled.error).toMatchObject({
      providerRequestId: "REQ-BODY-DEADLINE",
      message:
        "GitHub provider effect requires reconciliation after verification failed",
    });
    expect(readerCancelled + bodyCancelled).toBeGreaterThan(0);
  });

  test("the timeout itself does not await a never-settling cancellation promise", async () => {
    let cancellationStarted = false;
    const response = {
      ok: true,
      status: 201,
      headers: new Headers({
        "content-type": "application/json",
        "x-github-request-id": "REQ-CANCEL-DEADLINE",
      }),
      body: {
        getReader() {
          return {
            read() {
              return new Promise<ReadableStreamReadResult<Uint8Array>>(
                () => undefined,
              );
            },
            cancel() {
              cancellationStarted = true;
              return new Promise<void>(() => undefined);
            },
            releaseLock() {},
          };
        },
        cancel() {
          cancellationStarted = true;
          return new Promise<void>(() => undefined);
        },
      },
    } as unknown as Response;
    const adapter = adapterWithDeadline(
      (async () => response) as typeof fetch,
    );

    const settled = await settleWithin(createIssue(adapter), watchdogMs);

    expect(settled.kind).toBe("error");
    expect(cancellationStarted).toBe(true);
  });
});

function adapterWithDeadline(fetcher: typeof fetch): GitHubRestIssueWriteAdapter {
  type DeadlineOptions = ConstructorParameters<
    typeof GitHubRestIssueWriteAdapter
  >[0] & {
    providerResponseDeadlineMs: number;
  };
  const options: DeadlineOptions = {
    tokenProvider: {
      async getInstallationToken() {
        return {
          token: "installation-token",
          expiresAt: "2026-08-03T11:00:00.000Z",
        };
      },
    },
    fetch: fetcher,
    providerResponseDeadlineMs: deadlineMs,
  };
  return new GitHubRestIssueWriteAdapter(options);
}

function createIssue(adapter: GitHubRestIssueWriteAdapter) {
  return adapter.createIssue({
    repositoryFullName,
    title: "Bound provider response lifetime",
    body: "Body",
    labels: [],
    assignees: [],
    idempotencyKey: "provider-response-deadline",
  });
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
      promise.then<Settled>(
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
