import { describe, expect, test } from "bun:test";
import {
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

describe("GitHub provider response request-inspection cleanup", () => {
  test("removes the external abort listener when route-limit inspection throws", async () => {
    const inspectionFailure = new Error("hostile method getter");
    let fetchCalls = 0;
    let addCalls = 0;
    let removeCalls = 0;
    let activeListener: EventListenerOrEventListenerObject | null = null;

    const signal = {
      aborted: false,
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        expect(type).toBe("abort");
        addCalls += 1;
        activeListener = listener;
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        expect(type).toBe("abort");
        expect(listener).toBe(activeListener);
        removeCalls += 1;
        activeListener = null;
      },
    } as unknown as AbortSignal;

    const init = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(init, "signal", {
      value: signal,
      enumerable: true,
    });
    Object.defineProperty(init, "method", {
      enumerable: true,
      get() {
        throw inspectionFailure;
      },
    });

    const wrapped = withGitHubProviderResponseDeadline(
      (async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      }) as typeof fetch,
      60_000,
    );

    await expect(wrapped(
      "https://api.github.com/repos/example/project/issues",
      init as unknown as RequestInit,
    )).rejects.toBe(inspectionFailure);

    expect(fetchCalls).toBe(0);
    expect(addCalls).toBe(1);
    expect(removeCalls).toBe(1);
    expect(activeListener).toBeNull();
  });
});
