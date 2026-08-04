import { describe, expect, test } from "bun:test";
import {
  discardGitHubProviderResponse,
  GitHubProviderResponseReadError,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const url = "https://api.github.com/repos/example/project/issues";
const deadlineMs = 250;
const fixedReadError =
  "GitHub provider response could not be read within its bounds";

describe("GitHub provider pre-aborted dispatch admission", () => {
  test("does not invoke fetch for a pre-aborted RequestInit signal", async () => {
    const caller = new AbortController();
    caller.abort();
    const observed = providerSpy();
    const wrapped = withGitHubProviderResponseDeadline(
      observed.fetch,
      deadlineMs,
    );

    await expect(wrapped(url, { signal: caller.signal })).rejects.toThrow(
      fixedReadError,
    );
    expect(observed.calls()).toBe(0);
  });

  test("does not invoke fetch for a pre-aborted native Request signal", async () => {
    const caller = new AbortController();
    caller.abort();
    const request = new Request(url, { signal: caller.signal });
    const observed = providerSpy();
    const wrapped = withGitHubProviderResponseDeadline(
      observed.fetch,
      deadlineMs,
    );

    let thrown: unknown;
    try {
      await wrapped(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((thrown as Error).message).toBe(fixedReadError);
    expect(observed.calls()).toBe(0);
  });

  test("lets explicit null override a pre-aborted Request signal", async () => {
    const requestCaller = new AbortController();
    requestCaller.abort();
    const request = new Request(url, { signal: requestCaller.signal });
    const observed = providerSpy();
    const wrapped = withGitHubProviderResponseDeadline(
      observed.fetch,
      deadlineMs,
    );

    const response = await wrapped(request, { signal: null });

    expect(observed.calls()).toBe(1);
    expect(observed.providerSignal()).toBeInstanceOf(AbortSignal);
    expect(observed.providerSignal()?.aborted).toBe(false);
    discardGitHubProviderResponse(response);
  });
});

function providerSpy(): {
  fetch: typeof fetch;
  calls: () => number;
  providerSignal: () => AbortSignal | undefined;
} {
  let callCount = 0;
  let signal: AbortSignal | undefined;
  const fetchImplementation = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    callCount += 1;
    signal = init?.signal ?? undefined;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImplementation,
    calls: () => callCount,
    providerSignal: () => signal,
  };
}
