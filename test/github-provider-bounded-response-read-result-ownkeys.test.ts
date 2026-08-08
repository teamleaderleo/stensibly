import { describe, expect, test } from "bun:test";
import {
  readBoundedGitHubProviderResponseText,
} from "../src/github-provider-bounded-response.ts";

describe("bounded GitHub provider read-result key admission", () => {
  test("reads exact data descriptors without invoking caller-owned ownKeys", async () => {
    let ownKeysCalls = 0;
    let readCount = 0;
    const results = [
      proxiedReadResult({
        done: false,
        value: new TextEncoder().encode("ok"),
      }),
      proxiedReadResult({ done: true }),
    ];
    const reader = {
      async read() {
        const result = results[readCount];
        readCount += 1;
        if (!result) throw new Error("unexpected extra read");
        return result;
      },
      cancel() {
        return Promise.resolve();
      },
      releaseLock() {},
    };
    const response = {
      headers: new Headers(),
      body: {
        getReader() {
          return reader;
        },
        cancel() {
          return Promise.resolve();
        },
      },
    } as unknown as Response;

    const text = await readBoundedGitHubProviderResponseText(
      response,
      16,
      1_000,
    );

    expect(text).toBe("ok");
    expect(readCount).toBe(2);
    expect(ownKeysCalls).toBe(0);

    function proxiedReadResult(
      value: { done: boolean; value?: Uint8Array },
    ): ReadableStreamReadResult<Uint8Array> {
      return new Proxy(value, {
        ownKeys() {
          ownKeysCalls += 1;
          throw new Error("read-result ownKeys must remain unused");
        },
      }) as ReadableStreamReadResult<Uint8Array>;
    }
  });
});
