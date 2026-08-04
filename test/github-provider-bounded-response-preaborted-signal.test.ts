import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const providerDeadlineMs = 250;
const witnessWindowMs = 75;
const fixedReadError =
  "GitHub provider response could not be read within its bounds";
const url = "https://api.github.com/repos/example/project/issues";

describe("GitHub provider pre-aborted Request signal admission", () => {
  test("lets explicit null override an already-aborted Request signal", async () => {
    const requestCaller = new AbortController();
    requestCaller.abort();
    let providerCalls = 0;
    let providerSignal: AbortSignal | undefined;
    const wrapped = withGitHubProviderResponseDeadline(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerCalls += 1;
        providerSignal = init?.signal ?? undefined;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      providerDeadlineMs,
    );
    const request = new Request(url, { signal: requestCaller.signal });

    const response = await wrapped(request, { signal: null });
    await expect(response.text()).resolves.toBe("");

    expect(providerCalls).toBe(1);
    const observedSignal = providerSignal as AbortSignal | undefined;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
  });

  test("does not invoke the provider for an already-aborted effective Request signal", async () => {
    const caller = new AbortController();
    caller.abort();
    let providerCalls = 0;
    const wrapped = withGitHubProviderResponseDeadline(
      (async () => {
        providerCalls += 1;
        return await new Promise<Response>(() => {});
      }) as unknown as typeof fetch,
      providerDeadlineMs,
    );
    const request = new Request(url, { signal: caller.signal });

    const outcome = await settleWithin(wrapped(request), witnessWindowMs);

    expect(providerCalls).toBe(0);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") {
      throw new Error("pre-aborted Request did not settle promptly");
    }
    expect(outcome.error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((outcome.error as Error).message).toBe(fixedReadError);
  });
});

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
