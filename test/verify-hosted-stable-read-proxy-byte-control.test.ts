import { describe, expect, test } from "bun:test";
import { verifyHostedStableRead } from "../src/verify-hosted-stable-read.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

describe("hosted MCP stable-read Proxy byte admission", () => {
  test("rejects a Proxy-wrapped typed array without invoking getPrototypeOf", async () => {
    let prototypeReads = 0;
    const chunk = new Proxy(new Uint8Array([0x7b]), {
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error("provider prototype trap must not execute");
      },
    });

    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }), {
        status: 200,
        headers: { "content-length": "1" },
      });

    const result = await verifyHostedStableRead(options, fetchImpl);

    expect(prototypeReads).toBe(0);
    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace returned an invalid byte stream",
    });
  });
});
