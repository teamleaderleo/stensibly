import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

describe("GitHub provider response signal setup cleanup", () => {
  test("removes a partially installed listener when signal subscription throws", async () => {
    let fetchCalls = 0;
    let addCalls = 0;
    let removeCalls = 0;
    let installed: EventListenerOrEventListenerObject | null = null;

    const signal = {
      aborted: false,
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        expect(type).toBe("abort");
        addCalls += 1;
        installed = listener;
        throw new Error("hostile signal subscription");
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        expect(type).toBe("abort");
        expect(listener).toBe(
          installed as EventListenerOrEventListenerObject,
        );
        removeCalls += 1;
        installed = null;
      },
    } as unknown as AbortSignal;

    const wrapped = withGitHubProviderResponseDeadline(
      (async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      }) as unknown as typeof fetch,
      120_000,
    );

    let observed: unknown;
    try {
      await wrapped(
        "https://api.github.com/repos/example/project/issues",
        { signal },
      );
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(GitHubProviderResponseReadError);
    expect((observed as Error).message).toBe(
      "GitHub provider response could not be read within its bounds",
    );
    expect(fetchCalls).toBe(0);
    expect(addCalls).toBe(1);
    expect(removeCalls).toBe(1);
    expect(installed).toBeNull();
  });

  test("converts a hostile aborted getter into the fixed bounded error", async () => {
    let fetchCalls = 0;
    const signal = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(signal, "aborted", {
      enumerable: true,
      get() {
        throw new Error("hostile aborted getter");
      },
    });

    const wrapped = withGitHubProviderResponseDeadline(
      (async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      }) as unknown as typeof fetch,
      120_000,
    );

    await expect(wrapped(
      "https://api.github.com/repos/example/project/issues",
      { signal: signal as unknown as AbortSignal },
    )).rejects.toBeInstanceOf(GitHubProviderResponseReadError);
    expect(fetchCalls).toBe(0);
  });
});
