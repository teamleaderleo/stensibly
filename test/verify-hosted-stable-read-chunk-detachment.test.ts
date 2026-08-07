import { describe, expect, test } from "bun:test";
import { verifyHostedStableRead } from "../src/verify-hosted-stable-read.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

describe("hosted MCP stable-read chunk detachment", () => {
  test("copies admitted response bytes without consulting typed-array constructor or species", async () => {
    let constructorReads = 0;
    const chunk = new Uint8Array([0x7b]);
    Object.defineProperty(chunk, "constructor", {
      configurable: true,
      get() {
        constructorReads += 1;
        throw new Error("provider chunk constructor must not execute");
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
        headers: {
          "content-length": "1",
          "x-request-id": "stable-read-chunk-detachment",
        },
      });

    const result = await verifyHostedStableRead(options, fetchImpl);

    expect(constructorReads).toBe(0);
    expect(result).toEqual({
      name: "remote MCP stable read",
      ok: false,
      detail: "MCP survey_workspace returned invalid JSON",
    });
  });
});
