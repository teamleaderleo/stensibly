import { describe, expect, test } from "bun:test";
import { GitHubProviderPostEffectError } from "../src/github-provider-post-effect-error.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";
import {
  GitHubRestIssueWriteAdapter,
} from "../src/github-rest-issue-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;
const deadlineMs = 5;
const watchdogMs = 250;

describe("GitHub issue-write response acquisition deadline", () => {
  test("settles unattributed create ambiguity when fetch never returns response headers", async () => {
    let fetchCalls = 0;
    const adapter = writeAdapterWithDeadline(
      (async () => {
        fetchCalls += 1;
        return await new Promise<Response>(() => undefined);
      }) as typeof fetch,
    );

    const settled = await settleWithin(createIssue(adapter), watchdogMs);

    expectUnattributedAmbiguity(
      settled,
      "GitHub create issue outcome requires reconciliation",
    );
    expect(fetchCalls).toBe(1);
  });

  test("settles unattributed set-write ambiguity when fetch never returns response headers", async () => {
    let fetchCalls = 0;
    const adapter = setWriteAdapterWithDeadline(
      (async () => {
        fetchCalls += 1;
        return await new Promise<Response>(() => undefined);
      }) as typeof fetch,
    );

    const settled = await settleWithin(addLabels(adapter), watchdogMs);

    expectUnattributedAmbiguity(
      settled,
      "GitHub add issue labels outcome requires reconciliation",
    );
    expect(fetchCalls).toBe(1);
  });

  test("does not rely on create fetch honoring AbortSignal", async () => {
    let observedSignal: AbortSignal | null = null;
    const adapter = writeAdapterWithDeadline(
      ((_: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
    );

    const settled = await settleWithin(createIssue(adapter), watchdogMs);

    expectUnattributedAmbiguity(
      settled,
      "GitHub create issue outcome requires reconciliation",
    );
    expect(observedSignal).not.toBeNull();
  });

  test("does not rely on set-write fetch honoring AbortSignal", async () => {
    let observedSignal: AbortSignal | null = null;
    const adapter = setWriteAdapterWithDeadline(
      ((_: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
    );

    const settled = await settleWithin(addLabels(adapter), watchdogMs);

    expectUnattributedAmbiguity(
      settled,
      "GitHub add issue labels outcome requires reconciliation",
    );
    expect(observedSignal).not.toBeNull();
  });
});

function writeAdapterWithDeadline(fetcher: typeof fetch): GitHubRestIssueWriteAdapter {
  type DeadlineOptions = ConstructorParameters<
    typeof GitHubRestIssueWriteAdapter
  >[0] & {
    providerResponseDeadlineMs: number;
  };
  const options: DeadlineOptions = {
    tokenProvider: tokenProvider(),
    fetch: fetcher,
    providerResponseDeadlineMs: deadlineMs,
  };
  return new GitHubRestIssueWriteAdapter(options);
}

function setWriteAdapterWithDeadline(
  fetcher: typeof fetch,
): GitHubRestIssueSetWriteAdapter {
  type DeadlineOptions = ConstructorParameters<
    typeof GitHubRestIssueSetWriteAdapter
  >[0] & {
    providerResponseDeadlineMs: number;
  };
  const options: DeadlineOptions = {
    tokenProvider: tokenProvider(),
    fetch: fetcher,
    providerResponseDeadlineMs: deadlineMs,
  };
  return new GitHubRestIssueSetWriteAdapter(options);
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

function addLabels(adapter: GitHubRestIssueSetWriteAdapter) {
  return adapter.addIssueLabels({
    repositoryFullName,
    issueNumber,
    labels: ["area:github"],
    idempotencyKey: "set-provider-response-acquisition-deadline",
  });
}

function expectUnattributedAmbiguity(
  settled: Settled,
  expectedMessage: string,
): void {
  expect(settled.kind).toBe("error");
  if (settled.kind !== "error") {
    throw new Error("Provider response acquisition did not settle before watchdog");
  }
  expect(settled.error).not.toBeInstanceOf(GitHubProviderPostEffectError);
  expect(settled.error).toBeInstanceOf(Error);
  expect((settled.error as Error).message).toBe(expectedMessage);
}

function tokenProvider() {
  return {
    async getInstallationToken() {
      return {
        token: "installation-token",
        expiresAt: "2026-08-03T11:00:00.000Z",
      };
    },
  };
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
