import { describe, expect, test } from "bun:test";
import {
  discardGitHubProviderResponse,
} from "../src/github-provider-bounded-response.ts";

describe("GitHub provider bounded-response cancellation inspection", () => {
  test("does not inspect a foreign cancellation result for thenability", () => {
    let cancelCalls = 0;
    let hasThenCalls = 0;
    let getThenCalls = 0;
    const cancellationResult = new Proxy(Object.create(null) as object, {
      has(_target, key) {
        if (key === "then") hasThenCalls += 1;
        throw new Error("foreign cancellation membership trap must not execute");
      },
      get(_target, key) {
        if (key === "then") getThenCalls += 1;
        throw new Error("foreign cancellation getter must not execute");
      },
    });
    const response = {
      body: {
        cancel() {
          cancelCalls += 1;
          return cancellationResult;
        },
      },
    } as unknown as Response;

    expect(() => discardGitHubProviderResponse(response)).not.toThrow();
    expect(cancelCalls).toBe(1);
    expect(hasThenCalls).toBe(0);
    expect(getThenCalls).toBe(0);
  });
});
