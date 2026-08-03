import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueWriteAdapter,
} from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const deadlineMs = 5;
const watchdogMs = 250;

describe("GitHub issue-write response acquisition deadline", () => {
  test("settles unattributed ambiguity when fetch never returns response headers", async () => {
    let fetchCalls = 0;
    const adapter = adapterWithDeadline(
      (async () => {
        fetchCalls += 1;
        return await new Promise<Response>(() => undefined);
      }) as typeof fetch,
    );

    const settled = await settleWithin(createIssue(adapter), watchdogMs);

    expect(settled.kind).toBe("error");
    if (settled.kind !== "error") return;
    expect(settled.error).not.toBeInstanceOf(GitHubProviderPostEffectError);
    expect(settled.error).toBeInstanceOf(Error);
    expect((settled.error as Error).message).toBe(
      "GitHub create issue outcome requires reconciliation",
    );
    expect(fetchCalls).toBe(1);
  });

  test("does not rely on an injected fetch implementation honoring AbortSignal", async () => {
    let observedSignal: AbortSignal | null = null;
    const adapter = adapterWithDeadline(
      ((_: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
    );

    const settled = await settleWithin(createIssue(adapter), watchdogMs);

    expect(settled.kind).toBe("error");
    expect(observedSignal).not.toBeNull();
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
    title: "Bound provider response acquisition",
    body: "Body",
    labels: [],
    assignees: [],
    idempotencyKey: "provider-response-acquisition-deadline",
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
