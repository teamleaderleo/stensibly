import { describe, expect, test } from "bun:test";
import {
  withGitHubProviderResponseDeadline,
} from "../src/github-provider-bounded-response.ts";

describe("GitHub provider external abort cleanup", () => {
  test("removes the caller abort listener immediately after response headers", async () => {
    const caller = controlledAbortSignal();
    const wrapped = withGitHubProviderResponseDeadline(
      (async () => Response.json({ ok: true })) as unknown as typeof fetch,
      1_000,
    );

    await wrapped("https://api.github.com/repos/example/project/issues", {
      signal: caller.signal,
    });
    expect(caller.listenerCount()).toBe(1);

    caller.abort();
    await Promise.resolve();

    expect(caller.removeCalls()).toBe(1);
    expect(caller.listenerCount()).toBe(0);
  });
});

function controlledAbortSignal() {
  let aborted = false;
  let listener: EventListenerOrEventListenerObject | null = null;
  let removals = 0;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(
      type: string,
      next: EventListenerOrEventListenerObject,
    ) {
      if (type === "abort") listener = next;
    },
    removeEventListener(
      type: string,
      next: EventListenerOrEventListenerObject,
    ) {
      if (type === "abort" && listener === next) {
        listener = null;
        removals += 1;
      }
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort() {
      aborted = true;
      const active = listener;
      if (typeof active === "function") {
        active.call(signal, new Event("abort"));
      } else {
        active?.handleEvent(new Event("abort"));
      }
    },
    listenerCount: () => listener === null ? 0 : 1,
    removeCalls: () => removals,
  };
}
