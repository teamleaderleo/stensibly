import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const witnessWindowMs = 100;
const providerDeadlineMs = 250;

describe("GitHub provider external abort settlement", () => {
  test("rejects promptly when caller aborts even if fetch ignores its signal", async () => {
    const caller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let fetchCalls = 0;
    const wrapped = withGitHubProviderResponseDeadline(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        providerSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => {});
      }) as unknown as typeof fetch,
      providerDeadlineMs,
    );

    const pending = wrapped(
      "https://api.github.com/repos/example/project/issues",
      { signal: caller.signal },
    );
    caller.abort();

    const outcome = await Promise.race([
      pending.then(
        (value) => ({ kind: "fulfilled" as const, value, error: null }),
        (error: unknown) => ({ kind: "rejected" as const, value: null, error }),
      ),
      new Promise<{ kind: "timeout"; value: null; error: null }>((resolve) => {
        setTimeout(
          () => resolve({ kind: "timeout", value: null, error: null }),
          witnessWindowMs,
        );
      }),
    ]);

    const observedSignal = providerSignal as AbortSignal | undefined;
    expect(fetchCalls).toBe(1);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") {
      throw new Error("caller abort did not settle the provider wrapper promptly");
    }
    expect(outcome.error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((outcome.error as Error).message).toBe(
      "GitHub provider response could not be read within its bounds",
    );
  });
});
