import { describe, expect, test } from "bun:test";
import {
  GitHubProviderResponseReadError,
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

describe("GitHub provider response request snapshot abort", () => {
  test("keeps caller abort authoritative when a later init getter throws", async () => {
    let fetchCalls = 0;
    let addCalls = 0;
    let removeCalls = 0;
    let headersReads = 0;
    let bodyReads = 0;
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

    const init = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(init, "signal", {
      value: signal,
      enumerable: true,
    });
    Object.defineProperty(init, "method", {
      value: "GET",
      enumerable: true,
    });
    Object.defineProperty(init, "headers", {
      enumerable: true,
      get() {
        headersReads += 1;
        const active = installed;
        const event = new Event("abort");
        if (typeof active === "function") {
          active.call(signal, event);
        } else {
          active?.handleEvent(event);
        }
        return undefined;
      },
    });
    Object.defineProperty(init, "body", {
      enumerable: true,
      get() {
        bodyReads += 1;
        throw new Error("hostile body getter after caller abort");
      },
    });

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
        init as unknown as RequestInit,
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
    expect(headersReads).toBe(1);
    expect(bodyReads).toBe(1);
    expect(installed).toBeNull();
  });
});
