import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

const providerDeadlineMs = 250;
const witnessWindowMs = 75;
const fixedReadError =
  "GitHub provider response could not be read within its bounds";

describe("GitHub provider native Request signal precedence", () => {
  test("settles from Request.signal when RequestInit omits signal", async () => {
    const caller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const wrapped = neverSettlingWrapper((signal) => {
      providerSignal = signal;
    });
    const request = new Request(
      "https://api.github.com/repos/example/project/issues",
      { signal: caller.signal },
    );

    const pending = wrapped(request);
    caller.abort();
    const outcome = await settleWithin(pending, witnessWindowMs);

    const observedSignal = providerSignal as AbortSignal | undefined;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") {
      throw new Error("native Request abort did not settle promptly");
    }
    expect(outcome.error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((outcome.error as Error).message).toBe(fixedReadError);
  });

  test("lets explicit RequestInit.signal override Request.signal", async () => {
    const requestCaller = new AbortController();
    const overrideCaller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const wrapped = neverSettlingWrapper((signal) => {
      providerSignal = signal;
    });
    const request = new Request(
      "https://api.github.com/repos/example/project/issues",
      { signal: requestCaller.signal },
    );

    const pending = wrapped(request, { signal: overrideCaller.signal });
    requestCaller.abort();
    const beforeOverride = await settleWithin(pending, witnessWindowMs);

    const observedBeforeOverride = providerSignal as AbortSignal | undefined;
    expect(beforeOverride.kind).toBe("watchdog");
    expect(observedBeforeOverride).toBeInstanceOf(AbortSignal);
    expect(observedBeforeOverride?.aborted).toBe(false);

    overrideCaller.abort();
    const afterOverride = await settleWithin(pending, witnessWindowMs);

    const observedAfterOverride = providerSignal as AbortSignal | undefined;
    expect(observedAfterOverride?.aborted).toBe(true);
    expect(afterOverride.kind).toBe("error");
    if (afterOverride.kind !== "error") {
      throw new Error("RequestInit abort did not settle promptly");
    }
    expect(afterOverride.error).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((afterOverride.error as Error).message).toBe(fixedReadError);
  });
});

function neverSettlingWrapper(
  observeSignal: (signal: AbortSignal | undefined) => void,
): typeof fetch {
  return withGitHubProviderResponseDeadline(
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observeSignal(init?.signal ?? undefined);
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch,
    providerDeadlineMs,
  );
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
