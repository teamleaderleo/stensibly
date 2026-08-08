import { describe, expect, test } from "bun:test";
import { receiverSafeFetch } from "../src/fetch-implementation.ts";

describe("receiverSafeFetch", () => {
  test("does not rebind an injected fetch when stored on another object", async () => {
    const calls: string[] = [];
    const injected = (function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      calls.push(String(input));
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;
    const holder = { fetch: receiverSafeFetch(injected) };

    const response = await holder.fetch("https://receiver.test/receiver-ok");

    expect(await response.text()).toBe("ok");
    expect(calls).toEqual(["https://receiver.test/receiver-ok"]);
  });
});
